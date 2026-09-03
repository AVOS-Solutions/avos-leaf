import { NextRequest, NextResponse } from "next/server";
import { API_URL } from "@/lib/config";
import { internalApiDispatcher } from "@/lib/internalApiDispatcher";
import { decodeJwtExpiryMs } from "@/lib/jwt";
import { SESSION_COOKIE_NAMES } from "@/lib/session";
import type { AuthResponse } from "@/lib/types";

// Next 16 edge middleware (named proxy.ts in this Next version, matching avos-erp/avos-licensing/
// avos-deck). Proactively refreshes an expiring access token against avos-leaf's own backend
// (which relays to avos-licensing internally) so Server Components never run with a stale token,
// and bounces unauthenticated requests into the SSO chain.
const PUBLIC_PREFIXES = ["/login", "/signup"];
const REFRESH_SKEW_MS = 30_000;

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (isPublic) {
    return NextResponse.next();
  }

  const accessToken = request.cookies.get(SESSION_COOKIE_NAMES.access)?.value;
  const refreshToken = request.cookies.get(SESSION_COOKIE_NAMES.refresh)?.value;
  const expiryMs = accessToken ? decodeJwtExpiryMs(accessToken) : null;
  const isExpiringSoon = !expiryMs || expiryMs - Date.now() < REFRESH_SKEW_MS;

  if (accessToken && !isExpiringSoon) {
    return NextResponse.next();
  }

  if (!refreshToken) {
    return redirectToSso(request);
  }

  const refreshed = await fetch(`${API_URL}/api/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
    cache: "no-store",
    // @ts-expect-error -- dispatcher is an undici/Node fetch extension, not in the standard RequestInit typings
    dispatcher: internalApiDispatcher,
  });

  if (!refreshed.ok) {
    const response = redirectToSso(request);
    response.cookies.delete(SESSION_COOKIE_NAMES.access);
    response.cookies.delete(SESSION_COOKIE_NAMES.refresh);
    response.cookies.delete(SESSION_COOKIE_NAMES.user);
    return response;
  }

  const auth = (await refreshed.json()) as AuthResponse;
  const response = NextResponse.next();
  response.cookies.set(SESSION_COOKIE_NAMES.access, auth.accessToken, {
    ...cookieOptions,
    expires: new Date(auth.accessTokenExpiresAt),
  });
  response.cookies.set(SESSION_COOKIE_NAMES.refresh, auth.refreshToken, {
    ...cookieOptions,
    maxAge: 60 * 60 * 24 * 7,
  });
  response.cookies.set(SESSION_COOKIE_NAMES.user, JSON.stringify(auth.account), {
    ...cookieOptions,
    maxAge: 60 * 60 * 24 * 7,
  });
  return response;
}

/** Sends straight into the SSO chain (GET /api/auth/sso/start) rather than stopping at our own
 *  /login page first — if the browser already has a live avos-licensing session, that chain
 *  completes with zero visible pages. /login itself still exists and still works for direct
 *  navigation or the "use email and password instead" fallback. */
function redirectToSso(request: NextRequest) {
  const url = request.nextUrl.clone();
  url.pathname = "/api/auth/sso/start";
  url.search = "";
  url.searchParams.set("next", request.nextUrl.pathname);
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!login|signup|api|_next/static|_next/image|favicon.ico).*)"],
};
