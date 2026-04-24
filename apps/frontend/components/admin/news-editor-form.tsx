import Link from "next/link";
import type { AdminNewsArticle } from "../../lib/types";

interface NewsEditorFormProps {
  article?: AdminNewsArticle;
  mode: "create" | "edit";
  submitAction: (formData: FormData) => void | Promise<void>;
  errorMessage?: string;
}

function toDateTimeLocal(value: string) {
  const date = new Date(value);
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

export function NewsEditorForm({
  article,
  mode,
  submitAction,
  errorMessage
}: NewsEditorFormProps) {
  return (
    <form className="space-y-6" action={submitAction}>
      <div className="grid gap-6 md:grid-cols-2">
        <label className="block">
          <span className="mb-2 block text-sm font-medium text-[var(--ink)]">Slug</span>
          <input
            name="slug"
            defaultValue={article?.id ?? ""}
            className="text-input"
            placeholder="agent-observability-stack"
            required
          />
        </label>

        <label className="block">
          <span className="mb-2 block text-sm font-medium text-[var(--ink)]">发布时间</span>
          <input
            name="publishDate"
            type="datetime-local"
            defaultValue={article ? toDateTimeLocal(article.publishDate) : toDateTimeLocal(new Date().toISOString())}
            className="text-input"
            required
          />
        </label>
      </div>

      <label className="block">
        <span className="mb-2 block text-sm font-medium text-[var(--ink)]">标题</span>
        <input name="title" defaultValue={article?.title ?? ""} className="text-input" required />
      </label>

      <label className="block">
        <span className="mb-2 block text-sm font-medium text-[var(--ink)]">摘要</span>
        <textarea
          name="summary"
          defaultValue={article?.summary ?? ""}
          rows={4}
          className="textarea-input"
          required
        />
      </label>

      <label className="block">
        <span className="mb-2 block text-sm font-medium text-[var(--ink)]">正文</span>
        <textarea
          name="content"
          defaultValue={article?.content ?? ""}
          rows={14}
          className="textarea-input leading-7"
          required
        />
      </label>

      <div className="grid gap-6 md:grid-cols-2">
        <label className="block">
          <span className="mb-2 block text-sm font-medium text-[var(--ink)]">来源名称</span>
          <input name="sourceName" defaultValue={article?.sourceName ?? ""} className="text-input" required />
        </label>

        <label className="block">
          <span className="mb-2 block text-sm font-medium text-[var(--ink)]">来源链接</span>
          <input
            name="sourceUrl"
            type="url"
            defaultValue={article?.sourceUrl ?? ""}
            className="text-input"
            required
          />
        </label>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <label className="block">
          <span className="mb-2 block text-sm font-medium text-[var(--ink)]">标签</span>
          <input
            name="tags"
            defaultValue={article ? article.tags.join(", ") : ""}
            className="text-input"
            placeholder="Agent, Observability, MLOps"
          />
        </label>

        <label className="block">
          <span className="mb-2 block text-sm font-medium text-[var(--ink)]">状态</span>
          <select name="status" defaultValue={article?.status ?? "draft"} className="select-input">
            <option value="draft">草稿</option>
            <option value="published">已发布</option>
            <option value="archived">已下架</option>
          </select>
        </label>
      </div>

      {errorMessage ? (
        <p className="rounded-[18px] border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {errorMessage}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-3 pt-2">
        <button type="submit" className="primary-button px-6 py-3 text-sm">
          {mode === "create" ? "创建资讯" : "保存修改"}
        </button>
        <Link href="/admin/news" className="ghost-button px-6 py-3 text-sm font-medium">
          返回列表
        </Link>
      </div>
    </form>
  );
}
