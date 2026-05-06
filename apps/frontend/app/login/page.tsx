import { redirect } from "next/navigation";
import { LoginForm } from "../../components/auth/login-form";
import { getCurrentUser } from "../../lib/server-auth";
import { resolveSignedInPath } from "../../lib/auth";

export default async function LoginPage({
  searchParams
}: {
  searchParams: Promise<{ next?: string; registered?: string; create?: string }>;
}) {
  const resolvedSearchParams = await searchParams;
  const user = await getCurrentUser();

  if (user) {
    redirect(resolveSignedInPath(user, resolvedSearchParams.next));
  }

  return (
    <div className="page-shell pb-12 pt-8">
      <section className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="glass-panel reveal-up rounded-[38px] px-6 py-8 md:px-8">
          <div className="eyebrow">账户登录</div>
          <h1 className="display-title mt-5 text-4xl font-semibold md:text-5xl">欢迎回来</h1>
          <p className="mt-4 text-sm leading-7 text-[var(--muted)] md:text-base">
            登录后可以使用 HTML-PPT、视频处理等工具。HTML-PPT 只需要普通用户账号，不要求管理员身份。
          </p>
          <div className="mt-6 rounded-[26px] border border-[rgba(15,118,110,0.18)] bg-[var(--accent-softer)] px-5 py-5 text-sm leading-7 text-[var(--accent-strong)]">
            <p className="font-semibold">普通用户入口</p>
            <p className="mt-2">如果你是从 HTML-PPT 跳转过来，登录成功后会回到对应的 HTML-PPT 页面。</p>
          </div>
        </div>

        <div className="surface-card reveal-up rounded-[38px] px-6 py-8 md:px-8">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">Sign In</p>
          {resolvedSearchParams.registered === "1" ? (
            <p className="mt-5 rounded-[18px] border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
              注册成功，请使用新账号登录。
            </p>
          ) : null}
          <LoginForm nextPath={resolvedSearchParams.next} showRegisterByDefault={resolvedSearchParams.create === "1"} />
        </div>
      </section>
    </div>
  );
}
