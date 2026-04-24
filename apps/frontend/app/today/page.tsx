import Link from "next/link";
import { getHealth, getTodayNews } from "../../lib/api";
import { formatDate } from "../../lib/format";

export default async function TodayPage() {
  const [todayNews, health] = await Promise.all([getTodayNews(), getHealth()]);

  return (
    <div className="page-shell pb-24 pt-12 md:pt-20">
      <section className="flex flex-col items-start gap-16 reveal-up lg:flex-row lg:gap-24">
        <div className="flex-1 space-y-6">
          <div className="eyebrow mb-2">今日 AI 情报</div>
          <div>
            <p className="mb-5 text-sm font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">
              {formatDate(todayNews.generatedAt)}
            </p>
            <h1 className="display-title max-w-4xl text-5xl font-bold leading-[1.1] md:text-[72px]">
              {todayNews.spotlight.title}
            </h1>
            <p className="mt-8 max-w-2xl text-lg leading-relaxed text-[var(--muted)] md:text-xl">
              {todayNews.spotlight.summary}
            </p>
          </div>
          <div className="flex flex-wrap gap-4 pt-4">
            <Link href={`/news/${todayNews.spotlight.id}`} className="primary-button px-8 py-4 text-base">
              阅读今日正文
            </Link>
            <Link href="/news" className="ghost-button border-none px-8 py-4 text-base font-medium hover:bg-[var(--accent-soft)]">
              浏览历史资讯
            </Link>
          </div>
        </div>

        <aside className="flex w-full flex-col gap-12 lg:w-[340px]">
          <div className="space-y-6">
            <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--ink)]">本日概览</h3>
            <div className="h-px w-full bg-[var(--line-strong)]" />
            <div className="space-y-6">
              {todayNews.articles.slice(0, 3).map((article, index) => (
                <div key={article.id} className="group cursor-pointer">
                  <p className="mb-2 text-xs font-bold uppercase tracking-[0.2em] text-[var(--accent)]">0{index + 1}</p>
                  <p className="text-base font-medium leading-relaxed text-[var(--ink)] transition-colors group-hover:text-[var(--accent)]">
                    {article.title}
                  </p>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-6">
            <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-[var(--ink)]">系统状态</h3>
            <div className="h-px w-full bg-[var(--line-strong)]" />
            <div className="flex items-center gap-3">
              <div className="h-3 w-3 animate-pulse rounded-full bg-emerald-500" />
              <p className="text-base font-semibold">{health.status === "ok" ? "所有服务运行正常" : "服务异常"}</p>
            </div>
            <p className="text-sm leading-relaxed text-[var(--muted)]">
              当前阶段为 <span className="font-semibold text-[var(--ink)]">{health.phase}</span>，后端接口与高速数据缓存均已接通，守护进程守护中。
            </p>
          </div>
        </aside>
      </section>

      <div className="my-16 h-px w-full bg-[var(--line-strong)] reveal-up lg:my-24" />

      <section className="grid gap-16 md:gap-20 lg:grid-cols-2 lg:gap-x-24 lg:gap-y-20">
        {todayNews.articles.map((article) => (
          <article key={article.id} className="group reveal-up flex flex-col justify-between">
            <div>
              <div className="mb-5 flex items-center gap-4">
                <span className="text-xs font-bold uppercase tracking-[0.1em] text-[var(--accent)]">{formatDate(article.publishDate)}</span>
                <span className="rounded-full bg-[rgba(0,0,0,0.04)] px-3 py-1 text-xs font-semibold uppercase tracking-wider text-[var(--ink)]">
                  {article.sourceName}
                </span>
              </div>
              <h2 className="text-3xl font-bold leading-snug text-[var(--ink)] transition-colors duration-300 group-hover:text-[var(--accent)]">
                {article.title}
              </h2>
              <p className="mt-5 text-base leading-relaxed text-[var(--muted)]">{article.summary}</p>
            </div>
            <div className="mt-auto flex flex-wrap items-center justify-between gap-6 pt-8">
              <div className="flex flex-wrap gap-2">
                {article.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full border border-[var(--line)] bg-white px-3 py-1.5 text-xs font-medium text-[var(--muted)] shadow-[0_2px_8px_rgba(0,0,0,0.02)]"
                  >
                    #{tag}
                  </span>
                ))}
              </div>
              <Link
                href={`/news/${article.id}`}
                className="inline-flex items-center gap-2 text-sm font-bold text-[var(--ink)] transition-colors group-hover:text-[var(--accent)]"
              >
                探索详情 <span className="text-lg transition-transform group-hover:translate-x-1">→</span>
              </Link>
            </div>
          </article>
        ))}
      </section>

      <div className="my-16 h-px w-full bg-[var(--line-strong)] reveal-up lg:my-24" />

      <section className="mx-auto max-w-3xl pb-10 text-center reveal-up">
        <div className="eyebrow mb-6">纯粹表达</div>
        <h2 className="display-title mb-8 text-4xl font-bold md:text-5xl">极致留白，信息本源</h2>
        <p className="text-lg leading-relaxed text-[var(--muted)]">
          不再让杂乱的方框和生硬的背板束缚阅读体验。我们通过精巧的字体排印与恰到好处的间距，让文字自由呼吸，让信息自然流淌。
        </p>
      </section>
    </div>
  );
}
