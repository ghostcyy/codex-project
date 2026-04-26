import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const API_BASE_URL =
  process.env.API_BASE_URL ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  "http://localhost:4000/api";

const SESSION_COOKIE_NAME = "personal_ai_site_session";

async function withSessionHeaders(init: RequestInit = {}) {
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    return null;
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  return {
    ...init,
    headers,
    cache: "no-store" as const
  };
}

export async function GET() {
  const init = await withSessionHeaders();
  if (!init) {
    return NextResponse.json({ message: "请先登录后再访问 HTML-PPT 项目。" }, { status: 401 });
  }

  const response = await fetch(`${API_BASE_URL}/ppt/projects`, init).catch(() => null);
  if (!response) {
    return NextResponse.json({ message: "Backend is unavailable." }, { status: 503 });
  }

  const payload = await response.json().catch(() => null);
  return NextResponse.json(payload, { status: response.status });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const init = await withSessionHeaders({
    method: "POST",
    body: JSON.stringify(body ?? {})
  });

  if (!init) {
    return NextResponse.json({ message: "请先登录后再访问 HTML-PPT 项目。" }, { status: 401 });
  }

  const response = await fetch(`${API_BASE_URL}/ppt/projects`, init).catch(() => null);
  if (!response) {
    return NextResponse.json({ message: "Backend is unavailable." }, { status: 503 });
  }

  const payload = await response.json().catch(() => null);
  return NextResponse.json(payload, { status: response.status });
}
