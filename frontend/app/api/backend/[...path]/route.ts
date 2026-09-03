import { NextRequest, NextResponse } from "next/server";
import { backendFetch, NotSignedInError } from "@/lib/backendClient";

/** Generic JSON proxy for every avos-leaf backend endpoint under /api/folders and /api/documents
 *  that is a plain "forward the JSON body (if any), forward the JSON response" call — list,
 *  create, rename, move, star, trash, restore, delete-forever, duplicate, page-count. Nothing here
 *  sets cookies or otherwise needs Next.js-side logic (unlike the auth routes), so one route
 *  handler for the whole shape is simpler to maintain than one file per endpoint. The two binary
 *  endpoints (reading/writing raw PDF bytes) have their own dedicated routes — see
 *  app/api/documents/[id]/content and app/api/documents/upload — since those need a different
 *  content type and can't just pass a JSON body/response through. */
async function forward(request: NextRequest, path: string[]) {
  const search = request.nextUrl.search;
  const hasBody = request.method !== "GET" && request.method !== "HEAD" && request.method !== "DELETE";
  let body: string | undefined;
  if (hasBody) {
    const text = await request.text();
    body = text.length > 0 ? text : undefined;
  }

  let response: Response;
  try {
    response = await backendFetch(`/api/${path.join("/")}${search}`, {
      method: request.method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body,
    });
  } catch (err) {
    if (err instanceof NotSignedInError) {
      return NextResponse.json({ message: "Not signed in." }, { status: 401 });
    }
    throw err;
  }

  if (response.status === 204) return new NextResponse(null, { status: 204 });

  const text = await response.text();
  if (!text) return new NextResponse(null, { status: response.status });
  return new NextResponse(text, {
    status: response.status,
    headers: { "Content-Type": "application/json" },
  });
}

type RouteParams = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  return forward(request, (await params).path);
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  return forward(request, (await params).path);
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  return forward(request, (await params).path);
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  return forward(request, (await params).path);
}
