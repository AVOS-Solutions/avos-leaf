import { NextRequest, NextResponse } from "next/server";
import { API_URL } from "@/lib/config";
import { internalApiDispatcher } from "@/lib/internalApiDispatcher";
import { setSession } from "@/lib/session";
import type { AuthResponse } from "@/lib/types";

// Completes a 2FA login: exchanges the challenge token + authenticator code for a real session.
export async function POST(request: NextRequest) {
  const body = await request.json();

  const apiResponse = await fetch(`${API_URL}/api/auth/2fa/verify-login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    // @ts-expect-error -- dispatcher is an undici/Node fetch extension, not in the standard RequestInit typings
    dispatcher: internalApiDispatcher,
  });

  if (!apiResponse.ok) {
    const error = await apiResponse.json().catch(() => ({ message: "Verification failed." }));
    return NextResponse.json(error, { status: apiResponse.status });
  }

  const result = (await apiResponse.json()) as AuthResponse;
  await setSession(result);
  return NextResponse.json({ user: result.account });
}
