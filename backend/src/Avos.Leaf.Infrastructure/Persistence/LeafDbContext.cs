using Avos.Leaf.Domain.Entities;
using Avos.Leaf.Infrastructure.Security;
using Microsoft.EntityFrameworkCore;

namespace Avos.Leaf.Infrastructure.Persistence;

/// <summary>avos-leaf's only DbContext — plain EF Core, not an IdentityDbContext, since this app
/// has no local password store (see LeafAccount's doc comment).</summary>
public class LeafDbContext(DbContextOptions<LeafDbContext> options, IEncryptionService encryption) : DbContext(options)
{
    public DbSet<LeafAccount> LeafAccounts => Set<LeafAccount>();
    public DbSet<RefreshToken> RefreshTokens => Set<RefreshToken>();
    public DbSet<LeafFolder> LeafFolders => Set<LeafFolder>();
    public DbSet<LeafDocument> LeafDocuments => Set<LeafDocument>();

    protected override void OnModelCreating(ModelBuilder builder)
    {
        base.OnModelCreating(builder);

        var encryptedRequiredString = new EncryptedRequiredStringConverter(encryption);

        builder.Entity<LeafAccount>(entity =>
        {
            entity.Property(a => a.Email).HasConversion(encryptedRequiredString).HasMaxLength(500);
            entity.Property(a => a.DisplayName).HasConversion(encryptedRequiredString).HasMaxLength(500);
            entity.HasIndex(a => a.LicenseUserId).IsUnique();
        });

        builder.Entity<RefreshToken>(entity =>
        {
            entity.HasIndex(t => t.TokenHash).IsUnique();
            entity.HasIndex(t => t.LeafAccountId);
        });

        builder.Entity<LeafFolder>(entity =>
        {
            entity.Property(f => f.Name).HasConversion(encryptedRequiredString).HasMaxLength(500);
            entity.HasIndex(f => f.OwnerAccountId);
            entity.HasIndex(f => f.ParentFolderId);
        });

        builder.Entity<LeafDocument>(entity =>
        {
            entity.Property(d => d.Name).HasConversion(encryptedRequiredString).HasMaxLength(500);
            entity.HasIndex(d => d.OwnerAccountId);
            entity.HasIndex(d => d.FolderId);
        });
    }
}
