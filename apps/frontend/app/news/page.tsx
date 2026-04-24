import Link from "next/link";
import { getNewsList } from "../../lib/api";
import { formatDate } from "../../lib/format";

function isValidDateFilter(value?: string) {
  if (!value) {
    return false;
  }

  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function getTodayDateString() {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function formatOptionLabel(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit"
  }).format(new Date(`${value}T00:00:00`));
}

export default async function NewsPage({
  searchParams
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  const resolvedSearchParams = await searchParams;
  const todayDate = getTodayDateString();
  const selectedDate: string = isValidDateFilter(resolvedSearchParams.date)
    ? resolvedSearchParams.date!
    : todayDate;

  const [newsList, allNewsList] = await Promise.all([getNewsList(selectedDate), getNewsList(undefined, 100)]);

  const dateOptions = [...new Set([todayDate, ...allNewsList.items.map((item) => item.publishDate.slice(0, 10))])].sort(
    (left, right) => right.localeCompare(left)
  );

  return (
    <div className="page-shell section-stack pb-12 pt-8">
      <section className="glass-panel reveal-up rounded-[38px] px-6 py-8 md:px-8">
        <div className="flex flex-col gap-5">
          <div className="eyebrow px-4 py-2.5 text-[13px]">历史资讯</div>
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0">
              <h1 className="display-title text-4xl font-semibold md:text-5xl">AI Brief Archive</h1>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-[var(--muted)] md:text-base">
                这里沉淀每日发布的 AI 资讯。当前版本支持按时间浏览完整内容，后续可以继续扩展筛选、搜索与专题聚合。
              </p>
            </div>

            <form className="flex flex-wrap items-end gap-3 xl:shrink-0">
              <label className="block min-w-[170px]">
                <select
                  name="date"
                  defaultValue={selectedDate}
                  className="select-input"
                  aria-label="选择发布日期"
                >
                  {dateOptions.map((dateValue) => (
                    <option key={dateValue} value={dateValue}>
                      {formatOptionLabel(dateValue)}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className="primary-button text-sm">
                搜索
              </button>
              <Link href="/news" className="ghost-button text-sm font-medium">
                清空
              </Link>
            </form>
          </div>
        </div>
      </section>

      {newsList.items.length > 0 ? (
        <div className="space-y-5">
          {newsList.items.map((article) => (
            <article
              key={article.id}
              className="surface-card reveal-up rounded-[30px] px-6 py-6 transition hover:-translate-y-1"
            >
              <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                <div className="max-w-3xl">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="data-pill">{formatDate(article.publishDate)}</span>
                    {article.tags.slice(0, 3).map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-[var(--accent-softer)] px-3 py-1 text-xs font-semibold text-[var(--accent)]"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                  <h2 className="mt-4 text-2xl font-semibold md:text-3xl">{article.title}</h2>
                  <p className="mt-4 text-sm leading-7 text-[var(--muted)] md:text-base">{article.summary}</p>
                </div>

                <div className="secondary-card rounded-[26px] px-5 py-5 text-sm text-[var(--muted)] lg:w-[240px]">
                  <p className="text-xs font-semibold uppercase tracking-[0.24em]">来源</p>
                  <p className="mt-3 text-base font-semibold text-[var(--ink)]">{article.sourceName}</p>
                  <Link href={`/news/${article.id}`} className="primary-button mt-5 w-full text-sm">
                    查看详情
                  </Link>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <section className="surface-card reveal-up rounded-[30px] px-6 py-10 text-center">
          <p className="text-lg font-semibold text-[var(--ink)]">该日期没有检索到历史资讯</p>
          <p className="mt-3 text-sm leading-7 text-[var(--muted)]">
            当前筛选日期为 {formatOptionLabel(selectedDate)}，你可以切换日期或清空筛选后重新查看。
          </p>
          <div className="mt-6 flex justify-center">
            <Link href="/news" className="ghost-button text-sm font-medium">
              返回全部资讯
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}
