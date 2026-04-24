import Link from "next/link";
import { NewsItemActions } from "../../../components/admin/news-item-actions";
import { formatDate } from "../../../lib/format";
import { getAdminNews, requireNewsManagerUser } from "../../../lib/server-auth";

function statusBadge(status: string) {
  if (status === "published") {
    return "bg-emerald-50 text-emerald-700 border-emerald-200";
  }

  if (status === "archived") {
    return "bg-amber-50 text-amber-700 border-amber-200";
  }

  return "bg-slate-100 text-slate-700 border-slate-200";
}

function statusLabel(status: string) {
  if (status === "published") {
    return "已发布";
  }

  if (status === "archived") {
    return "已下架";
  }

  return "草稿";
}

export default async function AdminNewsPage({
  searchParams
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await requireNewsManagerUser("/admin/news");
  const articles = await getAdminNews();
  const resolvedSearchParams = await searchParams;

  return (
    <div className="page-shell section-stack pb-12 pt-8">
      <section className="glass-panel reveal-up rounded-[38px] px-6 py-8 md:px-8">
        <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="eyebrow">资讯后台</div>
            <h1 className="display-title mt-5 text-4xl font-semibold md:text-6xl">News Studio</h1>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-[var(--muted)] md:text-base">
              当前登录用户 {user.displayName ?? user.username} 可以新建、编辑、发布、下架和删除资讯内容。
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link href="/admin" className="ghost-button text-sm font-medium">
              返回总览
            </Link>
            <Link href="/admin/news/new" className="primary-button text-sm">
              新建资讯
            </Link>
          </div>
        </div>
      </section>

      {resolvedSearchParams.error ? (
        <section className="rounded-[24px] border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">
          {resolvedSearchParams.error}
        </section>
      ) : null}

      <section className="grid gap-6 md:grid-cols-3">
        <div className="surface-card reveal-up rounded-[28px] p-6">
          <p className="text-sm text-[var(--muted)]">全部文章</p>
          <p className="mt-4 text-4xl font-semibold">{articles?.length ?? 0}</p>
        </div>
        <div className="surface-card reveal-up rounded-[28px] p-6">
          <p className="text-sm text-[var(--muted)]">已发布</p>
          <p className="mt-4 text-4xl font-semibold">
            {(articles ?? []).filter((item) => item.status === "published").length}
          </p>
        </div>
        <div className="surface-card reveal-up rounded-[28px] p-6">
          <p className="text-sm text-[var(--muted)]">草稿 / 下架</p>
          <p className="mt-4 text-4xl font-semibold">
            {(articles ?? []).filter((item) => item.status !== "published").length}
          </p>
        </div>
      </section>

      <section className="space-y-5">
        {(articles ?? []).map((article) => (
          <article
            key={article.id}
            className="surface-card reveal-up rounded-[30px] px-6 py-6 transition hover:-translate-y-1"
          >
            <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
              <div className="max-w-4xl">
                <div className="flex flex-wrap items-center gap-3">
                  <span
                    className={`rounded-full border px-3 py-1 text-xs font-semibold ${statusBadge(article.status)}`}
                  >
                    {statusLabel(article.status)}
                  </span>
                  <span className="data-pill">{formatDate(article.publishDate)}</span>
                  <span className="text-sm text-[var(--muted)]">Slug: {article.id}</span>
                </div>
                <h2 className="mt-4 text-2xl font-semibold md:text-3xl">{article.title}</h2>
                <p className="mt-4 text-sm leading-7 text-[var(--muted)] md:text-base">{article.summary}</p>
                <div className="mt-5 flex flex-wrap gap-2">
                  {article.tags.map((tag) => (
                    <span key={tag} className="data-pill">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>

              <div className="secondary-card rounded-[26px] px-5 py-5 text-sm text-[var(--muted)] lg:w-[320px]">
                <p className="text-xs font-semibold uppercase tracking-[0.24em]">来源</p>
                <p className="mt-3 text-base font-semibold text-[var(--ink)]">{article.sourceName}</p>
                <p className="mt-3">最近更新：{formatDate(article.updatedAt)}</p>
                <div className="mt-5">
                  <NewsItemActions article={article} redirectPath="/admin/news" />
                </div>
              </div>
            </div>
          </article>
        ))}
      </section>
    </div>
  );
}
