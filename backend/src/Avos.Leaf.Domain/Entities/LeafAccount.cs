namespace Avos.Leaf.Domain.Entities;

/// <summary>avos-leaf's local record for a customer — deliberately NOT a password-holding
/// identity of its own. avos-leaf has no local credential store at all: signup/login always
/// round-trips to avos-licensing's real LicenseUser (see IdentityLicensingClient), and this row is
/// just a cache of that identity. LicenseUserId is a plain Guid with no FK — it's a different
/// service's primary key, same "the reference is real but not navigable" idiom avos-licensing
/// itself uses for License.OwnerUserId, and the same shape avos-vault's VaultAccount uses.</summary>
public class LeafAccount : BaseEntity
{
    public required Guid LicenseUserId { get; set; }

    /// <summary>Cached from avos-licensing at signup/login so the rest of this app never needs to
    /// call out just to render a name/email — refreshed opportunistically on login. Encrypted at
    /// rest — see EncryptedString value converter.</summary>
    public required string Email { get; set; }

    public required string DisplayName { get; set; }
}
