import Link from "next/link";
import { notFound } from "next/navigation";
import { getNewsArticle } from "../../../lib/api";
import { formatDate } from "../../../lib/format";

export default async function NewsArticlePage({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const article = await getNewsArticle(id);

  if (!article) {
    notFound();
  }

  return (
    <div className="page-shell section-stack pb-12 pt-8">
      <section className="glass-panel reveal-up rounded-[40px] px-6 py-8 md:px-10 md:py-10">
        <div className="flex flex-wrap items-center gap-3">
          <span className="data-pill">{formatDate(article.publishDate)}</span>
          <span className="rounded-full bg-[var(--warm-soft)] px-4 py-2 text-sm font-semibold text-[var(--warm)]">
            {article.sourceName}
          </span>
        </div>
        <h1 className="display-title mt-5 max-w-4xl text-4xl leading-[0.98] font-semibold md:text-[64px]">
          {article.title}
        </h1>
        <p className="mt-5 max-w-3xl text-base leading-8 text-[var(--muted)]">{article.summary}</p>

        <div className="mt-7 flex flex-wrap gap-3">
          <a href={article.sourceUrl} target="_blank" rel="noreferrer" className="ghost-button text-sm font-medium">
            打开来源链接
          </a>
          <Link href="/news" className="soft-button text-sm font-medium">
            返回资讯列表
          </Link>
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <article className="surface-card reveal-up rounded-[34px] px-6 py-8 md:px-8">
          <div className="space-y-5 text-base leading-8 text-[var(--ink)]">
            {article.content.split("\n\n").map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
        </article>

        <aside className="space-y-6">
          <div className="secondary-card reveal-up rounded-[28px] px-5 py-5">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--muted)]">标签</p>
            <div className="mt-4 flex flex-wrap gap-2">
              {article.tags.map((tag) => (
                <span key={tag} className="data-pill">
                  {tag}
                </span>
              ))}
            </div>
          </div>

          <div className="secondary-card reveal-up rounded-[28px] px-5 py-5 text-sm leading-7 text-[var(--muted)]">
            <p className="font-semibold text-[var(--ink)]">编辑说明</p>
            <p className="mt-3">
              当前详情页已经接通真实数据库内容。后续如果继续增强，可以扩展相关文章推荐、内容摘要卡片和来源可信度说明。
            </p>
          </div>
        </aside>
      </section>
    </div>
  );
}
