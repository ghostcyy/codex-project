import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const API_BASE_URL =
  process.env.API_BASE_URL ??
  process.env.NEXT_PUBLIC_API_BASE_URL ??
  "http://localhost:4000/api";
const SESSION_COOKIE_NAME = "personal_ai_site_session";

type RouteContext = { params: Promise<{ path?: string[] }> | { path?: string[] } };

export async function GET(request: Request, context: RouteContext) {
  return proxyRequest(request, context);
}

export async function POST(request: Request, context: RouteContext) {
  return proxyRequest(request, context);
}

export async function PATCH(request: Request, context: RouteContext) {
  return proxyRequest(request, context);
}

export async function DELETE(request: Request, context: RouteContext) {
  return proxyRequest(request, context);
}

async function proxyRequest(request: Request, context: RouteContext) {
  const params = await context.params;
  const path = (params.path ?? []).map(encodeURIComponent).join("/");
  const sourceUrl = new URL(request.url);
  const targetUrl = `${API_BASE_URL}/html-ppt-v3/${path}${sourceUrl.search}`;
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!token) {
    return NextResponse.json({ message: "Unauthorized" }, { status: 401 });
  }

  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);
  headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
    cache: "no-store"
  }).catch(() => null);

  if (!response) {
    return NextResponse.json({ message: "Backend is unavailable." }, { status: 503 });
  }

  const responseHeaders = new Headers();
  const passthroughHeaders = ["content-type", "content-disposition", "cache-control"];
  for (const name of passthroughHeaders) {
    const value = response.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }

  return new Response(response.body, {
    status: response.status,
    headers: responseHeaders
  });
}
