using Avos.Leaf.Infrastructure.Security;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;
using Microsoft.Extensions.Configuration;

namespace Avos.Leaf.Infrastructure.Persistence;

/// <summary>Lets `dotnet ef migrations` construct LeafDbContext without booting the full Api
/// host. Reads the same appsettings/user-secrets/env-var chain the Api project uses at runtime.</summary>
public class LeafDbContextFactory : IDesignTimeDbContextFactory<LeafDbContext>
{
    private const string ApiUserSecretsId = "d6f2b8e1-9a3c-4b7d-8e2f-1c5a9d3e7b40";

    public LeafDbContext CreateDbContext(string[] args)
    {
        var config = new ConfigurationBuilder()
            .AddUserSecrets(ApiUserSecretsId)
            .AddEnvironmentVariables()
            .Build();

        var connectionString = config["ConnectionStrings:Default"]
            ?? throw new InvalidOperationException("ConnectionStrings:Default not found in user-secrets or environment.");
        var encryptionKey = config["Leaf:EncryptionKey"]
            ?? throw new InvalidOperationException("Leaf:EncryptionKey not found in user-secrets or environment.");

        var optionsBuilder = new DbContextOptionsBuilder<LeafDbContext>();
        optionsBuilder.UseNpgsql(connectionString);

        return new LeafDbContext(optionsBuilder.Options, new AesGcmEncryptionService(encryptionKey));
    }
}
