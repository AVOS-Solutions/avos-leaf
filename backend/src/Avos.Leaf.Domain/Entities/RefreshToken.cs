namespace Avos.Leaf.Domain.Entities;

/// <summary>avos-leaf's own local session refresh token — separate from any refresh token
/// avos-licensing issued during the login/signup round-trip (that one is discarded after use; see
/// IdentityLicensingClient). UserId here means LeafAccount.Id, not LicenseUserId.</summary>
public class RefreshToken
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid LeafAccountId { get; set; }
    public required string TokenHash { get; set; }
    public DateTimeOffset ExpiresAt { get; set; }
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset? RevokedAt { get; set; }
}
