import { NextRequest, NextResponse } from "next/server";
import { API_URL } from "@/lib/config";
import { internalApiDispatcher } from "@/lib/internalApiDispatcher";
import { setSession } from "@/lib/session";
import type { AuthResponse, TwoFactorChallengeResponse } from "@/lib/types";

// Proxies login to the avos-licensing API (Deck's identity provider) and, on success, stores the
// returned tokens in Deck's own httpOnly cookies.
export async function POST(request: NextRequest) {
  const body = await request.json();

  const apiResponse = await fetch(`${API_URL}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    // @ts-expect-error -- dispatcher is an undici/Node fetch extension, not in the standard RequestInit typings
    dispatcher: internalApiDispatcher,
  });

  if (!apiResponse.ok) {
    const error = await apiResponse.json().catch(() => ({ message: "Login failed." }));
    return NextResponse.json(error, { status: apiResponse.status });
  }

  const result = (await apiResponse.json()) as AuthResponse | TwoFactorChallengeResponse;

  // A correct password against a 2FA-enabled account — no session cookie yet; the challenge token
  // is handed back to the browser and must be completed via /api/auth/2fa/verify.
  if ("requiresTwoFactor" in result) {
    return NextResponse.json(result);
  }

  await setSession(result);
  return NextResponse.json({ user: result.account });
}
