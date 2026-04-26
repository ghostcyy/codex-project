import { NextResponse } from "next/server";
import { getSessionCookieName } from "../../../../lib/server-auth";
import type { LoginResponse } from "../../../../lib/types";

const API_BASE_URL =
  process.env.API_BASE_URL ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  "http://localhost:4000/api";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  if (!body) {
    return NextResponse.json({ message: "Invalid request body." }, { status: 400 });
  }

  const response = await fetch(`${API_BASE_URL}/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    cache: "no-store"
  }).catch(() => null);

  if (!response) {
    return NextResponse.json({ message: "Backend auth service is unavailable." }, { status: 503 });
  }

  const payload = (await response.json().catch(() => null)) as LoginResponse | { message?: string } | null;

  if (!response.ok || !payload || !("accessToken" in payload)) {
    return NextResponse.json(
      { message: (payload as { message?: string } | null)?.message ?? "Login failed." },
      { status: response.status || 500 }
    );
  }

  const nextResponse = NextResponse.json({ user: payload.user });
  nextResponse.cookies.set(getSessionCookieName(), payload.accessToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7
  });

  return nextResponse;
}
