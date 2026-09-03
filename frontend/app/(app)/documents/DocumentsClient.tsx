"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Card, Input, Label, Modal, PageHeader, Select } from "@/components/ui";
import type { DocumentSummary, FolderSummary } from "@/lib/types";

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

type View = "browse" | "starred" | "trash";

export function DocumentsClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const folderId = searchParams.get("folder");
  const view = (searchParams.get("view") as View | null) ?? "browse";

  const [folders, setFolders] = useState<FolderSummary[]>([]);
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [renameTarget, setRenameTarget] = useState<{ kind: "folder" | "document"; id: string; name: string } | null>(null);
  const [moveTarget, setMoveTarget] = useState<{ kind: "folder" | "document"; id: string; currentFolderId: string | null } | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const loadFolders = useCallback(async () => {
    const response = await fetch("/api/backend/folders");
    if (response.ok) setFolders(await response.json());
  }, []);

  const loadDocuments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const url =
        view === "starred"
          ? "/api/backend/documents/starred"
          : view === "trash"
            ? "/api/backend/documents?trashed=true"
            : `/api/backend/documents${folderId ? `?folderId=${folderId}` : ""}`;
      const response = await fetch(url);
      if (!response.ok) throw new Error("Could not load your documents.");
      setDocuments(await response.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your documents.");
    } finally {
      setLoading(false);
    }
  }, [view, folderId]);

  useEffect(() => {
    // Plain fetch-on-mount/dependency-change — the eslint-plugin-react-hooks "set state in
    // effect" rule flags this shape generically, but there's no external-system subscription to
    // model here, just "load the current view's folders/documents."
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadFolders();
  }, [loadFolders]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadDocuments();
  }, [loadDocuments]);

  function goTo(next: { folder?: string | null; view?: View }) {
    const params = new URLSearchParams();
    if (next.view && next.view !== "browse") params.set("view", next.view);
    if (next.view === undefined && view !== "browse") params.set("view", view);
    if (next.folder !== undefined ? next.folder : folderId) {
      params.set("folder", (next.folder !== undefined ? next.folder : folderId)!);
    }
    router.push(params.toString() ? `/documents?${params}` : "/documents");
  }

  const subfolders = view === "browse" ? folders.filter((f) => f.parentFolderId === folderId) : [];
  const breadcrumb: FolderSummary[] = [];
  if (view === "browse") {
    let cursor = folderId ? folders.find((f) => f.id === folderId) : undefined;
    while (cursor) {
      breadcrumb.unshift(cursor);
      cursor = cursor.parentFolderId ? folders.find((f) => f.id === cursor!.parentFolderId) : undefined;
    }
  }

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      if (folderId) form.append("folderId", folderId);
      const response = await fetch("/api/documents/upload", { method: "POST", body: form });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message ?? "Upload failed.");
      await loadDocuments();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function createFolder(e: React.FormEvent) {
    e.preventDefault();
    const response = await fetch("/api/backend/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newFolderName, parentFolderId: folderId }),
    });
    if (response.ok) {
      setNewFolderOpen(false);
      setNewFolderName("");
      await loadFolders();
    }
  }

  async function submitRename(e: React.FormEvent) {
    e.preventDefault();
    if (!renameTarget) return;
    const path = renameTarget.kind === "folder" ? `/api/backend/folders/${renameTarget.id}` : `/api/backend/documents/${renameTarget.id}`;
    const response = await fetch(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: renameTarget.name }),
    });
    if (response.ok) {
      setRenameTarget(null);
      await Promise.all([loadFolders(), loadDocuments()]);
    }
  }

  async function submitMove(newFolderId: string) {
    if (!moveTarget) return;
    const path =
      moveTarget.kind === "folder" ? `/api/backend/folders/${moveTarget.id}/move` : `/api/backend/documents/${moveTarget.id}/move`;
    const body = moveTarget.kind === "folder" ? JSON.stringify(newFolderId || null) : JSON.stringify({ folderId: newFolderId || null });
    const response = await fetch(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body });
    if (response.ok) {
      setMoveTarget(null);
      await Promise.all([loadFolders(), loadDocuments()]);
    }
  }

  async function deleteFolder(id: string) {
    if (!confirm("Delete this folder? It must be empty.")) return;
    const response = await fetch(`/api/backend/folders/${id}`, { method: "DELETE" });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      alert(body?.message ?? "Could not delete that folder.");
      return;
    }
    await loadFolders();
  }

  async function toggleStar(doc: DocumentSummary) {
    await fetch(`/api/backend/documents/${doc.id}/star`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ starred: !doc.starred }),
    });
    await loadDocuments();
  }

  async function trashDocument(id: string) {
    await fetch(`/api/backend/documents/${id}`, { method: "DELETE" });
    await loadDocuments();
  }

  async function restoreDocument(id: string) {
    await fetch(`/api/backend/documents/${id}/restore`, { method: "POST" });
    await loadDocuments();
  }

  async function deleteForever(id: string) {
    if (!confirm("Permanently delete this document? This cannot be undone.")) return;
    await fetch(`/api/backend/documents/${id}/forever`, { method: "DELETE" });
    await loadDocuments();
  }

  async function duplicateDocument(id: string) {
    await fetch(`/api/backend/documents/${id}/duplicate`, { method: "POST" });
    await loadDocuments();
  }

  return (
    <>
      <PageHeader
        eyebrow="AVOS Leaf"
        title="Documents"
        action={
          view === "browse" && (
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setNewFolderOpen(true)}>
                New folder
              </Button>
              <Button onClick={() => fileInputRef.current?.click()} disabled={uploading}>
                {uploading ? "Uploading…" : "Upload PDF"}
              </Button>
              <input ref={fileInputRef} type="file" accept="application/pdf" className="hidden" onChange={handleUpload} />
            </div>
          )
        }
      />

      <div className="mb-6 flex items-center gap-6 border-b border-line pb-4 text-sm">
        <button className={view === "browse" ? "text-signal-dim" : "text-ink-soft"} onClick={() => goTo({ view: "browse", folder: null })}>
          All documents
        </button>
        <button className={view === "starred" ? "text-signal-dim" : "text-ink-soft"} onClick={() => goTo({ view: "starred", folder: null })}>
          Starred
        </button>
        <button className={view === "trash" ? "text-signal-dim" : "text-ink-soft"} onClick={() => goTo({ view: "trash", folder: null })}>
          Trash
        </button>
      </div>

      {view === "browse" && (
        <div className="mb-4 flex flex-wrap items-center gap-1 text-sm text-slate">
          <button className="hover:text-signal-dim" onClick={() => goTo({ folder: null })}>
            Root
          </button>
          {breadcrumb.map((f) => (
            <span key={f.id} className="flex items-center gap-1">
              <span>/</span>
              <button className="hover:text-signal-dim" onClick={() => goTo({ folder: f.id })}>
                {f.name}
              </button>
            </span>
          ))}
        </div>
      )}

      {error && <p className="mb-4 text-sm text-brass">{error}</p>}

      {loading ? (
        <p className="text-sm text-slate">Loading…</p>
      ) : (
        <div className="space-y-2">
          {subfolders.map((folder) => (
            <Card key={folder.id} className="flex items-center justify-between gap-4 py-3">
              <button className="flex-1 text-left" onClick={() => goTo({ folder: folder.id })}>
                📁 {folder.name}
              </button>
              <div className="flex gap-3 text-xs text-slate">
                <button className="hover:text-ink" onClick={() => setRenameTarget({ kind: "folder", id: folder.id, name: folder.name })}>
                  Rename
                </button>
                <button className="hover:text-ink" onClick={() => setMoveTarget({ kind: "folder", id: folder.id, currentFolderId: folder.parentFolderId })}>
                  Move
                </button>
                <button className="hover:text-brass" onClick={() => deleteFolder(folder.id)}>
                  Delete
                </button>
              </div>
            </Card>
          ))}

          {documents.length === 0 && subfolders.length === 0 && (
            <p className="py-8 text-center text-sm text-slate">
              {view === "trash" ? "Trash is empty." : view === "starred" ? "No starred documents yet." : "No documents here yet."}
            </p>
          )}

          {documents.map((doc) => (
            <Card key={doc.id} className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0 flex-1">
                {view === "trash" ? (
                  <span className="block truncate text-ink-soft">{doc.name}</span>
                ) : (
                  <Link href={`/documents/${doc.id}`} className="block truncate text-ink no-underline hover:text-signal-dim">
                    📄 {doc.name}
                  </Link>
                )}
                <span className="mono text-xs text-slate">
                  {formatBytes(doc.sizeBytes)} · {doc.pageCount || "?"} pages
                </span>
              </div>
              <div className="flex shrink-0 gap-3 text-xs text-slate">
                {view === "trash" ? (
                  <>
                    <button className="hover:text-ink" onClick={() => restoreDocument(doc.id)}>
                      Restore
                    </button>
                    <button className="hover:text-brass" onClick={() => deleteForever(doc.id)}>
                      Delete forever
                    </button>
                  </>
                ) : (
                  <>
                    <button className="hover:text-ink" onClick={() => toggleStar(doc)}>
                      {doc.starred ? "★ Unstar" : "☆ Star"}
                    </button>
                    <button className="hover:text-ink" onClick={() => setRenameTarget({ kind: "document", id: doc.id, name: doc.name })}>
                      Rename
                    </button>
                    <button className="hover:text-ink" onClick={() => setMoveTarget({ kind: "document", id: doc.id, currentFolderId: doc.folderId })}>
                      Move
                    </button>
                    <button className="hover:text-ink" onClick={() => duplicateDocument(doc.id)}>
                      Duplicate
                    </button>
                    <button className="hover:text-brass" onClick={() => trashDocument(doc.id)}>
                      Trash
                    </button>
                  </>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={newFolderOpen} onClose={() => setNewFolderOpen(false)} title="New folder">
        <form onSubmit={createFolder} className="space-y-4">
          <div>
            <Label htmlFor="folderName">Name</Label>
            <Input id="folderName" required autoFocus value={newFolderName} onChange={(e) => setNewFolderName(e.target.value)} />
          </div>
          <Button type="submit" className="w-full">
            Create
          </Button>
        </form>
      </Modal>

      <Modal open={!!renameTarget} onClose={() => setRenameTarget(null)} title="Rename">
        <form onSubmit={submitRename} className="space-y-4">
          <div>
            <Label htmlFor="renameName">Name</Label>
            <Input
              id="renameName"
              required
              autoFocus
              value={renameTarget?.name ?? ""}
              onChange={(e) => setRenameTarget((t) => (t ? { ...t, name: e.target.value } : t))}
            />
          </div>
          <Button type="submit" className="w-full">
            Save
          </Button>
        </form>
      </Modal>

      <Modal open={!!moveTarget} onClose={() => setMoveTarget(null)} title="Move to folder">
        <div className="space-y-4">
          <Select
            defaultValue={moveTarget?.currentFolderId ?? ""}
            onChange={(e) => submitMove(e.target.value)}
          >
            <option value="">Root</option>
            {folders
              .filter((f) => !moveTarget || moveTarget.kind !== "folder" || f.id !== moveTarget.id)
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
          </Select>
        </div>
      </Modal>
    </>
  );
}
