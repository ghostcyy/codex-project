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
        <div className="flex flex-col gap-5">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">
              Mipo AI Brief
            </p>
            <p className="mt-3 text-sm leading-7 text-[var(--muted)] md:text-base">
              当前已完成本地前后端联调、账号体系、RBAC 和资讯内容工作流。本地 PostgreSQL 已接入，数据可持久化保存。
            </p>
          </div>
          <a
            href="https://beian.miit.gov.cn/"
            target="_blank"
            rel="noopener noreferrer"
            className="icp-beian-link block text-center text-sm font-medium transition-colors"
          >
            工信部IPC备案 粤ICP备2025491967号-1
          </a>
        </div>
      </div>
    </footer>
  );
}
