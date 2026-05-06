import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getCurrentUser } from "../../../lib/server-auth";

export default async function HtmlPptV3Layout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent("/tools/html-ppt-v3")}`);
  }

  return children;
}
