import Link from "next/link";
import { getAdminLlmConfig, requireLlmManagerUser } from "../../../lib/server-auth";
import { updateLlmConfigAction } from "./actions";

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminLlmPage({ searchParams }: PageProps) {
  await requireLlmManagerUser("/admin/llm");
  const config = await getAdminLlmConfig();
  const params = (await searchParams) ?? {};
  const error = typeof params.error === "string" ? params.error : "";
  const saved = params.saved === "1";

  return (
    <div className="page-shell section-stack pb-12 pt-8">
      <section className="glass-panel reveal-up rounded-[38px] px-6 py-8 md:px-8">
        <div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="eyebrow">模型配置</div>
            <h1 className="display-title mt-5 text-4xl font-semibold md:text-6xl">LLM Console</h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-[var(--muted)] md:text-base">
              这里用于配置 HTML-PPT 对话转发所使用的模型地址、API Key 和模型名。保存后，所有项目对话都会经由后端代理到该模型。
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link href="/admin" className="ghost-button text-sm">
              返回后台总览
            </Link>
          </div>
        </div>
      </section>

      {error ? (
        <section className="rounded-[28px] border border-rose-200 bg-rose-50 px-6 py-5 text-sm text-rose-700">{error}</section>
      ) : null}

      {saved ? (
        <section className="rounded-[28px] border border-emerald-200 bg-emerald-50 px-6 py-5 text-sm text-emerald-700">
          模型配置已保存。
        </section>
      ) : null}

      <section className="surface-card reveal-up rounded-[32px] px-6 py-6">
        <form action={updateLlmConfigAction} className="grid gap-5">
          <label className="grid gap-2">
            <span className="text-sm font-medium text-[var(--ink)]">Provider Type</span>
            <input
              name="providerType"
              defaultValue={config?.providerType ?? "openai-compatible"}
              className="text-input"
              placeholder="openai-compatible"
            />
          </label>

          <label className="grid gap-2">
            <span className="text-sm font-medium text-[var(--ink)]">API Base URL</span>
            <input
              name="baseUrl"
              defaultValue={config?.baseUrl ?? ""}
              className="text-input"
              placeholder="https://api.openai.com/v1"
            />
          </label>

          <label className="grid gap-2">
            <span className="text-sm font-medium text-[var(--ink)]">Model</span>
            <input
              name="model"
              defaultValue={config?.model ?? ""}
              className="text-input"
              placeholder="gpt-5.4-mini"
            />
          </label>

          <label className="grid gap-2">
            <span className="text-sm font-medium text-[var(--ink)]">API Key</span>
            {config?.apiKeyMasked ? (
              <div className="rounded-[16px] border border-[var(--line)] bg-[var(--accent-softer)] px-4 py-3 text-sm text-[var(--ink)]">
                当前已保存：<span className="font-mono font-semibold tracking-wide">{config.apiKeyMasked}</span>
              </div>
            ) : (
              <div className="rounded-[16px] border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
                当前尚未保存 API Key。
              </div>
            )}
            <input
              name="apiKey"
              type="password"
              className="text-input"
              placeholder={config?.hasApiKey ? "已配置，留空则保持不变" : "输入新的 API Key"}
            />
          </label>

          <label className="flex items-center gap-3 rounded-[20px] border border-[var(--line)] bg-[var(--accent-softer)] px-4 py-4">
            <input name="enabled" type="checkbox" defaultChecked={config?.enabled ?? false} />
            <span className="text-sm text-[var(--ink)]">启用该配置并允许 HTML-PPT 对话调用模型</span>
          </label>

          <div className="flex flex-wrap items-center gap-4">
            <button type="submit" className="primary-button text-sm">
              保存配置
            </button>
            <span className="text-sm text-[var(--muted)]">
              当前状态：{config?.enabled ? "已启用" : "未启用"} {config?.updatedAt ? `· 最近更新 ${new Date(config.updatedAt).toLocaleString("zh-CN")}` : ""}
            </span>
          </div>
        </form>
      </section>
    </div>
  );
}
