import { cookies } from "next/headers";
import { API_URL } from "./config";
import { internalApiDispatcher } from "./internalApiDispatcher";
import { decodeJwtExpiryMs } from "./jwt";
import type { AuthResponse, UserSummary } from "./types";

const REFRESH_SKEW_MS = 30_000;

// Distinct cookie names from avos-licensing/avos-deck/avos-vault (avlic_*/avdeck_*/avvault_*) so
// the apps can be served from the same parent domain without their sessions colliding.
const ACCESS_COOKIE = "avleaf_access_token";
const REFRESH_COOKIE = "avleaf_refresh_token";
const USER_COOKIE = "avleaf_user";

const baseCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

export const SESSION_COOKIE_NAMES = {
  access: ACCESS_COOKIE,
  refresh: REFRESH_COOKIE,
  user: USER_COOKIE,
} as const;

export async function setSession(auth: AuthResponse) {
  const store = await cookies();
  store.set(ACCESS_COOKIE, auth.accessToken, {
    ...baseCookieOptions,
    expires: new Date(auth.accessTokenExpiresAt),
  });
  store.set(REFRESH_COOKIE, auth.refreshToken, {
    ...baseCookieOptions,
    maxAge: 60 * 60 * 24 * 7,
  });
  store.set(USER_COOKIE, JSON.stringify(auth.account), {
    ...baseCookieOptions,
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function clearSession() {
  const store = await cookies();
  store.delete(ACCESS_COOKIE);
  store.delete(REFRESH_COOKIE);
  store.delete(USER_COOKIE);
}

export async function getAccessToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(ACCESS_COOKIE)?.value;
}

export async function getRefreshToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(REFRESH_COOKIE)?.value;
}

export async function getCurrentUser(): Promise<UserSummary | null> {
  const store = await cookies();
  const raw = store.get(USER_COOKIE)?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UserSummary;
  } catch {
    return null;
  }
}

/** Returns a currently-valid avos-leaf access token for the signed-in account, refreshing it
 *  first if it's expiring soon. Every server-side route handler that calls this app's own backend
 *  (e.g. the documents/folders proxy routes) uses this rather than reading the cookie directly, so
 *  a request never fails just because the access token happened to expire mid-session. */
export async function requireAccessToken(): Promise<string> {
  const accessToken = await getAccessToken();
  const refreshToken = await getRefreshToken();
  if (!accessToken && !refreshToken) throw new Error("Not signed in.");

  const expiryMs = accessToken ? decodeJwtExpiryMs(accessToken) : null;
  const isExpiringSoon = !expiryMs || expiryMs - Date.now() < REFRESH_SKEW_MS;
  if (accessToken && !isExpiringSoon) return accessToken;

  if (!refreshToken) throw new Error("Not signed in.");

  const response = await fetch(`${API_URL}/api/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken }),
    cache: "no-store",
    // @ts-expect-error -- dispatcher is an undici/Node fetch extension, not in the standard RequestInit typings
    dispatcher: internalApiDispatcher,
  });

  if (!response.ok) {
    await clearSession();
    throw new Error("Not signed in.");
  }

  const auth = (await response.json()) as AuthResponse;
  await setSession(auth);
  return auth.accessToken;
}
