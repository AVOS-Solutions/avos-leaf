namespace Avos.Leaf.Domain.Entities;

/// <summary>One PDF file. The actual bytes never touch Postgres — they live in blob storage (see
/// IBlobStorageService) under StorageKey, server-side envelope encrypted: a random per-file Data
/// Encryption Key encrypts the PDF bytes, and that DEK itself is encrypted with the server's master
/// key (EncryptedDek) before being stored here. This is the same envelope-encryption idiom as
/// avos-vault's VaultFile.ServerSide tier — genuine E2EE (a Private-Vault-style tier the server
/// truly cannot decrypt) is deliberately deferred; PDF editing operations that need to run
/// server-side (e.g. OCR, if ever added there) would be impossible against ciphertext this server
/// can't open, so Phase 1 favors the tier that keeps every feature buildable.</summary>
public class LeafDocument : BaseEntity
{
    public required Guid OwnerAccountId { get; set; }

    public required string Name { get; set; }

    /// <summary>Null means the document sits at the account's root.</summary>
    public Guid? FolderId { get; set; }

    public long SizeBytes { get; set; }

    /// <summary>Purely for list-view display. The server never parses PDF structure (see this
    /// class's doc comment on the client-side-only editing split) — the frontend reads the real page
    /// count via pdf.js after upload/save and pushes it back through SetPageCount.</summary>
    public int PageCount { get; set; }

    /// <summary>The blob store key the encrypted PDF bytes live under — opaque, not derived from
    /// Name, so renaming never requires a storage move. See IBlobStorageService.</summary>
    public required string StorageKey { get; set; }

    /// <summary>Base64 AES-256-GCM ciphertext of this document's random per-file Data Encryption
    /// Key, wrapped with the server's master key — see the class doc comment.</summary>
    public required string EncryptedDek { get; set; }

    /// <summary>Soft-delete timestamp — a trashed document is hidden from every normal list view but
    /// not yet actually removed from blob storage (see DocumentRetentionSweeper, same "Trash
    /// auto-empties after N days" idiom as avos-mail's TrashRetentionSweeper). Null means not
    /// trashed.</summary>
    public DateTimeOffset? TrashedAt { get; set; }

    public bool Starred { get; set; }
}
