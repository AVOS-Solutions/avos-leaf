namespace Avos.Leaf.Infrastructure.Security;

public interface IEncryptionService
{
    string Encrypt(string plaintext);
    string Decrypt(string ciphertext);

    /// <summary>
    /// True if the value carries this scheme's format marker, regardless of whether it can
    /// currently be decrypted. Lets a caller distinguish "legacy plaintext, safe to encrypt"
    /// from "already encrypted under some key" — the latter must never be silently re-encrypted
    /// even if it fails to decrypt under the *current* key, since a failed decrypt there means a
    /// key mismatch (or corruption), not plaintext, and re-encrypting would double-encrypt and
    /// destroy the original value.
    /// </summary>
    bool LooksEncrypted(string value);

    /// <summary>The literal marker <see cref="LooksEncrypted"/> checks for — exposed so callers
    /// (a future backfill service) can upgrade an unmarked-but-valid legacy value to the marked
    /// format without needing to know the scheme's internal constant.</summary>
    string FormatPrefix { get; }
}
