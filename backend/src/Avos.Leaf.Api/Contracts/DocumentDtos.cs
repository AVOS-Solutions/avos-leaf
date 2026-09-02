namespace Avos.Leaf.Api.Contracts;

public record FolderDto(Guid Id, string Name, Guid? ParentFolderId, DateTimeOffset CreatedAt);

public record CreateFolderRequest(string Name, Guid? ParentFolderId = null);

public record RenameFolderRequest(string Name);

public record DocumentDto(
    Guid Id, string Name, Guid? FolderId, long SizeBytes, int PageCount,
    bool Starred, DateTimeOffset? TrashedAt, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt);

public record RenameDocumentRequest(string Name);

public record MoveDocumentRequest(Guid? FolderId);

public record SetStarredRequest(bool Starred);
