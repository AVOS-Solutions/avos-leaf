using System.Security.Cryptography;

namespace Avos.Leaf.Infrastructure.Security;

/// <summary>Every document gets its own random 256-bit DEK; the PDF bytes are AES-256-GCM-encrypted
/// under that DEK (not the server master key directly), and the DEK itself is encrypted with the
/// master key (via the injected IEncryptionService, the same one that protects LeafAccount's cached
/// PII) before being stored in LeafDocument.EncryptedDek. Compromising one document's DEK never
/// exposes any other document; compromising the master key alone (without the database) exposes
/// nothing either. Same scheme as avos-vault's VaultFileEncryptionService.
///
/// Encrypt/Decrypt load the whole plaintext into memory rather than truly streaming — correct and
/// simple for the PDF-sized files this targets. Chunked streaming for very large files is a real
/// limitation, deliberately deferred rather than adding chunk-boundary complexity nothing here needs
/// yet.</summary>
public sealed class LeafFileEncryptionService(IEncryptionService masterKeyEncryption) : IFileEncryptionService
{
    private const int NonceSize = 12;
    private const int TagSize = 16;
    private const int DekSize = 32;

    public byte[] GenerateDek() => RandomNumberGenerator.GetBytes(DekSize);

    public string WrapDek(byte[] dek) => masterKeyEncryption.Encrypt(Convert.ToBase64String(dek));

    public byte[] UnwrapDek(string wrappedDek) => Convert.FromBase64String(masterKeyEncryption.Decrypt(wrappedDek));

    public byte[] Encrypt(byte[] plaintext, byte[] dek)
    {
        var nonce = RandomNumberGenerator.GetBytes(NonceSize);
        var ciphertext = new byte[plaintext.Length];
        var tag = new byte[TagSize];

        using (var aesGcm = new AesGcm(dek, TagSize))
        {
            aesGcm.Encrypt(nonce, plaintext, ciphertext, tag);
        }

        var result = new byte[NonceSize + TagSize + ciphertext.Length];
        Buffer.BlockCopy(nonce, 0, result, 0, NonceSize);
        Buffer.BlockCopy(tag, 0, result, NonceSize, TagSize);
        Buffer.BlockCopy(ciphertext, 0, result, NonceSize + TagSize, ciphertext.Length);
        return result;
    }

    public byte[] Decrypt(byte[] ciphertext, byte[] dek)
    {
        if (ciphertext.Length < NonceSize + TagSize)
        {
            throw new CryptographicException("Ciphertext is too short to contain a valid nonce and tag.");
        }

        var nonce = ciphertext.AsSpan(0, NonceSize);
        var tag = ciphertext.AsSpan(NonceSize, TagSize);
        var encrypted = ciphertext.AsSpan(NonceSize + TagSize);
        var plaintext = new byte[encrypted.Length];

        using (var aesGcm = new AesGcm(dek, TagSize))
        {
            aesGcm.Decrypt(nonce, encrypted, tag, plaintext);
        }

        return plaintext;
    }
}
