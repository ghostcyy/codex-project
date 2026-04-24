"use client";

import { usePathname } from "next/navigation";

export function SiteFooter() {
  const pathname = usePathname();

  if (pathname.startsWith("/tools/html-ppt")) {
    return null;
  }

  return (
    <footer className="page-shell pb-10 pt-16">
      <div className="surface-card rounded-[30px] px-6 py-6 md:px-8">
        <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">
              Mipo AI Brief
            </p>
            <p className="mt-3 text-sm leading-7 text-[var(--muted)] md:text-base">
              当前已完成本地前后端联调、账号体系、RBAC 和资讯内容工作流。本地 PostgreSQL 已接入，数据可持久化保存。
            </p>
          </div>
          <p className="text-sm font-medium text-[var(--ink)]">Stack: Next.js 16 / NestJS 11 / PostgreSQL 16</p>
        </div>
      </div>
    </footer>
  );
}
