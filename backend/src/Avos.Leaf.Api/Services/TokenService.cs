using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using Avos.Leaf.Domain.Entities;
using Microsoft.IdentityModel.Tokens;
using System.IdentityModel.Tokens.Jwt;

namespace Avos.Leaf.Api.Services;

/// <summary>Issues and validates avos-leaf's own local session tokens — entirely separate from
/// whatever token avos-licensing issued during the login/signup round-trip (see
/// IdentityLicensingClient). Sub claim is LeafAccount.Id, not LicenseUserId; a "lic" claim carries
/// LicenseUserId for anything that needs to trace back to the source identity.</summary>
public class TokenService(IConfiguration config)
{
    private static readonly TimeSpan AccessTokenLifetime = TimeSpan.FromMinutes(15);
    public static readonly TimeSpan RefreshTokenLifetime = TimeSpan.FromDays(7);

    public (string Token, DateTimeOffset ExpiresAt) CreateAccessToken(LeafAccount account)
    {
        var key = config["Jwt:Key"] ?? throw new InvalidOperationException("Jwt:Key not configured.");
        var issuer = config["Jwt:Issuer"] ?? throw new InvalidOperationException("Jwt:Issuer not configured.");
        var audience = config["Jwt:Audience"] ?? throw new InvalidOperationException("Jwt:Audience not configured.");

        var expiresAt = DateTimeOffset.UtcNow.Add(AccessTokenLifetime);

        var claims = new List<Claim>
        {
            new(JwtRegisteredClaimNames.Sub, account.Id.ToString()),
            new(JwtRegisteredClaimNames.Email, account.Email),
            new(ClaimTypes.Name, account.DisplayName),
            new("lic", account.LicenseUserId.ToString()),
        };

        var signingKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(key));
        var credentials = new SigningCredentials(signingKey, SecurityAlgorithms.HmacSha256);

        var token = new JwtSecurityToken(
            issuer: issuer,
            audience: audience,
            claims: claims,
            expires: expiresAt.UtcDateTime,
            signingCredentials: credentials);

        return (new JwtSecurityTokenHandler().WriteToken(token), expiresAt);
    }

    public static string GenerateRefreshToken() =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));

    public static string HashRefreshToken(string token) =>
        Convert.ToBase64String(SHA256.HashData(Encoding.UTF8.GetBytes(token)));
}
