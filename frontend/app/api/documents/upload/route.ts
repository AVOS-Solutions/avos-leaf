import { NextRequest, NextResponse } from "next/server";
import { backendFetch, NotSignedInError } from "@/lib/backendClient";

/** Uploads a new PDF (multipart) — kept as its own route rather than folded into the generic JSON
 *  proxy since the request body here is a file, not JSON. */
export async function POST(request: NextRequest) {
  const incoming = await request.formData();
  const file = incoming.get("file");
  const folderId = incoming.get("folderId");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ message: "Missing file." }, { status: 400 });
  }

  const form = new FormData();
  form.append("file", file, file instanceof File ? file.name : "document.pdf");
  if (typeof folderId === "string" && folderId) form.append("folderId", folderId);

  let response: Response;
  try {
    response = await backendFetch("/api/documents/upload", { method: "POST", body: form });
  } catch (err) {
    if (err instanceof NotSignedInError) {
      return NextResponse.json({ message: "Not signed in." }, { status: 401 });
    }
    throw err;
  }

  const text = await response.text();
  return new NextResponse(text || null, {
    status: response.status,
    headers: text ? { "Content-Type": "application/json" } : undefined,
  });
}
