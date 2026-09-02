using System.Security.Claims;
using System.Security.Cryptography;
using Avos.Leaf.Api.Contracts;
using Avos.Leaf.Api.Controllers;
using Avos.Leaf.Infrastructure.Persistence;
using Avos.Leaf.Infrastructure.Security;
using Avos.Leaf.Infrastructure.Storage;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Avos.Leaf.Tests;

/// <summary>Exercises DocumentsController against a real (in-memory) LeafDbContext and a real
/// LeafFileEncryptionService — the same envelope-encryption path this controller runs in
/// production, minus Postgres and real blob storage (an in-memory IBlobStorageService stub stands
/// in for that). Confirms the two guarantees that matter most: content round-trips correctly
/// through encrypt/store/read/decrypt, and one account can never reach another's documents.</summary>
public class DocumentsControllerTests
{
    private static readonly byte[] MinimalPdf = "%PDF-1.7\n%%EOF"u8.ToArray();

    private sealed class InMemoryBlobStorageService : IBlobStorageService
    {
        private readonly Dictionary<string, byte[]> store = [];

        public Task<string> SaveAsync(byte[] content, CancellationToken ct = default)
        {
            var key = Guid.NewGuid().ToString("N");
            store[key] = content;
            return Task.FromResult(key);
        }

        public Task<byte[]?> ReadAsync(string key, CancellationToken ct = default) =>
            Task.FromResult(store.GetValueOrDefault(key));

        public Task DeleteAsync(string key, CancellationToken ct = default)
        {
            store.Remove(key);
            return Task.CompletedTask;
        }

        public int Count => store.Count;
    }

    private static LeafDbContext NewDb()
    {
        var key = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
        var options = new DbContextOptionsBuilder<LeafDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .Options;
        return new LeafDbContext(options, new AesGcmEncryptionService(key));
    }

    private static DocumentsController NewController(LeafDbContext db, InMemoryBlobStorageService blobStorage, Guid accountId)
    {
        var controller = new DocumentsController(db, new LeafFileEncryptionService(new AesGcmEncryptionService(Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)))), blobStorage);
        var user = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, accountId.ToString())]));
        controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = user } };
        return controller;
    }

    private static IFormFile MakeFormFile(byte[] bytes, string name = "test.pdf")
    {
        var stream = new MemoryStream(bytes);
        return new FormFile(stream, 0, bytes.Length, "file", name);
    }

    [Fact]
    public async Task Upload_ThenGetContent_RoundTripsTheExactPlaintextBytes()
    {
        using var db = NewDb();
        var blobStorage = new InMemoryBlobStorageService();
        var accountId = Guid.NewGuid();
        var controller = NewController(db, blobStorage, accountId);

        var uploadResult = await controller.Upload(MakeFormFile(MinimalPdf), null);
        var dto = Assert.IsType<DocumentDto>(Assert.IsType<OkObjectResult>(uploadResult.Result).Value);

        var contentResult = Assert.IsType<FileContentResult>(await controller.GetContent(dto.Id));
        Assert.Equal(MinimalPdf, contentResult.FileContents);
        Assert.Equal("application/pdf", contentResult.ContentType);
    }

    [Fact]
    public async Task Upload_RejectsFilesThatDoNotLookLikeAPdf()
    {
        using var db = NewDb();
        var controller = NewController(db, new InMemoryBlobStorageService(), Guid.NewGuid());

        var result = await controller.Upload(MakeFormFile("not a pdf"u8.ToArray()), null);

        Assert.IsType<BadRequestObjectResult>(result.Result);
        Assert.Empty(db.LeafDocuments);
    }

    [Fact]
    public async Task Get_AnotherAccountsDocument_ReturnsNotFound()
    {
        using var db = NewDb();
        var blobStorage = new InMemoryBlobStorageService();
        var owner = Guid.NewGuid();
        var stranger = Guid.NewGuid();
        var ownerController = NewController(db, blobStorage, owner);

        var uploadResult = await ownerController.Upload(MakeFormFile(MinimalPdf), null);
        var dto = Assert.IsType<DocumentDto>(Assert.IsType<OkObjectResult>(uploadResult.Result).Value);

        var strangerController = NewController(db, blobStorage, stranger);
        Assert.IsType<NotFoundResult>(await strangerController.GetContent(dto.Id));
        Assert.IsType<NotFoundResult>((await strangerController.Get(dto.Id)).Result);
    }

    [Fact]
    public async Task PutContent_ReplacesTheBlobAndDeletesTheOldOne()
    {
        using var db = NewDb();
        var blobStorage = new InMemoryBlobStorageService();
        var accountId = Guid.NewGuid();
        var controller = NewController(db, blobStorage, accountId);

        var uploadResult = await controller.Upload(MakeFormFile(MinimalPdf), null);
        var dto = Assert.IsType<DocumentDto>(Assert.IsType<OkObjectResult>(uploadResult.Result).Value);
        Assert.Equal(1, blobStorage.Count);

        var updatedPdf = "%PDF-1.7\nsome more content\n%%EOF"u8.ToArray();
        await controller.PutContent(dto.Id, MakeFormFile(updatedPdf));

        Assert.Equal(1, blobStorage.Count);
        var contentResult = Assert.IsType<FileContentResult>(await controller.GetContent(dto.Id));
        Assert.Equal(updatedPdf, contentResult.FileContents);
    }

    [Fact]
    public async Task Trash_ThenRestore_RoundTripsVisibility()
    {
        using var db = NewDb();
        var blobStorage = new InMemoryBlobStorageService();
        var accountId = Guid.NewGuid();
        var controller = NewController(db, blobStorage, accountId);

        var uploadResult = await controller.Upload(MakeFormFile(MinimalPdf), null);
        var dto = Assert.IsType<DocumentDto>(Assert.IsType<OkObjectResult>(uploadResult.Result).Value);

        await controller.Trash(dto.Id);
        var afterTrash = await controller.List(null, trashed: false);
        Assert.Empty(Assert.IsType<OkObjectResult>(afterTrash.Result).Value as List<DocumentDto> ?? []);

        await controller.Restore(dto.Id);
        var afterRestore = await controller.List(null, trashed: false);
        Assert.Single(Assert.IsType<OkObjectResult>(afterRestore.Result).Value as List<DocumentDto> ?? []);
    }

    [Fact]
    public async Task DeleteForever_RemovesTheRowAndTheBlob()
    {
        using var db = NewDb();
        var blobStorage = new InMemoryBlobStorageService();
        var accountId = Guid.NewGuid();
        var controller = NewController(db, blobStorage, accountId);

        var uploadResult = await controller.Upload(MakeFormFile(MinimalPdf), null);
        var dto = Assert.IsType<DocumentDto>(Assert.IsType<OkObjectResult>(uploadResult.Result).Value);

        await controller.DeleteForever(dto.Id);

        Assert.Empty(db.LeafDocuments);
        Assert.Equal(0, blobStorage.Count);
    }
}
