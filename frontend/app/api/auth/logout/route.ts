import { NextResponse } from "next/server";
import { API_URL } from "@/lib/config";
import { internalApiDispatcher } from "@/lib/internalApiDispatcher";
import { clearSession, getAccessToken, getRefreshToken } from "@/lib/session";

export async function POST() {
  const accessToken = await getAccessToken();
  const refreshToken = await getRefreshToken();

  if (accessToken && refreshToken) {
    await fetch(`${API_URL}/api/auth/logout`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ refreshToken }),
      cache: "no-store",
      // @ts-expect-error -- dispatcher is an undici/Node fetch extension, not in the standard RequestInit typings
      dispatcher: internalApiDispatcher,
    }).catch(() => {
      // Best-effort server-side revoke; the cookie clear below is what actually ends the session.
    });
  }

  await clearSession();
  return NextResponse.json({ ok: true });
}
