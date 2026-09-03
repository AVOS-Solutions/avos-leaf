import { NextRequest, NextResponse } from "next/server";
import { LICENSING_PUBLIC_URL, PUBLIC_APP_URL, SSO_CLIENT_ID } from "@/lib/config";

const STATE_COOKIE = "avleaf_sso_state";

/** Entry point for "Sign in with AVOS": redirects the browser to avos-licensing's own
 * GET /api/sso/authorize. If the browser already carries a live avos-licensing session (from this
 * or any other AVOS product), that completes silently with no login form shown at all. The `state`
 * cookie is this request's own CSRF guard, checked again in ./callback. */
export async function GET(request: NextRequest) {
  const next = request.nextUrl.searchParams.get("next") ?? "/documents";
  const state = crypto.randomUUID();
  const redirectUri = `${PUBLIC_APP_URL}/api/auth/sso/callback`;

  const authorizeUrl = new URL("/api/sso/authorize", LICENSING_PUBLIC_URL);
  authorizeUrl.searchParams.set("client_id", SSO_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("state", state);

  const response = NextResponse.redirect(authorizeUrl);
  response.cookies.set(STATE_COOKIE, JSON.stringify({ state, next }), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 300,
  });
  return response;
}
