import Link from "next/link";
import { deleteNewsArticleAction, setNewsStatusAction } from "../../app/admin/news/actions";
import type { AdminNewsArticle } from "../../lib/types";

interface NewsItemActionsProps {
  article: AdminNewsArticle;
  redirectPath: string;
}

export function NewsItemActions({ article, redirectPath }: NewsItemActionsProps) {
  const publishAction = setNewsStatusAction.bind(null, article.id, "published", redirectPath);
  const archiveAction = setNewsStatusAction.bind(null, article.id, "archived", redirectPath);
  const draftAction = setNewsStatusAction.bind(null, article.id, "draft", redirectPath);
  const deleteAction = deleteNewsArticleAction.bind(null, article.id, redirectPath);

  return (
    <div className="flex flex-wrap gap-3">
      <Link href={`/admin/news/${article.id}`} className="ghost-button px-4 py-2.5 text-sm font-medium">
        编辑
      </Link>
      {article.status !== "published" ? (
        <form action={publishAction}>
          <button
            type="submit"
            className="inline-flex rounded-full bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition hover:-translate-y-[1px] hover:opacity-95"
          >
            发布
          </button>
        </form>
      ) : (
        <form action={archiveAction}>
          <button
            type="submit"
            className="inline-flex rounded-full bg-amber-600 px-4 py-2.5 text-sm font-medium text-white transition hover:-translate-y-[1px] hover:opacity-95"
          >
            下架
          </button>
        </form>
      )}
      {article.status !== "draft" ? (
        <form action={draftAction}>
          <button type="submit" className="ghost-button px-4 py-2.5 text-sm font-medium">
            转草稿
          </button>
        </form>
      ) : null}
      <form action={deleteAction}>
        <button
          type="submit"
          className="inline-flex rounded-full border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm font-medium text-rose-700 transition hover:-translate-y-[1px]"
        >
          删除
        </button>
      </form>
    </div>
  );
}
