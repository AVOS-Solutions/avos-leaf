/** Reads the `exp` claim without verifying the signature — used only for UX (deciding whether
 *  to proactively refresh). The avos-licensing .NET API is the sole authority that verifies JWT
 *  signatures. */
export function decodeJwtExpiryMs(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    const json = Buffer.from(payload, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as { exp?: number };
    return typeof parsed.exp === "number" ? parsed.exp * 1000 : null;
  } catch {
    return null;
  }
}
