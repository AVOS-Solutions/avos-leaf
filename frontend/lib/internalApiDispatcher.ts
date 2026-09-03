import { Agent } from "undici";

// In production API_URL/VAULT_API_URL point at their container's Caddy sidecar (self-signed "tls
// internal" cert) — trust for this hop comes from the Docker private network boundary, not a CA
// chain. Every server-side fetch to an internal API passes this as its `dispatcher` so only calls
// to our own internal APIs skip verification.
//
// Kept in its own module (not lib/config.ts) because it imports `undici`, which needs Node builtins
// that can't be bundled for the browser — a sibling product (avos-licensing) shipped a version of
// config.ts that mixed this with a client-importable constant and crashed every page on load when
// Turbopack tried to bundle undici into the client. Keeping this split prevents that class of bug
// even if config.ts later grows an export a client component needs.
export const internalApiDispatcher = new Agent({ connect: { rejectUnauthorized: false } });
