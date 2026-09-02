using System.Net.WebSockets;

namespace Avos.Leaf.Api.Ws;

/// <summary>The real-time collaboration relay for one leaf, mounted at /ws/leafs/{historyId}.
/// Ported from avos-quill's DocumentCollaborationHandler / avos-slate's WorkbookCollaborationHandler
/// — same shape, same protocol, adapted from blocks/sheets to slides/elements. This is NOT the
/// write path for leaf content — it never persists anything and never inspects a frame's content.
/// Every frame a connected browser sends (a Yjs document update, or a y-protocols/awareness
/// presence update) is broadcast verbatim to every *other* live participant in the room and nothing
/// else happens server-side. Real persistence continues entirely through the existing
/// PUT /api/leafs/{id} save flow (and, from there, avos-vault's own storage) — this relay is purely
/// ephemeral, in-memory, per-process (see LeafRoomManager's doc comment).
///
/// Frame protocol (defined and consumed entirely by the frontend — see
/// frontend/lib/collab/docSocket.ts, reused byte-for-byte from avos-quill/avos-slate): every
/// client-to-client frame starts with a single message-type byte, 0 for a Yjs sync/update frame or
/// 1 for a Yjs awareness frame (same shape as the reference y-websocket server's own message-type
/// prefix, though this relay doesn't use that library, just its byte-prefix convention) — this
/// handler broadcasts the *whole* frame, prefix byte included, without ever reading past byte zero.
/// The one frame this handler *originates* itself (never relays) is a server-only "hello" frame,
/// type byte 2, one payload byte: 1 if this connection is the first participant in the room (so the
/// frontend knows it's responsible for seeding the shared Y.Doc from the leaf it already loaded via
/// the ordinary REST load path — see lib/collab/useLeafCollab.ts's doc comment on why exactly one
/// participant must do this), 0 otherwise (so every other joiner starts its local Y.Doc empty and
/// waits to receive the seeder's content via the normal Yjs sync exchange instead of re-seeding the
/// same slides a second time). This is connection-bookkeeping, not leaf-content awareness — the
/// same category of thing avos-quill's/avos-slate's own hello frame already is — so it doesn't
/// compromise the "server never understands Yjs payloads" property above.</summary>
public class LeafCollaborationHandler(LeafRoomManager rooms)
{
    private const byte FrameTypeHello = 2;

    public async Task HandleAsync(string historyId, Guid accountId, WebSocket socket, CancellationToken ct)
    {
        var room = rooms.GetOrCreate(historyId);
        var participantId = Guid.NewGuid();
        var self = new ActiveLeafParticipant(socket, accountId);

        // Snapshot "was anyone here before me" before adding myself, so the hello flag reflects the
        // room's state at the instant I joined — see the class doc comment on why exactly one
        // participant needs to know this.
        var youAreFirst = room.Active.IsEmpty;
        room.Active[participantId] = self;

        try
        {
            await LeafRoomManager.SendBinaryAsync(socket, [FrameTypeHello, (byte)(youAreFirst ? 1 : 0)], ct);

            while (true)
            {
                var frame = await LeafRoomManager.ReceiveBinaryFrameAsync(socket, ct);
                if (frame is null) break;
                if (frame.Length == 0) continue; // Nothing to relay.

                await LeafRoomManager.BroadcastBinaryAsync(room, frame, exceptParticipantId: participantId, ct: ct);
            }
        }
        finally
        {
            room.Active.TryRemove(participantId, out _);
            rooms.RemoveIfEmpty(room);
            // No server-constructed awareness "this client left" frame: doing that correctly would
            // require parsing/re-encoding the y-protocols/awareness wire format (including the
            // numeric Yjs clientID the leaving browser itself chose), which this handler
            // deliberately never does — see the class doc comment. Every other participant's own
            // Awareness instance prunes this client's presence state on its own after its
            // outdated-state timeout elapses (see lib/collab/docSocket.ts), so stale cursors never
            // linger indefinitely, just for a bounded window after a genuine disconnect. The instant
            // (not timeout-bounded) removal path is the CLIENT's own responsibility, before it closes
            // its socket — see docSocket.ts's disconnect() doc comment for the ordering bug that was
            // found and fixed there (broadcast the "I've left" awareness state before unsubscribing
            // the listener that sends it, not after).
        }
    }
}
