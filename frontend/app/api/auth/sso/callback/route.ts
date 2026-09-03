import { NextRequest, NextResponse } from "next/server";
import { API_URL, PUBLIC_APP_URL } from "@/lib/config";
import { internalApiDispatcher } from "@/lib/internalApiDispatcher";
import { setSession } from "@/lib/session";
import type { AuthResponse } from "@/lib/types";

const STATE_COOKIE = "avleaf_sso_state";

function failure() {
  const url = new URL("/login", PUBLIC_APP_URL);
  url.searchParams.set("error", "sso_failed");
  const response = NextResponse.redirect(url);
  response.cookies.delete(STATE_COOKIE);
  return response;
}

/** avos-licensing redirects the browser back here with ?code&state after GET /api/sso/authorize.
 * Exchanges the code server-to-server (never exposing it to the browser beyond this one redirect)
 * and, on success, sets avos-leaf's own local session — same shape as a normal password login. */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const stateCookie = request.cookies.get(STATE_COOKIE)?.value;
  if (!code || !state || !stateCookie) return failure();

  let parsed: { state: string; next: string };
  try {
    parsed = JSON.parse(stateCookie);
  } catch {
    return failure();
  }
  if (parsed.state !== state) return failure();

  const redirectUri = `${PUBLIC_APP_URL}/api/auth/sso/callback`;
  const apiResponse = await fetch(`${API_URL}/api/auth/sso/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, redirectUri }),
    cache: "no-store",
    // @ts-expect-error -- dispatcher is an undici/Node fetch extension, not in the standard RequestInit typings
    dispatcher: internalApiDispatcher,
  });
  if (!apiResponse.ok) return failure();

  const result = (await apiResponse.json()) as AuthResponse;
  await setSession(result);

  const response = NextResponse.redirect(new URL(parsed.next || "/documents", PUBLIC_APP_URL));
  response.cookies.delete(STATE_COOKIE);
  return response;
}
