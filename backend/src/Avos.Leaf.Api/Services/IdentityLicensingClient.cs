using System.Net.Http.Json;
using System.Text.Json;

namespace Avos.Leaf.Api.Services;

public record RemoteLicenseSummary(Guid ApplicationId, string ApplicationName, string Status);

public record IdentityAuthResult(string AccessToken, DateTimeOffset AccessTokenExpiresAt, string RefreshToken, Guid LicenseUserId, string Email, string FullName, List<string> Roles);

public record IdentityLoginResult(bool RequiresTwoFactor, string? ChallengeToken, DateTimeOffset? ChallengeTokenExpiresAt, IdentityAuthResult? Auth);

public record LicenseLookupResult(bool Found, string? ApplicationName, string? Status);

/// <summary>hasActiveLicense is already scoped to avos-leaf specifically by avos-licensing's
/// POST /api/sso/token (it checks the license against the client_id that redeemed the code) — unlike
/// the password-login path, no separate GetLicensesAsync call is needed here. Roles is the
/// LicenseUser's avos-licensing-side roles (e.g. "Admin" for licensing staff) — AuthController
/// treats an Admin as authorized regardless of HasActiveLicense.</summary>
public record SsoExchangeResult(Guid UserId, string Email, string FullName, bool HasActiveLicense, List<string> Roles);

/// <summary>avos-leaf has no password store of its own — every credential check round-trips to
/// avos-licensing's real LicenseUser store, server-to-server (mirrors avos-vault's own
/// IdentityLicensingClient exactly: silently unusable rather than crashing if unconfigured, since a
/// misconfigured integration must fail as "can't log in," not take the whole app down). See
/// AuthController for how the results here turn into avos-leaf's own local session.</summary>
public class IdentityLicensingClient(IHttpClientFactory httpClientFactory, IConfiguration config, ILogger<IdentityLicensingClient> logger)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private string? BaseUrl => config["Licensing:BaseUrl"];

    /// <summary>Anonymous, no-side-effect lookup — used to reject a license key for the wrong
    /// application (or a nonexistent one) before ever attempting SignUpAsync, which does have a
    /// side effect (claims the license) that can't be cleanly undone.</summary>
    public async Task<LicenseLookupResult> LookupLicenseAsync(string licenseKey, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(BaseUrl)) return new LicenseLookupResult(false, null, null);

        var client = httpClientFactory.CreateClient(nameof(IdentityLicensingClient));
        var response = await client.GetAsync($"{BaseUrl!.TrimEnd('/')}/api/public/licenses/{Uri.EscapeDataString(licenseKey)}", ct);
        if (!response.IsSuccessStatusCode) return new LicenseLookupResult(false, null, null);

        var body = await response.Content.ReadFromJsonAsync<RemoteLicenseLookupDto>(JsonOptions, ct);
        return new LicenseLookupResult(body?.Found ?? false, body?.ApplicationName, body?.Status);
    }

    public async Task<IdentityAuthResult> SignUpAsync(string email, string password, string fullName, string licenseKey, CancellationToken ct = default)
    {
        var baseUrl = RequireBaseUrl();
        var client = httpClientFactory.CreateClient(nameof(IdentityLicensingClient));
        using var response = await client.PostAsJsonAsync($"{baseUrl}/api/auth/signup",
            new { email, password, fullName, licenseKey }, JsonOptions, ct);

        if (!response.IsSuccessStatusCode)
        {
            var error = await response.Content.ReadFromJsonAsync<RemoteErrorDto>(JsonOptions, ct);
            throw new IdentityLicensingException(error?.Message ?? "Sign-up failed.");
        }

        var body = await response.Content.ReadFromJsonAsync<RemoteAuthResponseDto>(JsonOptions, ct)
            ?? throw new IdentityLicensingException("Unexpected response from the licensing service.");
        return ToAuthResult(body);
    }

    public async Task<IdentityLoginResult> LoginAsync(string email, string password, CancellationToken ct = default)
    {
        var baseUrl = RequireBaseUrl();
        var client = httpClientFactory.CreateClient(nameof(IdentityLicensingClient));
        using var response = await client.PostAsJsonAsync($"{baseUrl}/api/auth/login", new { email, password }, JsonOptions, ct);

        if (!response.IsSuccessStatusCode)
        {
            var error = await response.Content.ReadFromJsonAsync<RemoteErrorDto>(JsonOptions, ct);
            throw new IdentityLicensingException(error?.Message ?? "Invalid email or password.");
        }

        // The real endpoint returns one of two differently-shaped 200 bodies (see its own doc
        // comment) — this DTO's fields are the union of both, distinguished by which are present.
        var body = await response.Content.ReadFromJsonAsync<RemoteLoginResponseDto>(JsonOptions, ct)
            ?? throw new IdentityLicensingException("Unexpected response from the licensing service.");

        if (body.RequiresTwoFactor)
        {
            return new IdentityLoginResult(true, body.ChallengeToken, body.ChallengeTokenExpiresAt, null);
        }

        return new IdentityLoginResult(false, null, null,
            new IdentityAuthResult(body.AccessToken, body.AccessTokenExpiresAt, body.RefreshToken, body.User.Id, body.User.Email, body.User.FullName, body.User.Roles));
    }

    public async Task<IdentityAuthResult> VerifyTwoFactorAsync(string challengeToken, string code, CancellationToken ct = default)
    {
        var baseUrl = RequireBaseUrl();
        var client = httpClientFactory.CreateClient(nameof(IdentityLicensingClient));
        using var request = new HttpRequestMessage(HttpMethod.Post, $"{baseUrl}/api/auth/2fa/verify-login")
        {
            Content = JsonContent.Create(new { code }, options: JsonOptions),
        };
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", challengeToken);

        using var response = await client.SendAsync(request, ct);
        if (!response.IsSuccessStatusCode)
        {
            var error = await response.Content.ReadFromJsonAsync<RemoteErrorDto>(JsonOptions, ct);
            throw new IdentityLicensingException(error?.Message ?? "Invalid or expired code.");
        }

        var body = await response.Content.ReadFromJsonAsync<RemoteAuthResponseDto>(JsonOptions, ct)
            ?? throw new IdentityLicensingException("Unexpected response from the licensing service.");
        return ToAuthResult(body);
    }

    /// <summary>Redeems a single-use SSO authorization code (see avos-licensing's SsoController doc
    /// comment for the full flow) server-to-server for the user's identity — the SSO counterpart to
    /// LoginAsync, used when the browser arrives via the redirect-based flow instead of typing a
    /// password directly into avos-leaf.</summary>
    public async Task<SsoExchangeResult> ExchangeSsoCodeAsync(string code, string redirectUri, CancellationToken ct = default)
    {
        var baseUrl = RequireBaseUrl();
        var clientId = config["Licensing:LeafApplicationId"];
        var clientSecret = config["Licensing:SsoClientSecret"];
        if (string.IsNullOrWhiteSpace(clientId) || string.IsNullOrWhiteSpace(clientSecret))
        {
            logger.LogError("Licensing:LeafApplicationId or Licensing:SsoClientSecret is not configured — SSO sign-in is unavailable.");
            throw new IdentityLicensingException("Sign-in is temporarily unavailable.");
        }

        var client = httpClientFactory.CreateClient(nameof(IdentityLicensingClient));
        using var response = await client.PostAsJsonAsync($"{baseUrl}/api/sso/token",
            new { clientId, clientSecret, code, redirectUri }, JsonOptions, ct);

        if (!response.IsSuccessStatusCode)
        {
            throw new IdentityLicensingException("Your sign-in link has expired or was already used. Please try signing in again.");
        }

        var body = await response.Content.ReadFromJsonAsync<RemoteSsoTokenResponseDto>(JsonOptions, ct)
            ?? throw new IdentityLicensingException("Unexpected response from the licensing service.");
        return new SsoExchangeResult(body.UserId, body.Email, body.FullName, body.HasActiveLicense, body.Roles);
    }

    /// <summary>Every license the LicenseUser holds, across all avos-licensing applications — the
    /// caller filters for the one matching avos-leaf's own registered application id.</summary>
    public async Task<List<RemoteLicenseSummary>> GetLicensesAsync(string accessToken, CancellationToken ct = default)
    {
        var baseUrl = RequireBaseUrl();
        var client = httpClientFactory.CreateClient(nameof(IdentityLicensingClient));
        using var request = new HttpRequestMessage(HttpMethod.Get, $"{baseUrl}/api/portal/licenses");
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", accessToken);

        using var response = await client.SendAsync(request, ct);
        if (!response.IsSuccessStatusCode) return [];

        var licenses = await response.Content.ReadFromJsonAsync<List<RemoteLicenseDto>>(JsonOptions, ct);
        return licenses?.Select(l => new RemoteLicenseSummary(l.ApplicationId, l.ApplicationName, l.Status.ToString())).ToList() ?? [];
    }

    private string RequireBaseUrl()
    {
        if (string.IsNullOrWhiteSpace(BaseUrl))
        {
            logger.LogError("Licensing:BaseUrl is not configured — avos-leaf cannot authenticate anyone without it.");
            throw new IdentityLicensingException("Sign-in is temporarily unavailable.");
        }
        return BaseUrl!.TrimEnd('/');
    }

    private static IdentityAuthResult ToAuthResult(RemoteAuthResponseDto body) => new(
        body.AccessToken, body.AccessTokenExpiresAt, body.RefreshToken, body.User.Id, body.User.Email, body.User.FullName, body.User.Roles);

    // Shapes of avos-licensing's own response DTOs — just the fields this client actually uses.
    private record RemoteLoginResponseDto(
        bool RequiresTwoFactor, string? ChallengeToken, DateTimeOffset? ChallengeTokenExpiresAt,
        string AccessToken, DateTimeOffset AccessTokenExpiresAt, string RefreshToken, RemoteUserSummaryDto User);
    private record RemoteAuthResponseDto(string AccessToken, DateTimeOffset AccessTokenExpiresAt, string RefreshToken, RemoteUserSummaryDto User);
    private record RemoteUserSummaryDto(Guid Id, string Email, string FullName, List<string> Roles);
    private record RemoteLicenseDto(Guid ApplicationId, string ApplicationName, string Status);
    private record RemoteLicenseLookupDto(bool Found, string? ApplicationName, string? Status);
    private record RemoteSsoTokenResponseDto(Guid UserId, string Email, string FullName, bool HasActiveLicense, List<string> Roles);
    private record RemoteErrorDto(string Message);
}

/// <summary>Wraps any failure talking to avos-licensing (unreachable, or a real "invalid password"/
/// "license not found" rejection) with a message safe to show the end user as-is.</summary>
public class IdentityLicensingException(string message) : Exception(message);
