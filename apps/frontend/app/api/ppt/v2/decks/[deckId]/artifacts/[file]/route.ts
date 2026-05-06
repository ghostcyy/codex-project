import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const API_BASE_URL =
  process.env.API_BASE_URL ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  "http://localhost:4000/api";

const SESSION_COOKIE_NAME = "personal_ai_site_session";

export async function GET(_request: Request, context: { params: Promise<{ deckId: string; file: string }> }) {
  const { deckId, file } = await context.params;
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }
  const response = await fetch(`${API_BASE_URL}/ppt/v2/decks/${encodeURIComponent(deckId)}/artifacts/${encodeURIComponent(file)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store"
  }).catch(() => null);
  if (!response) {
    return NextResponse.json({ message: "Backend is unavailable." }, { status: 503 });
  }
  return new Response(response.body, {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("Content-Type") ?? "application/octet-stream",
      "Content-Disposition": response.headers.get("Content-Disposition") ?? "inline"
    }
  });
}
