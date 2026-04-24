"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

export function LogoutButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  async function logout() {
    await fetch("/api/auth/logout", {
      method: "POST"
    });

    startTransition(() => {
      router.push("/");
      router.refresh();
    });
  }

  return (
    <button
      type="button"
      onClick={() => {
        void logout();
      }}
      className="ghost-button px-4 py-2.5 text-sm font-medium"
      disabled={isPending}
    >
      {isPending ? "退出中..." : "退出"}
    </button>
  );
}
