using System.Collections.Concurrent;
using System.Net.WebSockets;

namespace Avos.Leaf.Api.Ws;

/// <summary>One connected browser tab in a leaf's live room. Carries no slide/element/cursor state
/// of its own — presence (who's online, who's editing which slide) travels entirely inside the Yjs
/// awareness frames this relay forwards blindly, never parsed server-side (see
/// LeafCollaborationHandler's doc comment). AccountId exists only for the room's own bookkeeping
/// (nothing here is broadcast to peers). Ported from avos-quill's ActiveDocumentParticipant /
/// avos-slate's ActiveWorkbookParticipant — same shape, adapted to leafs.</summary>
public class ActiveLeafParticipant(WebSocket socket, Guid accountId)
{
    public WebSocket Socket { get; } = socket;
    public Guid AccountId { get; } = accountId;
}

/// <summary>The live state of one leaf's collaboration room — entirely in-memory and per-process,
/// same single-process-owns-every-room shape as avos-quill's DocumentRoom / avos-slate's
/// WorkbookRoom (see their own doc comments on the tradeoff). Keyed by HistoryId (a string, not a
/// Guid — see Leaf.historyId's doc comment in lib/leaf/model.ts: it's a client-minted
/// crypto.randomUUID(), never validated as a Guid server-side).</summary>
public class LeafRoom(string historyId)
{
    public string HistoryId { get; } = historyId;
    public ConcurrentDictionary<Guid, ActiveLeafParticipant> Active { get; } = new();
    public bool IsEmpty => Active.IsEmpty;
}

/// <summary>Registry of every live leaf room, keyed by HistoryId — a singleton so it survives
/// across the many independent WebSocket connections that make up one leaf's live session.
///
/// This relay is deliberately content-blind: it never parses a single byte of what it forwards.
/// The frames it carries are raw Yjs update bytes and raw y-protocols/awareness bytes, opaque here
/// (see frontend/lib/collab/ for what's actually inside them and the slide/element Y.Map mapping
/// and LWW scoping decision). That buys the same two things avos-quill's DocumentRoomManager
/// documents: this server can never get CRDT merge logic wrong (there is none here to get wrong),
/// and the exact same relay would work unmodified even for content encrypted client-side before
/// ever reaching Yjs — not needed for this feature's scope (Standard/vault tier only; Private Vault
/// (E2EE) leafs never open a collaboration socket at all — see the frontend gating in
/// lib/collab/useLeafCollab.ts), but it's a nice side effect of the design, not a coincidence.
///
/// Access control is deliberately *not* per-leaf beyond "is this a valid, authenticated avos-leaf
/// account": any authenticated account whose browser knows a leaf's HistoryId may join that
/// HistoryId's room. HistoryId is a random, unguessable crypto.randomUUID() the browser only ever
/// learns by successfully loading that leaf through the existing, already-access-controlled load
/// path (GET /api/leafs/[id], which goes through avos-vault's own account-scoped file access) — so
/// "knows the id" already implies "was allowed to load the leaf" once, the same unguessable-id-as-
/// bearer-capability trust boundary avos-vault's own public download endpoints already rely on
/// (and the same trust boundary avos-quill's/avos-slate's own room managers rely on for
/// HistoryId). There is no separate per-leaf ACL table to check here, and that's intentional, not
/// an oversight.</summary>
public class LeafRoomManager
{
    private readonly ConcurrentDictionary<string, LeafRoom> _rooms = new();

    public LeafRoom GetOrCreate(string historyId) => _rooms.GetOrAdd(historyId, id => new LeafRoom(id));

    public void RemoveIfEmpty(LeafRoom room)
    {
        if (room.IsEmpty)
        {
            _rooms.TryRemove(new KeyValuePair<string, LeafRoom>(room.HistoryId, room));
        }
    }

    /// <summary>Sends one binary frame to a single socket — used both for relaying a peer's frame
    /// verbatim and for the server's own "hello" frame (see LeafCollaborationHandler).</summary>
    public static async Task SendBinaryAsync(WebSocket socket, byte[] payload, CancellationToken ct = default)
    {
        if (socket.State != WebSocketState.Open) return;
        try
        {
            await socket.SendAsync(payload, WebSocketMessageType.Binary, true, ct);
        }
        catch (Exception ex) when (ex is WebSocketException or ObjectDisposedException or InvalidOperationException)
        {
            // Peer likely disconnected mid-send — nothing more to do.
        }
    }

    public static async Task BroadcastBinaryAsync(LeafRoom room, byte[] payload, Guid exceptParticipantId, CancellationToken ct = default)
    {
        foreach (var (participantId, participant) in room.Active)
        {
            if (participantId == exceptParticipantId) continue;
            await SendBinaryAsync(participant.Socket, payload, ct);
        }
    }

    /// <summary>Reads one full WebSocket binary message (reassembling fragments) and returns its raw
    /// bytes, or null if the remote closed the connection or the socket faulted. This server never
    /// decodes what's inside; the leading message-type byte (0 = Yjs sync/update, 1 = Yjs awareness —
    /// see LeafCollaborationHandler) is a frontend-only convention forwarded untouched.</summary>
    public static async Task<byte[]?> ReceiveBinaryFrameAsync(WebSocket socket, CancellationToken ct)
    {
        var buffer = new byte[64 * 1024];
        using var stream = new MemoryStream();
        try
        {
            WebSocketReceiveResult result;
            do
            {
                result = await socket.ReceiveAsync(buffer, ct);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    if (socket.State == WebSocketState.CloseReceived)
                    {
                        await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, null, ct);
                    }
                    return null;
                }
                stream.Write(buffer, 0, result.Count);
            } while (!result.EndOfMessage);
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException or ObjectDisposedException)
        {
            return null;
        }

        return stream.ToArray();
    }

    public static async Task TryCloseAsync(WebSocket socket, string? reason = null)
    {
        try
        {
            if (socket.State == WebSocketState.Open || socket.State == WebSocketState.CloseReceived)
            {
                await socket.CloseAsync(WebSocketCloseStatus.NormalClosure, reason, CancellationToken.None);
            }
        }
        catch (WebSocketException)
        {
            // Already gone — nothing to clean up.
        }
    }
}
