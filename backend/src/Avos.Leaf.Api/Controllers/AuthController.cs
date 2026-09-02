using Avos.Leaf.Api.Contracts;
using Avos.Leaf.Api.Services;
using Avos.Leaf.Domain.Entities;
using Avos.Leaf.Infrastructure.Persistence;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Avos.Leaf.Api.Controllers;

/// <summary>avos-leaf has no password store of its own — every action here round-trips to
/// avos-licensing's real LicenseUser store via IdentityLicensingClient, then (once avos-licensing
/// confirms the credentials AND an active avos-leaf license) issues avos-leaf's own local session
/// via TokenService. See LeafAccount's doc comment for why this shape exists — mirrors avos-vault's
/// AuthController exactly.</summary>
[ApiController]
[Route("api/auth")]
public class AuthController(IdentityLicensingClient licensing, TokenService tokenService, LeafDbContext db, IConfiguration config) : ControllerBase
{
    [HttpPost("signup")]
    [AllowAnonymous]
    public async Task<ActionResult<AuthResponse>> SignUp(SignUpRequest request)
    {
        var lookup = await licensing.LookupLicenseAsync(request.LicenseKey);
        if (!lookup.Found)
        {
            return BadRequest(new { message = "License key not found." });
        }
        if (!IsLeafApplication(lookup.ApplicationName))
        {
            return BadRequest(new { message = "This license key isn't for avos-leaf." });
        }

        IdentityAuthResult identity;
        try
        {
            identity = await licensing.SignUpAsync(request.Email, request.Password, request.FullName, request.LicenseKey);
        }
        catch (IdentityLicensingException ex)
        {
            return BadRequest(new { message = ex.Message });
        }

        var account = new LeafAccount
        {
            LicenseUserId = identity.LicenseUserId,
            Email = identity.Email,
            DisplayName = identity.FullName,
        };
        db.LeafAccounts.Add(account);
        await db.SaveChangesAsync();

        return Ok(await IssueLocalSessionAsync(account));
    }

    [HttpPost("login")]
    [AllowAnonymous]
    public async Task<IActionResult> Login(LoginRequest request)
    {
        IdentityLoginResult result;
        try
        {
            result = await licensing.LoginAsync(request.Email, request.Password);
        }
        catch (IdentityLicensingException ex)
        {
            return Unauthorized(new { message = ex.Message });
        }

        if (result.RequiresTwoFactor)
        {
            return Ok(new TwoFactorChallengeResponse(true, result.ChallengeToken!, result.ChallengeTokenExpiresAt!.Value));
        }

        return await CompleteLoginAsync(result.Auth!);
    }

    [HttpPost("2fa/verify-login")]
    [AllowAnonymous]
    public async Task<IActionResult> VerifyTwoFactorLogin(VerifyTwoFactorLoginRequest request)
    {
        IdentityAuthResult identity;
        try
        {
            identity = await licensing.VerifyTwoFactorAsync(request.ChallengeToken, request.Code);
        }
        catch (IdentityLicensingException ex)
        {
            return Unauthorized(new { message = ex.Message });
        }

        return await CompleteLoginAsync(identity);
    }

    /// <summary>Server-to-server: the frontend's own /api/auth/sso/callback route calls this after
    /// the browser lands back from avos-licensing's GET /api/sso/authorize with a code. Unlike
    /// password login, avos-licensing has already confirmed the license (hasActiveLicense is scoped
    /// to avos-leaf by ExchangeSsoCodeAsync's own request) — no second GetLicensesAsync round trip.</summary>
    [HttpPost("sso/exchange")]
    [AllowAnonymous]
    public async Task<IActionResult> SsoExchange(SsoExchangeRequest request)
    {
        SsoExchangeResult result;
        try
        {
            result = await licensing.ExchangeSsoCodeAsync(request.Code, request.RedirectUri);
        }
        catch (IdentityLicensingException ex)
        {
            return Unauthorized(new { message = ex.Message });
        }

        // A licensing-Admin (staff) account reaches every product regardless of holding a customer
        // license — same convention avos-licensing's own frontend already applies to itself.
        var isLicensingAdmin = result.Roles.Contains("Admin", StringComparer.OrdinalIgnoreCase);
        if (!result.HasActiveLicense && !isLicensingAdmin)
        {
            return Unauthorized(new { message = "This account has no active avos-leaf license." });
        }

        var account = await UpsertAccountAsync(result.UserId, result.Email, result.FullName);
        return Ok(await IssueLocalSessionAsync(account));
    }

    [HttpPost("refresh")]
    [AllowAnonymous]
    public async Task<ActionResult<AuthResponse>> Refresh(RefreshRequest request)
    {
        var hash = TokenService.HashRefreshToken(request.RefreshToken);
        var stored = await db.RefreshTokens.FirstOrDefaultAsync(t => t.TokenHash == hash);
        if (stored is null || stored.RevokedAt is not null || stored.ExpiresAt < DateTimeOffset.UtcNow)
        {
            return Unauthorized(new { message = "Refresh token is invalid or expired." });
        }

        var account = await db.LeafAccounts.FindAsync(stored.LeafAccountId);
        if (account is null) return Unauthorized(new { message = "Account no longer exists." });

        stored.RevokedAt = DateTimeOffset.UtcNow;
        return Ok(await IssueLocalSessionAsync(account));
    }

    [HttpPost("logout")]
    [Authorize(Policy = "AnyAccount")]
    public async Task<IActionResult> Logout(RefreshRequest request)
    {
        var hash = TokenService.HashRefreshToken(request.RefreshToken);
        var stored = await db.RefreshTokens.FirstOrDefaultAsync(t => t.TokenHash == hash);
        if (stored is not null)
        {
            stored.RevokedAt = DateTimeOffset.UtcNow;
            await db.SaveChangesAsync();
        }
        return NoContent();
    }

    /// <summary>Shared by password-login and 2FA-verify: check the credentials avos-licensing just
    /// confirmed actually own an Active avos-leaf license, upsert the local LeafAccount (cached
    /// name/email refreshed on every login), and issue a local session.</summary>
    private async Task<IActionResult> CompleteLoginAsync(IdentityAuthResult identity)
    {
        var licenses = await licensing.GetLicensesAsync(identity.AccessToken);
        var leafApplicationId = config["Licensing:LeafApplicationId"];
        var hasActiveLicense = licenses.Any(l =>
            string.Equals(l.ApplicationId.ToString(), leafApplicationId, StringComparison.OrdinalIgnoreCase)
            && l.Status == "Active");
        // A licensing-Admin (staff) account reaches every product regardless of holding a customer
        // license — same convention avos-licensing's own frontend already applies to itself.
        var isLicensingAdmin = identity.Roles.Contains("Admin", StringComparer.OrdinalIgnoreCase);
        if (!hasActiveLicense && !isLicensingAdmin)
        {
            return Unauthorized(new { message = "This account has no active avos-leaf license." });
        }

        var account = await UpsertAccountAsync(identity.LicenseUserId, identity.Email, identity.FullName);
        return Ok(await IssueLocalSessionAsync(account));
    }

    private static bool IsLeafApplication(string? applicationName) =>
        string.Equals(applicationName, "avos-leaf", StringComparison.OrdinalIgnoreCase);

    /// <summary>Shared by password-login, 2FA-verify, and SSO exchange: upsert the local
    /// LeafAccount for a LicenseUserId avos-licensing just vouched for, refreshing the cached
    /// name/email on every sign-in.</summary>
    private async Task<LeafAccount> UpsertAccountAsync(Guid licenseUserId, string email, string fullName)
    {
        var account = await db.LeafAccounts.FirstOrDefaultAsync(a => a.LicenseUserId == licenseUserId);
        if (account is null)
        {
            account = new LeafAccount
            {
                LicenseUserId = licenseUserId,
                Email = email,
                DisplayName = fullName,
            };
            db.LeafAccounts.Add(account);
        }
        else
        {
            account.Email = email;
            account.DisplayName = fullName;
            account.UpdatedAt = DateTimeOffset.UtcNow;
        }
        await db.SaveChangesAsync();
        return account;
    }

    private async Task<AuthResponse> IssueLocalSessionAsync(LeafAccount account)
    {
        var (accessToken, expiresAt) = tokenService.CreateAccessToken(account);
        var refreshToken = TokenService.GenerateRefreshToken();

        db.RefreshTokens.Add(new RefreshToken
        {
            LeafAccountId = account.Id,
            TokenHash = TokenService.HashRefreshToken(refreshToken),
            ExpiresAt = DateTimeOffset.UtcNow.Add(TokenService.RefreshTokenLifetime),
        });
        await db.SaveChangesAsync();

        return new AuthResponse(
            accessToken, expiresAt, refreshToken,
            new AccountSummaryDto(account.Id, account.Email, account.DisplayName));
    }
}
