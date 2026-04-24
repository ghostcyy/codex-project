import Link from "next/link";
import { notFound } from "next/navigation";
import { NewsEditorForm } from "../../../../components/admin/news-editor-form";
import { NewsItemActions } from "../../../../components/admin/news-item-actions";
import { updateNewsArticleAction } from "../actions";
import { formatDate } from "../../../../lib/format";
import { getAdminNewsItem, requireNewsManagerUser } from "../../../../lib/server-auth";

function statusLabel(status: string) {
  if (status === "published") {
    return "已发布";
  }

  if (status === "archived") {
    return "已下架";
  }

  return "草稿";
}

export default async function AdminNewsEditPage({
  params,
  searchParams
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  await requireNewsManagerUser("/admin/news");
  const { id } = await params;
  const resolvedSearchParams = await searchParams;
  const article = await getAdminNewsItem(id);

  if (!article) {
    notFound();
  }

  return (
    <div className="page-shell section-stack pb-12 pt-8">
      <section className="glass-panel reveal-up rounded-[38px] px-6 py-8 md:px-8">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="eyebrow">编辑资讯</div>
            <h1 className="display-title mt-5 text-4xl font-semibold md:text-5xl">{article.title}</h1>
            <p className="mt-4 max-w-3xl text-sm leading-7 text-[var(--muted)] md:text-base">
              当前状态：{statusLabel(article.status)}。发布时间 {formatDate(article.publishDate)}，最后更新{" "}
              {formatDate(article.updatedAt)}。
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link href={`/news/${article.id}`} className="ghost-button text-sm font-medium">
              预览前台详情
            </Link>
          </div>
        </div>
      </section>

      {resolvedSearchParams.error ? (
        <section className="rounded-[24px] border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700">
          {resolvedSearchParams.error}
        </section>
      ) : null}

      {resolvedSearchParams.saved ? (
        <section className="rounded-[24px] border border-emerald-200 bg-emerald-50 px-5 py-4 text-sm text-emerald-700">
          资讯内容已保存。
        </section>
      ) : null}

      <section className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="surface-card reveal-up rounded-[36px] px-6 py-8 md:px-8">
          <NewsEditorForm
            mode="edit"
            article={article}
            submitAction={updateNewsArticleAction.bind(null, article.id)}
            errorMessage={resolvedSearchParams.error}
          />
        </div>

        <aside className="space-y-6">
          <div className="secondary-card reveal-up rounded-[28px] px-5 py-5">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">操作</p>
            <div className="mt-4">
              <NewsItemActions article={article} redirectPath={`/admin/news/${article.id}`} />
            </div>
          </div>

          <div className="secondary-card reveal-up rounded-[28px] px-5 py-5 text-sm leading-7 text-[var(--muted)]">
            <p className="font-semibold text-[var(--ink)]">编辑提示</p>
            <p className="mt-3">
              Slug 会影响前台详情页地址。标题、摘要、正文、来源和标签保存后会立即写入数据库，并同步影响前台展示内容。
            </p>
          </div>
        </aside>
      </section>
    </div>
  );
}
