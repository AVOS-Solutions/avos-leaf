using System.Security.Claims;
using System.Security.Cryptography;
using Avos.Leaf.Api.Contracts;
using Avos.Leaf.Api.Controllers;
using Avos.Leaf.Infrastructure.Persistence;
using Avos.Leaf.Infrastructure.Security;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Avos.Leaf.Tests;

/// <summary>Exercises FoldersController against a real (in-memory) LeafDbContext — same object the
/// controller runs against in production, minus Postgres. Covers the two behaviors most worth
/// pinning down: the move-cycle guard and non-empty-folder delete refusal.</summary>
public class FoldersControllerTests
{
    private static LeafDbContext NewDb()
    {
        var key = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
        var options = new DbContextOptionsBuilder<LeafDbContext>()
            .UseInMemoryDatabase(Guid.NewGuid().ToString())
            .Options;
        return new LeafDbContext(options, new AesGcmEncryptionService(key));
    }

    private static FoldersController NewController(LeafDbContext db, Guid accountId)
    {
        var controller = new FoldersController(db);
        var user = new ClaimsPrincipal(new ClaimsIdentity([new Claim(ClaimTypes.NameIdentifier, accountId.ToString())]));
        controller.ControllerContext = new ControllerContext { HttpContext = new DefaultHttpContext { User = user } };
        return controller;
    }

    [Fact]
    public async Task Move_IntoOwnDescendant_IsRejectedAsACycle()
    {
        using var db = NewDb();
        var accountId = Guid.NewGuid();
        var controller = NewController(db, accountId);

        var root = Assert.IsType<FolderDto>(Assert.IsType<OkObjectResult>((await controller.Create(new CreateFolderRequest("Root"))).Result).Value);
        var child = Assert.IsType<FolderDto>(Assert.IsType<OkObjectResult>((await controller.Create(new CreateFolderRequest("Child", root.Id))).Result).Value);

        var result = await controller.Move(root.Id, child.Id);

        Assert.IsType<BadRequestObjectResult>(result.Result);
    }

    [Fact]
    public async Task Move_ToAValidNewParent_Succeeds()
    {
        using var db = NewDb();
        var accountId = Guid.NewGuid();
        var controller = NewController(db, accountId);

        var folderA = Assert.IsType<FolderDto>(Assert.IsType<OkObjectResult>((await controller.Create(new CreateFolderRequest("A"))).Result).Value);
        var folderB = Assert.IsType<FolderDto>(Assert.IsType<OkObjectResult>((await controller.Create(new CreateFolderRequest("B"))).Result).Value);

        var result = await controller.Move(folderB.Id, folderA.Id);

        var moved = Assert.IsType<FolderDto>(Assert.IsType<OkObjectResult>(result.Result).Value);
        Assert.Equal(folderA.Id, moved.ParentFolderId);
    }

    [Fact]
    public async Task Delete_ANonEmptyFolder_IsRefused()
    {
        using var db = NewDb();
        var accountId = Guid.NewGuid();
        var controller = NewController(db, accountId);

        var parent = Assert.IsType<FolderDto>(Assert.IsType<OkObjectResult>((await controller.Create(new CreateFolderRequest("Parent"))).Result).Value);
        await controller.Create(new CreateFolderRequest("Child", parent.Id));

        var result = await controller.Delete(parent.Id);

        Assert.IsType<BadRequestObjectResult>(result);
        Assert.Equal(2, db.LeafFolders.Count());
    }

    [Fact]
    public async Task Delete_AnEmptyFolder_Succeeds()
    {
        using var db = NewDb();
        var accountId = Guid.NewGuid();
        var controller = NewController(db, accountId);

        var folder = Assert.IsType<FolderDto>(Assert.IsType<OkObjectResult>((await controller.Create(new CreateFolderRequest("Solo"))).Result).Value);

        var result = await controller.Delete(folder.Id);

        Assert.IsType<NoContentResult>(result);
        Assert.Empty(db.LeafFolders);
    }

    [Fact]
    public async Task List_OnlyReturnsTheCallingAccountsFolders()
    {
        using var db = NewDb();
        var accountA = Guid.NewGuid();
        var accountB = Guid.NewGuid();

        await NewController(db, accountA).Create(new CreateFolderRequest("A's folder"));
        await NewController(db, accountB).Create(new CreateFolderRequest("B's folder"));

        var result = await NewController(db, accountA).List();

        var folders = Assert.IsType<List<FolderDto>>(Assert.IsType<OkObjectResult>(result.Result).Value);
        Assert.Single(folders);
        Assert.Equal("A's folder", folders[0].Name);
    }
}
