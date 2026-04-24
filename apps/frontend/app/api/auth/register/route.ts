import { NextResponse } from "next/server";

const API_BASE_URL =
  process.env.API_BASE_URL ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  "http://localhost:4000/api";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

  if (!body) {
    return NextResponse.json({ message: "Invalid request body." }, { status: 400 });
  }

  const response = await fetch(`${API_BASE_URL}/auth/register`, {
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

  const payload = (await response.json().catch(() => null)) as { message?: string } | null;

  if (!response.ok) {
    return NextResponse.json(
      { message: payload?.message ?? "Registration failed." },
      { status: response.status || 500 }
    );
  }

  return NextResponse.json(payload, { status: response.status });
}

