using Avos.Leaf.Api.Contracts;
using Avos.Leaf.Api.Services;
using Avos.Leaf.Domain.Entities;
using Avos.Leaf.Infrastructure.Persistence;
using Avos.Leaf.Infrastructure.Security;
using Avos.Leaf.Infrastructure.Storage;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

namespace Avos.Leaf.Api.Controllers;

/// <summary>PDF storage: upload, list, rename, move, star, trash/restore/delete-forever, and
/// content read/write. Every actual *editing* operation (merge, split, rotate, annotate, redact,
/// fill forms, watermark, ...) happens entirely client-side against the decrypted bytes GetContent
/// hands back — this server's only job is holding the encrypted blob and metadata, the same
/// "content processing happens in the browser" split every other document app on this platform
/// uses for its Standard tier. PutContent is how an edited copy gets saved back.</summary>
[ApiController]
[Route("api/documents")]
public class DocumentsController(LeafDbContext db, IFileEncryptionService fileEncryption, IBlobStorageService blobStorage) : ControllerBase
{
    // Matches this server's own request body size limit (see Program.cs's Kestrel config) — checked
    // here too so a too-large upload gets a clear message instead of a generic connection reset.
    private const long MaxUploadBytes = 200 * 1024 * 1024;

    [HttpGet]
    public async Task<ActionResult<List<DocumentDto>>> List([FromQuery] Guid? folderId, [FromQuery] bool trashed = false)
    {
        var accountId = User.GetAccountId();
        var query = db.LeafDocuments.Where(d => d.OwnerAccountId == accountId);
        query = trashed ? query.Where(d => d.TrashedAt != null) : query.Where(d => d.TrashedAt == null && d.FolderId == folderId);

        var documents = await query.OrderByDescending(d => d.UpdatedAt).ToListAsync();
        return Ok(documents.Select(ToDto).ToList());
    }

    [HttpGet("starred")]
    public async Task<ActionResult<List<DocumentDto>>> Starred()
    {
        var accountId = User.GetAccountId();
        var documents = await db.LeafDocuments
            .Where(d => d.OwnerAccountId == accountId && d.Starred && d.TrashedAt == null)
            .OrderByDescending(d => d.UpdatedAt)
            .ToListAsync();
        return Ok(documents.Select(ToDto).ToList());
    }

    [HttpGet("{id:guid}")]
    public async Task<ActionResult<DocumentDto>> Get(Guid id)
    {
        var accountId = User.GetAccountId();
        var document = await db.LeafDocuments.FirstOrDefaultAsync(d => d.Id == id && d.OwnerAccountId == accountId);
        if (document is null) return NotFound();
        return Ok(ToDto(document));
    }

    /// <summary>Returns the decrypted raw PDF bytes for this document — the frontend loads these
    /// straight into pdf.js for viewing and pdf-lib for editing. Never cached by an intermediary:
    /// this is the one place this server ever reconstitutes plaintext PDF content, and only for the
    /// owning account's own authenticated request.</summary>
    [HttpGet("{id:guid}/content")]
    public async Task<IActionResult> GetContent(Guid id)
    {
        var accountId = User.GetAccountId();
        var document = await db.LeafDocuments.FirstOrDefaultAsync(d => d.Id == id && d.OwnerAccountId == accountId);
        if (document is null) return NotFound();

        var ciphertext = await blobStorage.ReadAsync(document.StorageKey);
        if (ciphertext is null) return NotFound();

        var dek = fileEncryption.UnwrapDek(document.EncryptedDek);
        var plaintext = fileEncryption.Decrypt(ciphertext, dek);
        return File(plaintext, "application/pdf", document.Name);
    }

    [HttpPost("upload")]
    [RequestSizeLimit(MaxUploadBytes)]
    public async Task<ActionResult<DocumentDto>> Upload(IFormFile file, [FromForm] Guid? folderId)
    {
        var accountId = User.GetAccountId();
        if (file.Length == 0) return BadRequest(new { message = "That file is empty." });
        if (file.Length > MaxUploadBytes) return BadRequest(new { message = "That file is too large (200 MB limit)." });

        using var stream = new MemoryStream();
        await file.CopyToAsync(stream);
        var bytes = stream.ToArray();
        if (!LooksLikePdf(bytes)) return BadRequest(new { message = "That doesn't look like a PDF file." });

        if (folderId is { } fid)
        {
            var folderExists = await db.LeafFolders.AnyAsync(f => f.Id == fid && f.OwnerAccountId == accountId);
            if (!folderExists) return BadRequest(new { message = "That folder doesn't exist." });
        }

        var document = await StoreNewDocumentAsync(accountId, file.FileName, folderId, bytes);
        return Ok(ToDto(document));
    }

    /// <summary>Saves an edited copy back over this document's content — the frontend re-uploads
    /// the full modified PDF (pdf-lib's own output) rather than sending a diff, same "whole new
    /// version replaces the old one" idiom CanvasStage's table/curved-text rebuilds use elsewhere on
    /// this platform. The old blob is deleted only after the new one is safely written, so a failed
    /// write can never leave a document with no readable content at all.</summary>
    [HttpPut("{id:guid}/content")]
    [RequestSizeLimit(MaxUploadBytes)]
    public async Task<ActionResult<DocumentDto>> PutContent(Guid id, IFormFile file)
    {
        var accountId = User.GetAccountId();
        var document = await db.LeafDocuments.FirstOrDefaultAsync(d => d.Id == id && d.OwnerAccountId == accountId);
        if (document is null) return NotFound();
        if (file.Length == 0) return BadRequest(new { message = "That file is empty." });
        if (file.Length > MaxUploadBytes) return BadRequest(new { message = "That file is too large (200 MB limit)." });

        using var stream = new MemoryStream();
        await file.CopyToAsync(stream);
        var bytes = stream.ToArray();
        if (!LooksLikePdf(bytes)) return BadRequest(new { message = "That doesn't look like a PDF file." });

        var dek = fileEncryption.GenerateDek();
        var ciphertext = fileEncryption.Encrypt(bytes, dek);
        var newKey = await blobStorage.SaveAsync(ciphertext);

        var oldKey = document.StorageKey;
        document.StorageKey = newKey;
        document.EncryptedDek = fileEncryption.WrapDek(dek);
        document.SizeBytes = bytes.LongLength;
        document.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync();
        await blobStorage.DeleteAsync(oldKey);

        return Ok(ToDto(document));
    }

    [HttpPost("{id:guid}/duplicate")]
    public async Task<ActionResult<DocumentDto>> Duplicate(Guid id)
    {
        var accountId = User.GetAccountId();
        var source = await db.LeafDocuments.FirstOrDefaultAsync(d => d.Id == id && d.OwnerAccountId == accountId);
        if (source is null) return NotFound();

        var ciphertext = await blobStorage.ReadAsync(source.StorageKey);
        if (ciphertext is null) return NotFound();
        var dek = fileEncryption.UnwrapDek(source.EncryptedDek);
        var plaintext = fileEncryption.Decrypt(ciphertext, dek);

        var copyName = $"{Path.GetFileNameWithoutExtension(source.Name)} (copy){Path.GetExtension(source.Name)}";
        var copy = await StoreNewDocumentAsync(accountId, copyName, source.FolderId, plaintext);
        copy.PageCount = source.PageCount;
        await db.SaveChangesAsync();
        return Ok(ToDto(copy));
    }

    [HttpPut("{id:guid}/page-count")]
    public async Task<IActionResult> SetPageCount(Guid id, [FromBody] int pageCount)
    {
        var accountId = User.GetAccountId();
        var document = await db.LeafDocuments.FirstOrDefaultAsync(d => d.Id == id && d.OwnerAccountId == accountId);
        if (document is null) return NotFound();

        document.PageCount = pageCount;
        await db.SaveChangesAsync();
        return NoContent();
    }

    [HttpPut("{id:guid}")]
    public async Task<ActionResult<DocumentDto>> Rename(Guid id, RenameDocumentRequest request)
    {
        var accountId = User.GetAccountId();
        var document = await db.LeafDocuments.FirstOrDefaultAsync(d => d.Id == id && d.OwnerAccountId == accountId);
        if (document is null) return NotFound();
        if (string.IsNullOrWhiteSpace(request.Name)) return BadRequest(new { message = "A document needs a name." });

        document.Name = request.Name.Trim();
        document.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync();
        return Ok(ToDto(document));
    }

    [HttpPut("{id:guid}/move")]
    public async Task<ActionResult<DocumentDto>> Move(Guid id, MoveDocumentRequest request)
    {
        var accountId = User.GetAccountId();
        var document = await db.LeafDocuments.FirstOrDefaultAsync(d => d.Id == id && d.OwnerAccountId == accountId);
        if (document is null) return NotFound();

        if (request.FolderId is { } fid)
        {
            var folderExists = await db.LeafFolders.AnyAsync(f => f.Id == fid && f.OwnerAccountId == accountId);
            if (!folderExists) return BadRequest(new { message = "That folder doesn't exist." });
        }

        document.FolderId = request.FolderId;
        document.UpdatedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync();
        return Ok(ToDto(document));
    }

    [HttpPut("{id:guid}/star")]
    public async Task<ActionResult<DocumentDto>> SetStarred(Guid id, SetStarredRequest request)
    {
        var accountId = User.GetAccountId();
        var document = await db.LeafDocuments.FirstOrDefaultAsync(d => d.Id == id && d.OwnerAccountId == accountId);
        if (document is null) return NotFound();

        document.Starred = request.Starred;
        await db.SaveChangesAsync();
        return Ok(ToDto(document));
    }

    [HttpDelete("{id:guid}")]
    public async Task<IActionResult> Trash(Guid id)
    {
        var accountId = User.GetAccountId();
        var document = await db.LeafDocuments.FirstOrDefaultAsync(d => d.Id == id && d.OwnerAccountId == accountId);
        if (document is null) return NotFound();

        document.TrashedAt = DateTimeOffset.UtcNow;
        await db.SaveChangesAsync();
        return NoContent();
    }

    [HttpPost("{id:guid}/restore")]
    public async Task<ActionResult<DocumentDto>> Restore(Guid id)
    {
        var accountId = User.GetAccountId();
        var document = await db.LeafDocuments.FirstOrDefaultAsync(d => d.Id == id && d.OwnerAccountId == accountId && d.TrashedAt != null);
        if (document is null) return NotFound();

        document.TrashedAt = null;
        await db.SaveChangesAsync();
        return Ok(ToDto(document));
    }

    [HttpDelete("{id:guid}/forever")]
    public async Task<IActionResult> DeleteForever(Guid id)
    {
        var accountId = User.GetAccountId();
        var document = await db.LeafDocuments.FirstOrDefaultAsync(d => d.Id == id && d.OwnerAccountId == accountId);
        if (document is null) return NotFound();

        await blobStorage.DeleteAsync(document.StorageKey);
        db.LeafDocuments.Remove(document);
        await db.SaveChangesAsync();
        return NoContent();
    }

    private async Task<LeafDocument> StoreNewDocumentAsync(Guid accountId, string name, Guid? folderId, byte[] plaintext)
    {
        var dek = fileEncryption.GenerateDek();
        var ciphertext = fileEncryption.Encrypt(plaintext, dek);
        var storageKey = await blobStorage.SaveAsync(ciphertext);

        var document = new LeafDocument
        {
            OwnerAccountId = accountId,
            Name = name,
            FolderId = folderId,
            SizeBytes = plaintext.LongLength,
            StorageKey = storageKey,
            EncryptedDek = fileEncryption.WrapDek(dek),
        };
        db.LeafDocuments.Add(document);
        await db.SaveChangesAsync();
        return document;
    }

    /// <summary>Cheap sanity check, not a real parse — every valid PDF starts with a `%PDF-` header
    /// (the version follows, e.g. `%PDF-1.7`). Catches "wrong file type" uploads before they ever
    /// reach encryption/storage; it does not validate that the rest of the file is well-formed.</summary>
    private static bool LooksLikePdf(byte[] bytes) =>
        bytes.Length > 5 && bytes[0] == '%' && bytes[1] == 'P' && bytes[2] == 'D' && bytes[3] == 'F' && bytes[4] == '-';

    private static DocumentDto ToDto(LeafDocument d) =>
        new(d.Id, d.Name, d.FolderId, d.SizeBytes, d.PageCount, d.Starred, d.TrashedAt, d.CreatedAt, d.UpdatedAt);
}
