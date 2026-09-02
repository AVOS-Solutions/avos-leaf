using Avos.Leaf.Api.Contracts;
using Avos.Leaf.Api.Services;
using Avos.Leaf.Domain.Entities;
using Avos.Leaf.Infrastructure.Persistence;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Avos.Leaf.Api.Controllers;

/// <summary>Personal folder tree for organizing PDFs — no sharing model (see LeafFolder's doc
/// comment). Every mutation re-checks OwnerAccountId so one account can never touch another's tree,
/// same "trust nothing but the caller's own id" idiom as every other controller here.</summary>
[ApiController]
[Route("api/folders")]
public class FoldersController(LeafDbContext db) : ControllerBase
{
    [HttpGet]
    public async Task<ActionResult<List<FolderDto>>> List()
    {
        var accountId = User.GetAccountId();
        var folders = await db.LeafFolders.Where(f => f.OwnerAccountId == accountId).OrderBy(f => f.Name).ToListAsync();
        return Ok(folders.Select(ToDto).ToList());
    }

    [HttpPost]
    public async Task<ActionResult<FolderDto>> Create(CreateFolderRequest request)
    {
        var accountId = User.GetAccountId();
        if (string.IsNullOrWhiteSpace(request.Name)) return BadRequest(new { message = "A folder needs a name." });

        if (request.ParentFolderId is { } parentId)
        {
            var parentExists = await db.LeafFolders.AnyAsync(f => f.Id == parentId && f.OwnerAccountId == accountId);
            if (!parentExists) return BadRequest(new { message = "That parent folder doesn't exist." });
        }

        var folder = new LeafFolder { OwnerAccountId = accountId, Name = request.Name.Trim(), ParentFolderId = request.ParentFolderId };
        db.LeafFolders.Add(folder);
        await db.SaveChangesAsync();
        return Ok(ToDto(folder));
    }

    [HttpPut("{id:guid}")]
    public async Task<ActionResult<FolderDto>> Rename(Guid id, RenameFolderRequest request)
    {
        var accountId = User.GetAccountId();
        var folder = await db.LeafFolders.FirstOrDefaultAsync(f => f.Id == id && f.OwnerAccountId == accountId);
        if (folder is null) return NotFound();
        if (string.IsNullOrWhiteSpace(request.Name)) return BadRequest(new { message = "A folder needs a name." });

        folder.Name = request.Name.Trim();
        folder.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync();
        return Ok(ToDto(folder));
    }

    /// <summary>Re-parents a folder — rejects any move that would make a folder its own ancestor
    /// (walking up from the requested new parent looking for `id` itself), the same cycle check
    /// every nested-folder tree in this platform needs.</summary>
    [HttpPut("{id:guid}/move")]
    public async Task<ActionResult<FolderDto>> Move(Guid id, [FromBody] Guid? newParentFolderId)
    {
        var accountId = User.GetAccountId();
        var folder = await db.LeafFolders.FirstOrDefaultAsync(f => f.Id == id && f.OwnerAccountId == accountId);
        if (folder is null) return NotFound();

        if (newParentFolderId == id) return BadRequest(new { message = "A folder can't be its own parent." });

        if (newParentFolderId is { } parentId)
        {
            var allFolders = await db.LeafFolders.Where(f => f.OwnerAccountId == accountId).ToListAsync();
            var cursor = allFolders.FirstOrDefault(f => f.Id == parentId);
            if (cursor is null) return BadRequest(new { message = "That parent folder doesn't exist." });
            while (cursor is not null)
            {
                if (cursor.Id == id) return BadRequest(new { message = "That move would nest a folder inside itself." });
                cursor = cursor.ParentFolderId is { } pid ? allFolders.FirstOrDefault(f => f.Id == pid) : null;
            }
        }

        folder.ParentFolderId = newParentFolderId;
        folder.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync();
        return Ok(ToDto(folder));
    }

    /// <summary>Refuses to delete a non-empty folder (documents or subfolders) rather than cascading
    /// — an accidental click here should never silently trash a whole tree of PDFs.</summary>
    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Delete(Guid id)
    {
        var accountId = User.GetAccountId();
        var folder = await db.LeafFolders.FirstOrDefaultAsync(f => f.Id == id && f.OwnerAccountId == accountId);
        if (folder is null) return NotFound();

        var hasChildren = await db.LeafFolders.AnyAsync(f => f.ParentFolderId == id)
            || await db.LeafDocuments.AnyAsync(d => d.FolderId == id && d.TrashedAt == null);
        if (hasChildren) return BadRequest(new { message = "Move or delete everything inside this folder first." });

        db.LeafFolders.Remove(folder);
        await db.SaveChangesAsync();
        return NoContent();
    }

    private static FolderDto ToDto(LeafFolder f) => new(f.Id, f.Name, f.ParentFolderId, f.CreatedAt);
}
