import { NextRequest, NextResponse } from "next/server";
import { backendFetch, NotSignedInError } from "@/lib/backendClient";

/** Streams a document's decrypted PDF bytes down to the browser (GET, for pdf.js to render) and
 *  accepts a saved-back edited copy (PUT, pdf-lib's own output — see DocumentEditor.tsx). Kept as
 *  its own route rather than folded into the generic JSON proxy since both directions here move
 *  raw binary PDF content, not JSON. */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let response: Response;
  try {
    response = await backendFetch(`/api/documents/${id}/content`);
  } catch (err) {
    if (err instanceof NotSignedInError) {
      return NextResponse.json({ message: "Not signed in." }, { status: 401 });
    }
    throw err;
  }

  if (!response.ok) {
    return NextResponse.json({ message: "Could not load that document." }, { status: response.status });
  }

  return new NextResponse(response.body, {
    status: 200,
    headers: { "Content-Type": "application/pdf" },
  });
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const incoming = await request.formData();
  const file = incoming.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ message: "Missing file." }, { status: 400 });
  }

  const form = new FormData();
  form.append("file", file, file instanceof File ? file.name : "document.pdf");

  let response: Response;
  try {
    response = await backendFetch(`/api/documents/${id}/content`, { method: "PUT", body: form });
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
