import { NewsEditorForm } from "../../../../components/admin/news-editor-form";
import { createNewsArticleAction } from "../actions";
import { requireNewsManagerUser } from "../../../../lib/server-auth";

export default async function AdminNewsCreatePage({
  searchParams
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  await requireNewsManagerUser("/admin/news/new");
  const resolvedSearchParams = await searchParams;

  return (
    <div className="page-shell pb-12 pt-8">
      <section className="surface-card reveal-up rounded-[38px] px-6 py-8 md:px-8">
        <div className="eyebrow">新建资讯</div>
        <h1 className="display-title mt-5 text-4xl font-semibold md:text-5xl">Create News Article</h1>
        <p className="mt-4 max-w-3xl text-sm leading-7 text-[var(--muted)] md:text-base">
          这里用于手动录入资讯内容。填写标题、摘要、正文、来源和标签后，即可直接进入发布工作流。
        </p>

        <div className="mt-8">
          <NewsEditorForm
            mode="create"
            submitAction={createNewsArticleAction}
            errorMessage={resolvedSearchParams.error}
          />
        </div>
      </section>
    </div>
  );
}
