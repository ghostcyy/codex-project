import { NextResponse } from "next/server";
import { getSessionCookieName } from "../../../../lib/server-auth";

export async function POST() {
  const response = NextResponse.json({ success: true });
  response.cookies.set(getSessionCookieName(), "", {
    httpOnly: true,
    sameSite: "lax",
    secure: false,
    path: "/",
    maxAge: 0
  });

  return response;
}

