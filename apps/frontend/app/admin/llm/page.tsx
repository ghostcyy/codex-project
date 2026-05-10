import Link from "next/link";
import { ConfirmSubmitButton } from "../../../components/admin/confirm-submit-button";
import { getAdminImageModelConfig, getAdminJsonModelConfig, getAdminLlmConfigs, getAdminLlmLogs, getAdminLlmStats, requireLlmManagerUser } from "../../../lib/server-auth";
import { createLlmConfigAction, deleteLlmConfigAction, updateImageModelConfigAction, updateJsonModelConfigAction, updateLlmConfigAction } from "./actions";

const HTML_PPT_MODEL_STAGES = [
  { key: "research", label: "Research", hint: "02 资料整理" },
  { key: "plan", label: "Plan", hint: "03 内容规划" },
  { key: "visual", label: "Visual", hint: "04 视觉方案" },
  { key: "section", label: "Section", hint: "05 内容/HTML" },
  { key: "css", label: "CSS", hint: "06 样式生成" },
  { key: "qa", label: "QA Repair", hint: "08 定点修复" }
] as const;

const LLM_PROVIDER_OPTIONS = [
  { value: "minimax-cli", label: "MiniMax CLI JSON", hint: "mmx --output json" },
  { value: "minimax", label: "MiniMax HTTP", hint: "Prompt-only JSON contract" },
  { value: "openai-compatible", label: "OpenAI Compatible HTTP", hint: "Generic /chat/completions" },
  { value: "openai", label: "OpenAI JSON Mode", hint: "response_format json_object" },
  { value: "openrouter", label: "OpenRouter JSON Mode", hint: "response_format json_object" },
  { value: "azure-openai", label: "Azure OpenAI JSON Mode", hint: "response_format json_object" }
] as const;

type PageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminLlmPage({ searchParams }: PageProps) {
  await requireLlmManagerUser("/admin/llm");
  const configs = (await getAdminLlmConfigs()) ?? [];
  const imageConfig = await getAdminImageModelConfig();
  const jsonConfig = await getAdminJsonModelConfig();
  const stats = (await getAdminLlmStats()) ?? { totalCalls: 0, totalTokens: 0, todayCalls: 0, todayTokens: 0 };
  const logs = (await getAdminLlmLogs()) ?? [];
  const params = (await searchParams) ?? {};
  const error = typeof params.error === "string" ? params.error : "";
  const saved = params.saved === "1";

  return (
    <div className="page-shell section-stack pb-20 pt-8">
      <section className="glass-panel reveal-up rounded-[40px] px-8 py-10">
        <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="eyebrow">Intelligence Orchestration</div>
            <h1 className="display-title mt-4 text-4xl font-semibold tracking-tight md:text-6xl text-[var(--ink)]">LLM Console</h1>
            <p className="mt-4 max-w-2xl text-base leading-relaxed text-[var(--muted)] opacity-80">
              Manage multi-model configurations, API keys, and monitor site-wide token consumption with real-time analytics.
            </p>
          </div>
          <div className="flex flex-wrap gap-4">
            <Link href="/admin" className="ghost-button text-sm px-6 py-3">
              Admin Overview
            </Link>
          </div>
        </div>
      </section>

      {error && (
        <section className="reveal-up rounded-[28px] border border-rose-100 bg-rose-50/50 backdrop-blur-sm px-8 py-6 text-sm text-rose-700 flex items-center gap-3">
          <span className="text-xl">⚠️</span> {error}
        </section>
      )}

      {saved && (
        <section className="reveal-up rounded-[28px] border border-emerald-100 bg-emerald-50/50 backdrop-blur-sm px-8 py-6 text-sm text-emerald-700 flex items-center gap-3">
          <span className="text-xl">✓</span> Changes saved successfully.
        </section>
      )}

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4 reveal-up" style={{ animationDelay: '100ms' }}>
        {[
          { label: 'Total Calls', value: stats?.totalCalls, icon: '⚡' },
          { label: 'Total Tokens', value: stats?.totalTokens, icon: '🪙' },
          { label: 'Today\'s Calls', value: stats?.todayCalls, icon: '📅' },
          { label: 'Today\'s Tokens', value: stats?.todayTokens, icon: '📈' },
        ].map((item, i) => (
          <div key={i} className="antigravity-card p-8 group">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-[var(--muted)] uppercase letter-spacing-wider">{item.label}</div>
              <div className="text-xl opacity-40 group-hover:opacity-100 transition-opacity">{item.icon}</div>
            </div>
            <div className="mt-4 text-4xl font-semibold text-[var(--ink)]">{(item.value ?? 0).toLocaleString()}</div>
          </div>
        ))}
      </div>

      <section className="space-y-8 reveal-up" style={{ animationDelay: '180ms' }}>
        <div className="flex items-center justify-between px-2">
          <h2 className="text-2xl font-semibold text-[var(--ink)] tracking-tight">Image Model Configuration</h2>
          <span className="text-sm font-medium text-[var(--muted)]">Default Image Model</span>
        </div>
        <div className="glass-panel rounded-[32px] border border-cyan-100 bg-cyan-50/35 p-8">
          {imageConfig ? (
            <form action={updateImageModelConfigAction} className="grid gap-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-xl font-semibold text-[var(--ink)]">{imageConfig.name}</h3>
                  <p className="mt-1 text-sm leading-6 text-[var(--muted)]">
                    This model is used only by HTML-PPT v3 Stage 2.5 text-to-image generation. It is independent from the default text model.
                  </p>
                </div>
                <div className="rounded-full bg-cyan-100 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-cyan-700">
                  Image
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <label className="grid gap-2">
                  <span className="px-1 text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]">Display Name</span>
                  <input name="name" defaultValue={imageConfig.name} className="text-input h-12 text-sm" required />
                </label>
                <label className="grid gap-2">
                  <span className="px-1 text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]">Provider Type</span>
                  <select name="providerType" defaultValue={imageConfig.providerType || "openai-compatible"} className="text-input h-12 text-sm">
                    {LLM_PROVIDER_OPTIONS.map((provider) => (
                      <option key={provider.value} value={provider.value}>{provider.label}</option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-2">
                  <span className="px-1 text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]">Image Base URL</span>
                  <input name="baseUrl" defaultValue={imageConfig.baseUrl} className="text-input h-12 text-sm" placeholder="https://mimimax.cn/v1" required />
                </label>
                <label className="grid gap-2">
                  <span className="px-1 text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]">Image Model ID</span>
                  <input name="model" defaultValue={imageConfig.model} className="text-input h-12 text-sm" placeholder="image-01" required />
                </label>
                <label className="grid gap-2 md:col-span-2">
                  <span className="px-1 text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]">Image API Key</span>
                  <input
                    name="apiKey"
                    type="password"
                    className="text-input h-12 text-sm"
                    placeholder={imageConfig.hasApiKey ? `Encrypted (Masked: ${imageConfig.apiKeyMasked})` : "Enter text-to-image API Key"}
                  />
                  <span className="px-1 text-[10px] leading-4 text-[var(--muted)]">
                    编辑时留空会保留当前文生图 Key。此 Key 不会用于文本模型调用。
                  </span>
                </label>
              </div>
              <div className="flex justify-end border-t border-[var(--line)] pt-6">
                <button type="submit" className="primary-button h-12 px-8 text-sm shadow-lg shadow-cyan-900/10">
                  Save Image Model
                </button>
              </div>
            </form>
          ) : (
            <p className="text-sm font-medium text-[var(--muted)]">Failed to load image model configuration.</p>
          )}
        </div>
      </section>

      <section className="space-y-8 reveal-up" style={{ animationDelay: '190ms' }}>
        <div className="flex items-center justify-between px-2">
          <h2 className="text-2xl font-semibold text-[var(--ink)] tracking-tight">JSON Model Configuration</h2>
          <span className="text-sm font-medium text-[var(--muted)]">Default JSON Model</span>
        </div>
        <div className="glass-panel rounded-[32px] border border-amber-100 bg-amber-50/35 p-8">
          {jsonConfig ? (
            <form action={updateJsonModelConfigAction} className="grid gap-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-xl font-semibold text-[var(--ink)]">{jsonConfig.name}</h3>
                  <p className="mt-1 text-sm leading-6 text-[var(--muted)]">
                    This model is used by HTML-PPT v3 intent parsing and Stage 1 planning where official JSON Schema output is required.
                  </p>
                </div>
                <div className="rounded-full bg-amber-100 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-amber-700">
                  JSON
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <label className="grid gap-2">
                  <span className="px-1 text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]">Display Name</span>
                  <input name="name" defaultValue={jsonConfig.name} className="text-input h-12 text-sm" required />
                </label>
                <label className="grid gap-2">
                  <span className="px-1 text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]">Provider Type</span>
                  <select name="providerType" defaultValue={jsonConfig.providerType || "minimax"} className="text-input h-12 text-sm">
                    {LLM_PROVIDER_OPTIONS.map((provider) => (
                      <option key={provider.value} value={provider.value}>{provider.label}</option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-2">
                  <span className="px-1 text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]">JSON Base URL</span>
                  <input name="baseUrl" defaultValue={jsonConfig.baseUrl} className="text-input h-12 text-sm" placeholder="https://api.minimax.io/v1" required />
                </label>
                <label className="grid gap-2">
                  <span className="px-1 text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]">JSON Model ID</span>
                  <input name="model" defaultValue={jsonConfig.model} className="text-input h-12 text-sm" placeholder="MiniMax-Text-01" required />
                </label>
                <label className="grid gap-2 md:col-span-2">
                  <span className="px-1 text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]">JSON API Key</span>
                  <input
                    name="apiKey"
                    type="password"
                    className="text-input h-12 text-sm"
                    placeholder={jsonConfig.hasApiKey ? `Encrypted (Masked: ${jsonConfig.apiKeyMasked})` : "Enter JSON model API Key, or leave blank to use the active model key"}
                  />
                  <span className="px-1 text-[10px] leading-4 text-[var(--muted)]">
                    编辑时留空会保留当前 JSON Key；如果未单独配置，后端会回退使用当前默认文本模型 Key。
                  </span>
                </label>
              </div>
              <div className="flex justify-end border-t border-[var(--line)] pt-6">
                <button type="submit" className="primary-button h-12 px-8 text-sm shadow-lg shadow-amber-900/10">
                  Save JSON Model
                </button>
              </div>
            </form>
          ) : (
            <p className="text-sm font-medium text-[var(--muted)]">Failed to load JSON model configuration.</p>
          )}
        </div>
      </section>

      <section className="space-y-8 reveal-up" style={{ animationDelay: '200ms' }}>
        <div className="flex items-center justify-between px-2">
          <h2 className="text-2xl font-semibold text-[var(--ink)] tracking-tight">Model Configurations</h2>
          <span className="text-sm font-medium text-[var(--muted)]">{Array.isArray(configs) ? configs.length : 0} Models Active</span>
        </div>

        <div className="grid gap-8 lg:grid-cols-2">
          {Array.isArray(configs) ? configs.map((config: any) => (
            <div key={config.id} className="glass-panel rounded-[32px] p-8 border border-[var(--line)] bg-white/40 hover:bg-white/80 transition-all duration-500">
              <form action={updateLlmConfigAction} className="grid gap-6">
                <input type="hidden" name="id" value={config.id} />
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="text-xl font-semibold text-[var(--ink)]">{config.name}</h3>
                    <div className="mt-1 flex gap-4 text-xs font-medium text-[var(--muted)]">
                      <span className="bg-white px-2 py-1 rounded-md shadow-sm">Calls: {(config.callCount ?? 0).toLocaleString()}</span>
                      <span className="bg-white px-2 py-1 rounded-md shadow-sm">Tokens: {(config.tokenConsumption ?? 0).toLocaleString()}</span>
                    </div>
                  </div>
                  <div className={`px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest ${config.enabled ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                    {config.enabled ? 'Active' : 'Disabled'}
                  </div>
                </div>

                <div className="grid gap-4">
                  <label className="grid gap-2">
                    <span className="text-[11px] font-bold text-[var(--muted)] uppercase tracking-wider px-1">Display Name</span>
                    <input name="name" defaultValue={config.name} className="text-input text-sm h-12" required />
                  </label>

                  <div className="grid grid-cols-2 gap-4">
                    <label className="grid gap-2">
                      <span className="text-[11px] font-bold text-[var(--muted)] uppercase tracking-wider px-1">Provider</span>
                      <select name="providerType" defaultValue={config.providerType || "minimax-cli"} className="text-input text-sm h-12">
                        {LLM_PROVIDER_OPTIONS.map((provider) => (
                          <option key={provider.value} value={provider.value}>{provider.label}</option>
                        ))}
                      </select>
                      <span className="px-1 text-[10px] leading-4 text-[var(--muted)]">
                        MiniMax CLI uses the server-side <code>mmx text chat --output json</code> path.
                      </span>
                    </label>
                    <label className="grid gap-2">
                      <span className="text-[11px] font-bold text-[var(--muted)] uppercase tracking-wider px-1">Model ID</span>
                      <input name="model" defaultValue={config.model} className="text-input text-sm h-12" />
                    </label>
                  </div>

                  <div className="rounded-[22px] border border-[var(--line)] bg-white/55 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]">HTML-PPT Stage Overrides</div>
                        <p className="mt-1 text-xs leading-5 text-[var(--muted)]">Optional. Leave blank to use the primary Model ID above.</p>
                      </div>
                    </div>
                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      {HTML_PPT_MODEL_STAGES.map((stage) => (
                        <label key={stage.key} className="grid gap-1.5">
                          <span className="px-1 text-[10px] font-bold uppercase tracking-wider text-[var(--muted)]">{stage.label}</span>
                          <input
                            name={`stageModel.${stage.key}`}
                            defaultValue={config.stageModelOverrides?.[stage.key] ?? ""}
                            className="text-input h-10 text-xs"
                            placeholder={`${stage.hint} → ${config.model}`}
                          />
                        </label>
                      ))}
                    </div>
                  </div>

                  <label className="grid gap-2">
                    <span className="text-[11px] font-bold text-[var(--muted)] uppercase tracking-wider px-1">Endpoint URL</span>
                    <input name="baseUrl" defaultValue={config.baseUrl} className="text-input text-sm h-12" />
                  </label>

                  <label className="grid gap-2">
                    <span className="text-[11px] font-bold text-[var(--muted)] uppercase tracking-wider px-1">API Authentication</span>
                    <input
                      name="apiKey"
                      type="password"
                      className="text-input text-sm h-12"
                      placeholder={config.hasApiKey ? `Encrypted (Masked: ${config.apiKeyMasked})` : "Enter API Key"}
                    />
                  </label>

                  <label className="flex items-center gap-4 cursor-pointer group mt-2">
                    <div className="relative inline-flex items-center h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ring-0">
                      <input name="enabled" type="checkbox" defaultChecked={config.enabled} className="sr-only peer" />
                      <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[var(--ink)]"></div>
                    </div>
                    <span className="text-sm font-medium text-[var(--ink)]">Enable this model for production traffic</span>
                  </label>
                </div>

                <div className="flex items-center justify-between mt-4 pt-6 border-t border-[var(--line)]">
                  <ConfirmSubmitButton
                    action={deleteLlmConfigAction}
                    className="text-sm font-semibold text-rose-500 hover:text-rose-600 transition-colors px-2"
                    message={`确认删除模型配置「${config.name}」？`}
                  >
                    Remove Provider
                  </ConfirmSubmitButton>
                  <button type="submit" className="primary-button text-sm px-8 h-12 shadow-lg shadow-gray-900/10">Save Configuration</button>
                </div>
              </form>
            </div>
          )) : (
            <div className="glass-panel rounded-[32px] p-12 text-center border-dashed">
              <p className="text-[var(--muted)] font-medium">Failed to load configurations. Please check backend logs.</p>
            </div>
          )}

          <div className="antigravity-card p-8 border-dashed border-[var(--line-strong)] bg-transparent flex flex-col justify-center min-h-[400px]">
            <div className="text-center mb-8">
              <div className="text-3xl mb-4">➕</div>
              <h3 className="text-xl font-semibold text-[var(--ink)]">Add New Provider</h3>
              <p className="text-sm text-[var(--muted)] mt-2">Expand your orchestration pool with another LLM endpoint.</p>
            </div>
            <form action={createLlmConfigAction} className="grid gap-6">
              <label className="grid gap-2">
                <span className="text-[11px] font-bold text-[var(--muted)] uppercase tracking-wider px-1">Friendly Name</span>
                <input name="name" className="text-input text-sm h-12 bg-white" placeholder="e.g., GPT-4o Pro" required />
              </label>
              <div className="grid grid-cols-2 gap-4">
                <label className="grid gap-2">
                  <span className="text-[11px] font-bold text-[var(--muted)] uppercase tracking-wider px-1">Provider Type</span>
                  <select name="providerType" defaultValue="minimax-cli" className="text-input text-sm h-12 bg-white">
                    {LLM_PROVIDER_OPTIONS.map((provider) => (
                      <option key={provider.value} value={provider.value}>{provider.label}</option>
                    ))}
                  </select>
                  <span className="px-1 text-[10px] leading-4 text-[var(--muted)]">
                    Default: MiniMax CLI JSON. Requires <code>mmx</code> on the backend PATH.
                  </span>
                </label>
                <label className="grid gap-2">
                  <span className="text-[11px] font-bold text-[var(--muted)] uppercase tracking-wider px-1">Model Name</span>
                  <input name="model" className="text-input text-sm h-12 bg-white" defaultValue="MiniMax-M2.7-highspeed" placeholder="MiniMax-M2.7-highspeed" required />
                </label>
              </div>
              <div className="rounded-[22px] border border-[var(--line)] bg-white/55 p-4">
                <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--muted)]">HTML-PPT Stage Overrides</div>
                <p className="mt-1 text-xs leading-5 text-[var(--muted)]">Optional per-stage model IDs. Blank stages use the primary model.</p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  {HTML_PPT_MODEL_STAGES.map((stage) => (
                    <label key={stage.key} className="grid gap-1.5">
                      <span className="px-1 text-[10px] font-bold uppercase tracking-wider text-[var(--muted)]">{stage.label}</span>
                      <input
                        name={`stageModel.${stage.key}`}
                        className="text-input h-10 bg-white text-xs"
                        placeholder={stage.hint}
                      />
                    </label>
                  ))}
                </div>
              </div>
              <label className="grid gap-2">
                <span className="text-[11px] font-bold text-[var(--muted)] uppercase tracking-wider px-1">Base URL</span>
                <input name="baseUrl" className="text-input text-sm h-12 bg-white" defaultValue="https://api.minimax.io/v1" placeholder="https://api.minimax.io/v1" required />
              </label>
              <label className="grid gap-2">
                <span className="text-[11px] font-bold text-[var(--muted)] uppercase tracking-wider px-1">API Secret</span>
                <input name="apiKey" type="password" className="text-input text-sm h-12 bg-white" placeholder="sk-..." required />
              </label>
              <label className="flex items-center gap-4 cursor-pointer group">
                <div className="relative inline-flex items-center h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ring-0">
                  <input name="enabled" type="checkbox" className="sr-only peer" />
                  <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[var(--ink)]"></div>
                </div>
                <span className="text-sm font-medium text-[var(--ink)]">创建后立即启用</span>
              </label>
              <button type="submit" className="primary-button w-full h-14 mt-4 bg-[var(--ink)] text-white shadow-xl shadow-gray-900/10">Initialize Provider</button>
            </form>
          </div>
        </div>
      </section>

      <section className="space-y-8 reveal-up" style={{ animationDelay: '300ms' }}>
        <div className="flex items-center justify-between px-2">
          <h2 className="text-2xl font-semibold text-[var(--ink)] tracking-tight">Recent Execution Logs</h2>
          <div className="text-sm font-medium text-[var(--muted)] bg-[var(--bg-deep)] px-4 py-2 rounded-full border border-[var(--line)]">Live Activity</div>
        </div>
        <div className="glass-panel rounded-[40px] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm whitespace-nowrap">
              <thead>
                <tr className="bg-white/60 backdrop-blur-md border-b border-[var(--line)]">
                  <th className="px-8 py-5 font-bold text-[var(--muted)] uppercase tracking-widest text-[10px]">Timestamp</th>
                  <th className="px-8 py-5 font-bold text-[var(--muted)] uppercase tracking-widest text-[10px]">Author</th>
                  <th className="px-8 py-5 font-bold text-[var(--muted)] uppercase tracking-widest text-[10px]">Orchestrator</th>
                  <th className="px-8 py-5 font-bold text-[var(--muted)] uppercase tracking-widest text-[10px] text-right">Usage</th>
                  <th className="px-8 py-5 font-bold text-[var(--muted)] uppercase tracking-widest text-[10px] text-right">In / Out</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--line)] bg-white/20">
                {Array.isArray(logs) && logs.length > 0 ? (
                  logs.map((log: any) => (
                    <tr key={log.id} className="hover:bg-white/80 transition-all duration-300">
                      <td className="px-8 py-5 text-[var(--muted)] font-medium">{new Date(log.createdAt).toLocaleString("zh-CN", { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                      <td className="px-8 py-5">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-[10px] font-bold text-[var(--ink)] border border-[var(--line)] uppercase">
                            {(log.user?.username ?? 'U')[0]}
                          </div>
                          <span className="font-semibold text-[var(--ink)]">{log.user?.username ?? `User ${log.userId}`}</span>
                        </div>
                      </td>
                      <td className="px-8 py-5">
                        <span className="inline-flex items-center px-3 py-1 text-[11px] font-bold rounded-lg bg-white border border-[var(--line-strong)] text-[var(--ink)] shadow-sm">
                          {log.config?.name ?? "Default"}
                        </span>
                      </td>
                      <td className="px-8 py-5 text-right">
                        <div className="text-base font-bold text-[var(--ink)] tracking-tight">{(log.totalTokens ?? 0).toLocaleString()} <span className="text-[10px] text-[var(--muted)] uppercase ml-1">Tokens</span></div>
                      </td>
                      <td className="px-8 py-5 text-right font-mono text-[11px] text-[var(--muted)] font-medium">
                        {log.promptTokens?.toLocaleString()} <span className="mx-1 opacity-30">/</span> {log.completionTokens?.toLocaleString()}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="px-8 py-20 text-center">
                      <div className="flex flex-col items-center gap-3">
                        <div className="text-3xl opacity-20">🌫️</div>
                        <div className="text-base font-semibold text-[var(--muted)]">No execution logs found in the current buffer.</div>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}
