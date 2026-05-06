import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const API_BASE_URL =
  process.env.API_BASE_URL ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  "http://localhost:4000/api";

const SESSION_COOKIE_NAME = "personal_ai_site_session";

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  const response = await fetch(`${API_BASE_URL}/ppt/v2/decks/jobs/${encodeURIComponent(jobId)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store"
  }).catch(() => null);

  if (!response) {
    return NextResponse.json({ message: "Backend is unavailable." }, { status: 503 });
  }

  const text = await response.text().catch(() => "");
  const payload = parseJson(text);
  if (payload && typeof payload === "object") {
    return NextResponse.json(payload, { status: response.status });
  }
  return NextResponse.json(
    {
      message: response.ok ? "HTML-PPT v2 job returned a non-JSON response." : `Backend returned ${response.status}.`,
      detail: text.slice(0, 2000)
    },
    { status: response.status }
  );
}

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}
