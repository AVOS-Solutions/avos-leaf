// avos-leaf has its own backend (Avos.Leaf.Api) — it holds no password of its own, but every
// signup/login/2FA/refresh call proxies through it to avos-licensing server-to-server, and only
// avos-leaf's own locally-issued session token ever reaches the browser. Same shape as
// avos-vault's/avos-deck's AuthController/IdentityLicensingClient. See lib/session.ts for the
// session cookie.
export const API_URL = process.env.API_INTERNAL_URL ?? "http://localhost:5490";

// Browser-reachable (unlike API_URL, which is the internal Node-to-.NET hop) — GET /api/auth/sso/start
// sends the *browser* here directly for the SSO redirect, so this must resolve from the user's
// machine, not just from inside this container/network.
export const LICENSING_PUBLIC_URL = process.env.LICENSING_PUBLIC_URL ?? "http://localhost:5090";

// The avos-leaf LicensedApplication's id in avos-licensing — not secret (it's the OAuth client_id,
// sent in a plain query string), but kept server-side since only the sso/start route needs it.
export const SSO_CLIENT_ID = process.env.SSO_CLIENT_ID ?? "";

// This app's own public origin, used to build the SSO redirect_uri and post-login redirect target.
// Deliberately not derived from the request (e.g. NextRequest.nextUrl.origin) — the standalone
// server binds 0.0.0.0, which leaks into that derivation and produces a redirect_uri that doesn't
// byte-for-byte match what's registered with avos-licensing, silently breaking the whole flow.
export const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL ?? "http://localhost:3200";
