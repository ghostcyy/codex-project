import { NextResponse } from "next/server";
import { getSessionCookieName } from "../../../../lib/server-auth";

function shouldUseSecureCookie(request: Request) {
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedProto) {
    return forwardedProto
      .split(",")
      .some((item) => item.trim().toLowerCase() === "https");
  }

  return new URL(request.url).protocol === "https:";
}

export async function POST(request: Request) {
  const response = NextResponse.json({ success: true });
  response.cookies.set(getSessionCookieName(), "", {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookie(request),
    path: "/",
    maxAge: 0
  });

  return response;
}
