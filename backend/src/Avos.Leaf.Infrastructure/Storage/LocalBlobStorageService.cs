using Microsoft.Extensions.Configuration;

namespace Avos.Leaf.Infrastructure.Storage;

/// <summary>Phase-1 blob store: encrypted PDF bytes as plain files under a configured directory
/// (Leaf:StoragePath), one file per key. No sharding — this app's expected per-account PDF volume
/// doesn't need it yet, and a flat directory keeps swapping to an S3-compatible store later a
/// mechanical change (same key scheme carries over unchanged).</summary>
public class LocalBlobStorageService(string rootPath) : IBlobStorageService
{
    public LocalBlobStorageService(IConfiguration configuration) : this(ResolveRootPath(configuration))
    {
    }

    private static string ResolveRootPath(IConfiguration configuration)
    {
        var path = configuration["Leaf:StoragePath"] ?? throw new InvalidOperationException("Leaf:StoragePath is not configured.");
        Directory.CreateDirectory(path);
        return path;
    }

    public async Task<string> SaveAsync(byte[] content, CancellationToken ct = default)
    {
        var key = Guid.NewGuid().ToString("N");
        await File.WriteAllBytesAsync(Path.Combine(rootPath, key), content, ct);
        return key;
    }

    public async Task<byte[]?> ReadAsync(string key, CancellationToken ct = default)
    {
        var path = Path.Combine(rootPath, key);
        return File.Exists(path) ? await File.ReadAllBytesAsync(path, ct) : null;
    }

    public Task DeleteAsync(string key, CancellationToken ct = default)
    {
        var path = Path.Combine(rootPath, key);
        if (File.Exists(path)) File.Delete(path);
        return Task.CompletedTask;
    }
}
