import Link from "next/link";
import { formatDate } from "../../lib/format";
import { getAdminOverview, getAdminUsers, requireAdminUser } from "../../lib/server-auth";

export default async function AdminPage() {
  const user = await requireAdminUser("/admin");
  const overview = await getAdminOverview();
  const users = await getAdminUsers();

  if (!overview) {
    return (
      <div className="page-shell pb-12 pt-8">
        <section className="rounded-[36px] border border-rose-200 bg-rose-50 px-6 py-8 text-rose-700">
          管理后台暂时无法读取数据，请确认后端服务已经正常启动。
        </section>
      </div>
    );
  }

  return (
    <div className="page-shell section-stack pb-12 pt-8">
      <section className="glass-panel reveal-up rounded-[38px] px-6 py-8 md:px-8">
        <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="eyebrow">后台总览</div>
            <h1 className="display-title mt-5 text-4xl font-semibold md:text-6xl">Admin Console</h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-[var(--muted)] md:text-base">
              当前管理员为 {user.displayName ?? user.username}。账号体系、JWT 与 RBAC 已启用，资讯内容可直接通过后台进行管理。
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link href="/admin/news" className="primary-button text-sm">
              进入资讯后台
            </Link>
            <Link href="/admin/llm" className="ghost-button text-sm">
              模型配置
            </Link>
            <div className="rounded-full border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700">
              RBAC 已启用
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-6 md:grid-cols-3">
        <div className="surface-card reveal-up rounded-[28px] p-6">
          <p className="text-sm text-[var(--muted)]">资讯总量</p>
          <p className="mt-4 text-4xl font-semibold">{overview.totalArticles}</p>
        </div>
        <div className="surface-card reveal-up rounded-[28px] p-6">
          <p className="text-sm text-[var(--muted)]">已发布</p>
          <p className="mt-4 text-4xl font-semibold">{overview.publishedArticles}</p>
        </div>
        <div className="surface-card reveal-up rounded-[28px] p-6">
          <p className="text-sm text-[var(--muted)]">草稿</p>
          <p className="mt-4 text-4xl font-semibold">{overview.draftArticles}</p>
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="surface-card reveal-up rounded-[30px] px-6 py-6">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">当前重点</p>
          <ul className="mt-4 space-y-3 text-sm leading-7 text-[var(--ink)]">
            {overview.plannedModules.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>

        <div className="secondary-card reveal-up rounded-[30px] px-6 py-6">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">后续里程碑</p>
          <ul className="mt-4 space-y-3 text-sm leading-7 text-[var(--ink)]">
            {overview.pendingMilestones.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </section>

      <section className="surface-card reveal-up rounded-[32px] px-6 py-6">
        <div className="flex items-center justify-between gap-4">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[var(--muted)]">用户与角色</p>
          <span className="text-sm text-[var(--muted)]">{users?.length ?? 0} 位用户</span>
        </div>

        <div className="mt-5 overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="text-[var(--muted)]">
              <tr className="border-b border-[var(--line)]">
                <th className="pb-3 pr-4">用户</th>
                <th className="pb-3 pr-4">邮箱</th>
                <th className="pb-3 pr-4">角色</th>
                <th className="pb-3 pr-4">状态</th>
                <th className="pb-3 pr-4">最近登录</th>
              </tr>
            </thead>
            <tbody>
              {(users ?? []).map((item) => (
                <tr key={item.id} className="border-b border-[var(--line)] last:border-b-0">
                  <td className="py-4 pr-4 font-medium text-[var(--ink)]">
                    {item.displayName ?? item.username}
                    {item.mustChangePassword ? (
                      <span className="ml-2 rounded-full bg-amber-50 px-2 py-1 text-xs text-amber-700">
                        首次登录需改密
                      </span>
                    ) : null}
                  </td>
                  <td className="py-4 pr-4 text-[var(--muted)]">{item.email}</td>
                  <td className="py-4 pr-4 text-[var(--muted)]">{item.roles.join(", ")}</td>
                  <td className="py-4 pr-4 text-[var(--muted)]">{item.status}</td>
                  <td className="py-4 pr-4 text-[var(--muted)]">
                    {item.lastLoginAt ? formatDate(item.lastLoginAt) : "尚未登录"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
