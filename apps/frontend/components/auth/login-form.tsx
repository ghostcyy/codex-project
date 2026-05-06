"use client";

import type { SessionUser } from "../../lib/types";
import { resolveSignedInPath } from "../../lib/auth";
import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { RegisterForm } from "./register-form";

export function LoginForm({ nextPath = "/", showRegisterByDefault = false }: { nextPath?: string; showRegisterByDefault?: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [canCreateAccount, setCanCreateAccount] = useState(showRegisterByDefault);
  const [showRegister, setShowRegister] = useState(showRegisterByDefault);
  const [lastIdentifier, setLastIdentifier] = useState("");
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
    setLastIdentifier(payload.identifier);

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
        const isInvalidCredentials = response.status === 401;
        setError(
          isInvalidCredentials
            ? "没有匹配的账号密码，可能是账号不存在或密码不正确。"
            : result?.message ?? "登录失败，请检查账号和密码。"
        );
        setCanCreateAccount(isInvalidCredentials);
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
    <>
      <form className="mt-8 space-y-5" onSubmit={(event) => void onSubmit(event)}>
        <label className="block">
          <span className="mb-2 block text-sm font-medium text-[var(--ink)]">用户名或邮箱</span>
          <input
            name="identifier"
            className="text-input"
            placeholder="user01 或邮箱"
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
          <div className="rounded-[18px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            <p>{error}</p>
            {canCreateAccount ? (
              <button
                type="button"
                className="mt-3 font-semibold underline underline-offset-4"
                onClick={() => {
                  setShowRegister(true);
                }}
              >
                是否需要新建用户？
              </button>
            ) : null}
          </div>
        ) : null}

        <button
          type="submit"
          className="primary-button w-full py-3.5 text-sm disabled:translate-y-0 disabled:opacity-70"
          disabled={isSubmitting || isPending}
        >
          {isSubmitting || isPending ? "登录中..." : "登录"}
        </button>
      </form>

      {showRegister ? (
        <div className="mt-8 rounded-[28px] border border-[var(--line)] bg-white/70 px-5 py-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-[var(--ink)]">创建新用户</p>
              <p className="mt-1 text-xs leading-6 text-[var(--muted)]">新账号默认是普通用户，不会进入后台。</p>
            </div>
            <button
              type="button"
              className="text-sm font-semibold text-[var(--accent)] underline underline-offset-4"
              onClick={() => {
                setShowRegister(false);
              }}
            >
              收起
            </button>
          </div>
          <RegisterForm key={lastIdentifier} initialIdentifier={lastIdentifier} showLoginLink={false} />
        </div>
      ) : null}
    </>
  );
}
