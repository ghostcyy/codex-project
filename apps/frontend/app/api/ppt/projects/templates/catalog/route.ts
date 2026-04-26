import { NextResponse } from "next/server";

const API_BASE_URL =
  process.env.API_BASE_URL ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  "http://localhost:4000/api";

export async function GET() {
  const response = await fetch(`${API_BASE_URL}/ppt/templates/catalog`, {
    cache: "no-store",
  }).catch(() => null);

  if (!response) {
    return NextResponse.json({ message: "Backend is unavailable." }, { status: 503 });
  }

  const payload = await response.json().catch(() => null);
  return NextResponse.json(payload, { status: response.status });
}
