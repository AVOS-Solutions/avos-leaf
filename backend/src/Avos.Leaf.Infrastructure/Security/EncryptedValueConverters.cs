using Microsoft.EntityFrameworkCore.Storage.ValueConversion;

namespace Avos.Leaf.Infrastructure.Security;

public sealed class EncryptedStringConverter : ValueConverter<string?, string?>
{
    public EncryptedStringConverter(IEncryptionService encryption)
        : base(
            plaintext => plaintext == null ? null : encryption.Encrypt(plaintext),
            stored => stored == null ? null : encryption.Decrypt(stored))
    {
    }
}

public sealed class EncryptedRequiredStringConverter : ValueConverter<string, string>
{
    public EncryptedRequiredStringConverter(IEncryptionService encryption)
        : base(
            plaintext => encryption.Encrypt(plaintext),
            stored => encryption.Decrypt(stored))
    {
    }
}
