namespace Avos.Leaf.Api.Contracts;

public record LoginRequest(string Email, string Password);

public record RefreshRequest(string RefreshToken);

public record AuthResponse(string AccessToken, DateTimeOffset AccessTokenExpiresAt, string RefreshToken, AccountSummaryDto Account);

public record AccountSummaryDto(Guid Id, string Email, string FullName);

/// <summary>Returned instead of AuthResponse when the underlying avos-licensing account has 2FA
/// enabled — same shape/reasoning as avos-licensing's own TwoFactorChallengeResponse, which this
/// wraps verbatim (the challenge token is avos-licensing's, opaque to avos-leaf, just relayed).</summary>
public record TwoFactorChallengeResponse(bool RequiresTwoFactor, string ChallengeToken, DateTimeOffset ChallengeTokenExpiresAt);

public record VerifyTwoFactorLoginRequest(string ChallengeToken, string Code);

public record SignUpRequest(string Email, string Password, string FullName, string LicenseKey);

/// <summary>The redirectUri must be byte-for-byte the same one passed to
/// GET /api/sso/authorize on avos-licensing — it's part of what the code was bound to there.</summary>
public record SsoExchangeRequest(string Code, string RedirectUri);
