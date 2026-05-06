import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getCurrentUser } from "../../../lib/server-auth";

export default async function VideoProcessingLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();

  if (!user) {
    redirect(`/login?next=${encodeURIComponent("/tools/video-processing")}`);
  }

  return children;
}
