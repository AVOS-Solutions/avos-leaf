namespace Avos.Leaf.Domain.Entities;

/// <summary>A simple folder for organizing PDFs — no sharing/collaboration model yet (unlike
/// avos-vault's VaultFolder), just personal organization. Null ParentFolderId means the folder
/// sits at the account's root.</summary>
public class LeafFolder : BaseEntity
{
    public required Guid OwnerAccountId { get; set; }

    public required string Name { get; set; }

    public Guid? ParentFolderId { get; set; }
}
