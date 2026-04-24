"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FormEvent } from "react";
import { useState, useTransition } from "react";

export function RegisterForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    const formData = new FormData(event.currentTarget);

    const payload = {
      username: String(formData.get("username") ?? ""),
      displayName: String(formData.get("displayName") ?? ""),
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? "")
    };

    const response = await fetch("/api/auth/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const result = (await response.json().catch(() => null)) as { message?: string } | null;

    if (!response.ok) {
      setError(result?.message ?? "注册失败，请检查输入内容。");
      return;
    }

    setSuccess("注册成功，正在跳转到登录页。");
    startTransition(() => {
      router.push("/login");
      router.refresh();
    });
  }

  return (
    <form className="mt-8 grid gap-5" onSubmit={(event) => void onSubmit(event)}>
      <label className="block">
        <span className="mb-2 block text-sm font-medium text-[var(--ink)]">用户名</span>
        <input name="username" className="text-input" autoComplete="username" required />
      </label>

      <label className="block">
        <span className="mb-2 block text-sm font-medium text-[var(--ink)]">显示名称</span>
        <input name="displayName" className="text-input" placeholder="可选，用于前台展示" />
      </label>

      <label className="block">
        <span className="mb-2 block text-sm font-medium text-[var(--ink)]">邮箱</span>
        <input name="email" type="email" className="text-input" autoComplete="email" required />
      </label>

      <label className="block">
        <span className="mb-2 block text-sm font-medium text-[var(--ink)]">密码</span>
        <input name="password" type="password" className="text-input" autoComplete="new-password" required />
      </label>

      {error ? (
        <p className="rounded-[18px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p>
      ) : null}
      {success ? (
        <p className="rounded-[18px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {success}{" "}
          <Link href="/login" className="font-semibold underline underline-offset-4">
            前往登录
          </Link>
        </p>
      ) : null}

      <button
        type="submit"
        className="primary-button w-full py-3.5 text-sm disabled:translate-y-0 disabled:opacity-70"
        disabled={isPending}
      >
        {isPending ? "提交中..." : "创建账号"}
      </button>
    </form>
  );
}
