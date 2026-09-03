import { NextRequest, NextResponse } from "next/server";
import { API_URL } from "@/lib/config";
import { internalApiDispatcher } from "@/lib/internalApiDispatcher";
import { setSession } from "@/lib/session";
import type { AuthResponse } from "@/lib/types";

// Sign up on avos-licensing by claiming a license key (its signup requires one). Deck reuses that
// flow verbatim so a customer who was issued a Deck key can create their account here.
export async function POST(request: NextRequest) {
  const body = await request.json();

  const apiResponse = await fetch(`${API_URL}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
    // @ts-expect-error -- dispatcher is an undici/Node fetch extension, not in the standard RequestInit typings
    dispatcher: internalApiDispatcher,
  });

  if (!apiResponse.ok) {
    const error = await apiResponse.json().catch(() => ({ message: "Sign up failed." }));
    return NextResponse.json(error, { status: apiResponse.status });
  }

  const result = (await apiResponse.json()) as AuthResponse;
  await setSession(result);
  return NextResponse.json({ user: result.account });
}
