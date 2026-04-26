import Link from "next/link";
import { ADMIN_ACCESS_PERMISSION, hasPermission } from "../lib/auth";
import { getCurrentUser } from "../lib/server-auth";
import { LogoutButton } from "./auth/logout-button";
import { SmartHeader } from "./smart-header";

export async function SiteHeader() {
  const user = await getCurrentUser();
  const canAccessAdmin = hasPermission(user, ADMIN_ACCESS_PERMISSION);

  return (
    <SmartHeader>
      <div className="page-shell flex flex-wrap items-center justify-between gap-5 py-4">
        <Link href="/" className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-[14px] bg-[var(--accent)] text-sm font-bold text-white shadow-sm">
            AI
          </div>
          <div>
            <div className="text-lg font-bold text-[var(--ink)]">Mipo Brief</div>
          </div>
        </Link>

        <nav className="flex flex-wrap items-center gap-6 text-sm font-medium text-[var(--muted)]">
          <div className="group relative">
            <Link href="/" className="hover:text-[var(--ink)] transition-colors py-2">
              首页
            </Link>
            <div className="absolute left-0 top-full h-4 min-w-[120px]" aria-hidden="true" />
            <div className="pointer-events-none invisible absolute left-0 top-full z-40 min-w-[120px] pt-2 opacity-0 transition duration-200 group-hover:pointer-events-auto group-hover:visible group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:visible group-focus-within:opacity-100">
              <div className="rounded-[16px] border border-[var(--line-strong)] bg-white p-2 shadow-[var(--shadow-float)]">
                <Link
                  href="/"
                  className="block rounded-[10px] px-4 py-2.5 text-sm text-[var(--ink)] hover:bg-[var(--bg-deep)] transition"
                >
                  首页
                </Link>
              </div>
            </div>
          </div>

          <div className="group relative">
            <Link href="/tools/html-ppt" className="hover:text-[var(--ink)] transition-colors py-2">
              HTML-PPT
            </Link>
            <div className="absolute left-0 top-full h-4 min-w-[140px]" aria-hidden="true" />
            <div className="pointer-events-none invisible absolute left-0 top-full z-40 min-w-[140px] pt-2 opacity-0 transition duration-200 group-hover:pointer-events-auto group-hover:visible group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:visible group-focus-within:opacity-100">
              <div className="rounded-[16px] border border-[var(--line-strong)] bg-white p-2 shadow-[var(--shadow-float)]">
                <Link
                  href="/tools/html-ppt"
                  className="block rounded-[10px] px-4 py-2.5 text-sm text-[var(--ink)] hover:bg-[var(--bg-deep)] transition"
                >
                  HTML-PPT
                </Link>
              </div>
            </div>
          </div>

          <div className="group relative">
            <Link href="/today" className="hover:text-[var(--ink)] transition-colors py-2">
              今日资讯
            </Link>
            <div className="absolute left-0 top-full h-4 min-w-[140px]" aria-hidden="true" />
            <div className="pointer-events-none invisible absolute left-0 top-full z-40 min-w-[140px] pt-2 opacity-0 transition duration-200 group-hover:pointer-events-auto group-hover:visible group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:visible group-focus-within:opacity-100">
              <div className="rounded-[16px] border border-[var(--line-strong)] bg-white p-2 shadow-[var(--shadow-float)]">
                <Link
                  href="/today"
                  className="block rounded-[10px] px-4 py-2.5 text-sm text-[var(--ink)] hover:bg-[var(--bg-deep)] transition"
                >
                  今日资讯
                </Link>
                <Link
                  href="/news"
                  className="mt-1 block rounded-[10px] px-4 py-2.5 text-sm text-[var(--ink)] hover:bg-[var(--bg-deep)] transition"
                >
                  历史资讯
                </Link>
              </div>
            </div>
          </div>

          <div className="group relative">
            <Link href="/tools/video-processing" className="hover:text-[var(--ink)] transition-colors py-2">
              实用工具
            </Link>
            <div className="absolute left-0 top-full h-4 min-w-[140px]" aria-hidden="true" />
            <div className="pointer-events-none invisible absolute left-0 top-full z-40 min-w-[140px] pt-2 opacity-0 transition duration-200 group-hover:pointer-events-auto group-hover:visible group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:visible group-focus-within:opacity-100">
              <div className="rounded-[16px] border border-[var(--line-strong)] bg-white p-2 shadow-[var(--shadow-float)]">
                <Link
                  href="/tools/video-processing"
                  className="block rounded-[10px] px-4 py-2.5 text-sm text-[var(--ink)] hover:bg-[var(--bg-deep)] transition"
                >
                  视频处理
                </Link>
              </div>
            </div>
          </div>

          <div className="ml-4 flex items-center gap-4">
            {user ? (
              <>
                {canAccessAdmin ? (
                  <Link href="/admin" className="text-[var(--ink)] hover:text-[var(--accent)] transition-colors">
                    后台管理
                  </Link>
                ) : null}
                <div className="flex items-center gap-3">
                  <span className="text-[var(--ink)] font-semibold">{user.displayName ?? user.username}</span>
                  <LogoutButton />
                </div>
              </>
            ) : (
              <>
                <Link
                  href="/register"
                  className="text-[var(--ink)] hover:text-[var(--accent)] font-medium transition-colors"
                >
                  注册
                </Link>
                <Link
                  href="/login"
                  className="text-[var(--accent)] hover:text-[var(--accent-strong)] font-semibold transition-colors"
                >
                  登录
                </Link>
              </>
            )}
          </div>
        </nav>
      </div>
    </SmartHeader>
  );
}
