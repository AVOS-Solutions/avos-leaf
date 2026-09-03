import { API_URL } from "./config";
import { internalApiDispatcher } from "./internalApiDispatcher";
import { requireAccessToken } from "./session";

export class NotSignedInError extends Error {}

/** Server-side fetch helper for talking to avos-leaf's own backend (Avos.Leaf.Api) with the
 *  current account's bearer token, over the same TLS-skip-verify internal hop every other
 *  server-to-server call in this app uses (see internalApiDispatcher's doc comment). Every
 *  documents/folders route handler under app/api/ goes through this rather than each reimplementing
 *  the auth-header/dispatcher boilerplate. */
export async function backendFetch(path: string, init: RequestInit = {}): Promise<Response> {
  let accessToken: string;
  try {
    accessToken = await requireAccessToken();
  } catch {
    throw new NotSignedInError();
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);

  return fetch(`${API_URL}${path}`, {
    ...init,
    headers,
    cache: "no-store",
    // @ts-expect-error -- dispatcher is an undici/Node fetch extension, not in the standard RequestInit typings
    dispatcher: internalApiDispatcher,
  });
}
