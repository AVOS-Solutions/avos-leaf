namespace Avos.Leaf.Infrastructure.Security;

/// <summary>Envelope encryption for PDF bytes — see LeafFileEncryptionService's doc comment for the
/// full scheme. Copied verbatim from avos-vault's own IFileEncryptionService/VaultFileEncryptionService,
/// which already solved exactly this problem.</summary>
public interface IFileEncryptionService
{
    /// <summary>A fresh random 256-bit Data Encryption Key for one document.</summary>
    byte[] GenerateDek();

    /// <summary>Encrypts a DEK with the server master key, for storage in LeafDocument.EncryptedDek.</summary>
    string WrapDek(byte[] dek);

    /// <summary>Reverses WrapDek — the master key is required, so a stolen database alone never
    /// yields a usable DEK.</summary>
    byte[] UnwrapDek(string wrappedDek);

    /// <summary>AES-256-GCM-encrypts a document's plaintext bytes with its own DEK (not the master
    /// key) — this is what actually goes into blob storage.</summary>
    byte[] Encrypt(byte[] plaintext, byte[] dek);

    byte[] Decrypt(byte[] ciphertext, byte[] dek);
}
