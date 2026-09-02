namespace Avos.Leaf.Infrastructure.Storage;

/// <summary>Opaque content-addressed-by-key blob storage for encrypted PDF bytes. Deliberately the
/// narrowest possible interface (no listing, no metadata) — LeafDocument in Postgres is the only
/// source of truth for what exists and what it's named; this is purely "give me the bytes for this
/// key back." Swappable for an S3-compatible implementation later (same reasoning as avos-vault's
/// own IObjectStorageService) without touching DocumentsController.</summary>
public interface IBlobStorageService
{
    Task<string> SaveAsync(byte[] content, CancellationToken ct = default);

    Task<byte[]?> ReadAsync(string key, CancellationToken ct = default);

    Task DeleteAsync(string key, CancellationToken ct = default);
}
