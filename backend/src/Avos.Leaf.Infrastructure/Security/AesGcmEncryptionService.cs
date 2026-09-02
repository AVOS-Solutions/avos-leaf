using System.Security.Cryptography;
using System.Text;

namespace Avos.Leaf.Infrastructure.Security;

/// <summary>
/// Field-level AES-256-GCM encryption for sensitive columns (cached customer PII). Ciphertext
/// layout: "agcm1:" + base64([12-byte nonce][16-byte auth tag][ciphertext]). The key never lives in
/// the database — only in server config (user-secrets locally, env var on the VPS). Same shape as
/// avos-vault/avos-erp/avos-licensing's own AesGcmEncryptionService.
///
/// The "agcm1:" prefix is a format marker, not a secret — its only job is to make "is this
/// already encrypted?" answerable without needing the *correct* key. Before this existed, that
/// question was answered by trying to decrypt and treating any failure (including a plain wrong
/// key) as "must be legacy plaintext" — which is how a 2026-08-10 incident happened in avos-
/// licensing (identical code, mirrored here): a second process was pointed at that same live
/// database with a mismatched key, decrypt-probed already-correct ciphertext, treated every
/// failure as plaintext, and double-encrypted 57 rows before crashing. With the marker, a value
/// that has it but still fails to decrypt is unambiguously "encrypted under some other key" — a
/// config problem to fail loudly on, never something to re-encrypt.
///
/// Decrypt still accepts unmarked values (raw base64, no prefix) for backward compatibility with
/// data written before this marker existed — rejecting them outright would break every existing
/// encrypted row the instant this ships. It also means callers that only ever need a single
/// unwrap-and-consume round trip (never persisted as a "maybe legacy plaintext" column) — like
/// NativeContainerCodec's own DEK-wrapping, see its Encode's own comment — can keep storing the
/// unmarked base64 form and this class will still decrypt it correctly, with or without the prefix.
/// </summary>
public sealed class AesGcmEncryptionService : IEncryptionService
{
    public const string FormatPrefix = "agcm1:";
    private const int NonceSize = 12;
    private const int TagSize = 16;
    private readonly byte[] _key;

    public AesGcmEncryptionService(string base64Key)
    {
        _key = Convert.FromBase64String(base64Key);
        if (_key.Length != 32)
        {
            throw new ArgumentException("Encryption key must be 32 bytes (AES-256) once base64-decoded.", nameof(base64Key));
        }
    }

    string IEncryptionService.FormatPrefix => FormatPrefix;

    public bool LooksEncrypted(string value) => value.StartsWith(FormatPrefix, StringComparison.Ordinal);

    public string Encrypt(string plaintext)
    {
        var plaintextBytes = Encoding.UTF8.GetBytes(plaintext);
        var nonce = RandomNumberGenerator.GetBytes(NonceSize);
        var ciphertext = new byte[plaintextBytes.Length];
        var tag = new byte[TagSize];

        using (var aesGcm = new AesGcm(_key, TagSize))
        {
            aesGcm.Encrypt(nonce, plaintextBytes, ciphertext, tag);
        }

        var result = new byte[NonceSize + TagSize + ciphertext.Length];
        Buffer.BlockCopy(nonce, 0, result, 0, NonceSize);
        Buffer.BlockCopy(tag, 0, result, NonceSize, TagSize);
        Buffer.BlockCopy(ciphertext, 0, result, NonceSize + TagSize, ciphertext.Length);

        return FormatPrefix + Convert.ToBase64String(result);
    }

    public string Decrypt(string ciphertext)
    {
        var payload = ciphertext.StartsWith(FormatPrefix, StringComparison.Ordinal)
            ? ciphertext[FormatPrefix.Length..]
            : ciphertext;

        var data = Convert.FromBase64String(payload);
        if (data.Length < NonceSize + TagSize)
        {
            throw new CryptographicException("Ciphertext is too short to contain a valid nonce and tag.");
        }

        var nonce = data.AsSpan(0, NonceSize);
        var tag = data.AsSpan(NonceSize, TagSize);
        var encrypted = data.AsSpan(NonceSize + TagSize);
        var plaintextBytes = new byte[encrypted.Length];

        using (var aesGcm = new AesGcm(_key, TagSize))
        {
            aesGcm.Decrypt(nonce, encrypted, tag, plaintextBytes);
        }

        return Encoding.UTF8.GetString(plaintextBytes);
    }
}
