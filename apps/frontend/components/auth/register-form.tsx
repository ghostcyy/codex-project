"use client";

import Link from "next/link";
import type { FormEvent } from "react";
import { useState } from "react";

type RegisterFormProps = {
  initialIdentifier?: string;
  showLoginLink?: boolean;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function deriveInitialValues(initialIdentifier?: string) {
  const value = initialIdentifier?.trim() ?? "";

  if (EMAIL_PATTERN.test(value)) {
    const username = value
      .split("@")[0]
      ?.replace(/[^a-zA-Z0-9_-]+/g, "_")
      .slice(0, 32);

    return {
      email: value.toLowerCase(),
      username: username && username.length >= 3 ? username : ""
    };
  }

  return {
    email: "",
    username: /^[a-zA-Z0-9_-]{3,32}$/.test(value) ? value : ""
  };
}

export function RegisterForm({ initialIdentifier, showLoginLink = true }: RegisterFormProps) {
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const initialValues = deriveInitialValues(initialIdentifier);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    setIsSubmitting(true);
    const form = event.currentTarget;
    const formData = new FormData(form);
    const email = String(formData.get("email") ?? "").trim().toLowerCase();
    const password = String(formData.get("password") ?? "");
    const confirmPassword = String(formData.get("confirmPassword") ?? "");

    if (!EMAIL_PATTERN.test(email)) {
      setError("请输入有效邮箱地址，例如 name@example.com。");
      setIsSubmitting(false);
      return;
    }

    if (password !== confirmPassword) {
      setError("两次输入的密码不一致，请重新检查。");
      setIsSubmitting(false);
      return;
    }

    const payload = {
      username: String(formData.get("username") ?? ""),
      displayName: String(formData.get("displayName") ?? ""),
      email,
      password
    };

    try {
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

      form.reset();
      setSuccess("注册成功。新账号默认是普通用户，不会自动进入后台，请前往登录页手动登录。");
    } catch {
      setError("注册服务暂时不可用，请稍后重试。");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form className="mt-8 grid gap-5" onSubmit={(event) => void onSubmit(event)}>
      <label className="block">
        <span className="mb-2 block text-sm font-medium text-[var(--ink)]">用户名</span>
        <input name="username" className="text-input" autoComplete="username" defaultValue={initialValues.username} required />
      </label>

      <label className="block">
        <span className="mb-2 block text-sm font-medium text-[var(--ink)]">显示名称</span>
        <input name="displayName" className="text-input" placeholder="可选，用于前台展示" />
      </label>

      <label className="block">
        <span className="mb-2 block text-sm font-medium text-[var(--ink)]">邮箱</span>
        <input
          name="email"
          type="email"
          inputMode="email"
          className="text-input"
          autoComplete="email"
          defaultValue={initialValues.email}
          pattern="^[^\s@]+@[^\s@]+\.[^\s@]+$"
          title="请输入有效邮箱地址，例如 name@example.com"
          required
        />
      </label>

      <label className="block">
        <span className="mb-2 block text-sm font-medium text-[var(--ink)]">密码</span>
        <input
          name="password"
          type="password"
          className="text-input"
          autoComplete="new-password"
          minLength={8}
          required
        />
      </label>

      <label className="block">
        <span className="mb-2 block text-sm font-medium text-[var(--ink)]">确认密码</span>
        <input
          name="confirmPassword"
          type="password"
          className="text-input"
          autoComplete="new-password"
          minLength={8}
          required
        />
      </label>

      {error ? (
        <p className="rounded-[18px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p>
      ) : null}
      {success ? (
        <p className="rounded-[18px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {success}
          {showLoginLink ? (
            <>
              {" "}
              <Link href="/login?registered=1" className="font-semibold underline underline-offset-4">
                前往登录
              </Link>
            </>
          ) : null}
        </p>
      ) : null}

      <button
        type="submit"
        className="primary-button w-full py-3.5 text-sm disabled:translate-y-0 disabled:opacity-70"
        disabled={isSubmitting}
      >
        {isSubmitting ? "提交中..." : "创建账号"}
      </button>
    </form>
  );
}
