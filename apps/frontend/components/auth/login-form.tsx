"use client";

import type { SessionUser } from "../../lib/types";
import { resolveSignedInPath } from "../../lib/auth";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function LoginForm({ nextPath = "/admin" }: { nextPath?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isPending, startTransition] = useTransition();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    const formData = new FormData(event.currentTarget);

    const payload = {
      identifier: String(formData.get("identifier") ?? ""),
      password: String(formData.get("password") ?? "")
    };

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      const result = (await response.json().catch(() => null)) as
        | {
            message?: string;
            user?: SessionUser;
          }
        | null;

      if (!response.ok || !result?.user) {
        setError(result?.message ?? "登录失败，请检查账号和密码。");
        return;
      }

      const destination = resolveSignedInPath(result.user, nextPath);

      startTransition(() => {
        router.push(destination);
        router.refresh();
      });
    } catch {
      setError("登录服务暂时不可用，请稍后重试。");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="mt-8 space-y-5" onSubmit={(event) => void onSubmit(event)}>
      <label className="block">
        <span className="mb-2 block text-sm font-medium text-[var(--ink)]">用户名或邮箱</span>
        <input
          name="identifier"
          className="text-input"
          placeholder="admin 或 admin@example.com"
          autoComplete="username"
          required
        />
      </label>

      <label className="block">
        <span className="mb-2 block text-sm font-medium text-[var(--ink)]">密码</span>
        <input
          name="password"
          type="password"
          className="text-input"
          placeholder="输入登录密码"
          autoComplete="current-password"
          required
        />
      </label>

      {error ? (
        <p className="rounded-[18px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p>
      ) : null}

      <button
        type="submit"
        className="primary-button w-full py-3.5 text-sm disabled:translate-y-0 disabled:opacity-70"
        disabled={isSubmitting || isPending}
      >
        {isSubmitting || isPending ? "登录中..." : "登录后台"}
      </button>
    </form>
  );
}
