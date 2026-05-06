# html-ppt-v3 — Wave 4 Plan

> **目标**：把 V3 从"单次表单 + 终端式控制台"升级为产品化形态。
> 两条独立赛道：(A) 模型生图接入 主路径；(B) 三栏 Studio 前端工作台 替换。
> **触发**：人类用户（架构 Agent 主用户）2026-05-03 提出 Goal 1 + Goal 2。
> **作者**：架构 Agent (Opus)
> **Last updated**: 2026-05-03
> **基线**：`docs/07-CURRENT_IMPLEMENTATION_SUMMARY.md`

---

## 0. 范围红线（人类拍板已固化，不再讨论）

### 0.1 不能动的代码
Wave 4 **禁止**修改以下任何已落地行为：

- `stages/stage0-pool-build.ts`、`stages/stage1-planner.ts`、`stages/stage2-writer.ts`、`stages/stage3-injector.ts` 内部逻辑
- `prompts/`、`manifest/`、`packager/`、`preview/` 整目录
- `injector/` 中除 `image-resolver.ts` 之外的所有文件
- `shared/` 中除 ICR 明确批准外的契约
- 旧 V2 模块 `apps/backend/src/modules/ppt-chat/(html-ppt-v2|ppt-chat.*|html-ppt-agent.*|html-ppt-skill.*)` 完全不动

**用户原话**："Be careful not to modify the current orchestration code."
**架构 Agent 解读**：Goal 1 必须在 pipeline 中**新增** Stage 2.5（不重写 Stage 1/2/3 逻辑），Goal 2 不需要任何 stage 改动。orchestration agent service 只允许**追加** Stage 2.5 调用，不允许删改既有 stage 调用。

### 0.2 已锁定决策（Q&A 节录）

| ID | 决策 |
|---|---|
| **G1.1** | T2I provider 走 env var：`HTML_PPT_V3_T2I_PROVIDER` + `HTML_PPT_V3_T2I_API_KEY` + `HTML_PPT_V3_T2I_MODEL`（不复用 LlmConfigService，不新建 admin 表）。 |
| **G1.2** | 行为：**hybrid，本地优先，T2I fallback**。本地 `img/` 命中（hint 评分 > 0）→ 用本地；命中分 = 0（即当前 placeholder 路径）→ 调 T2I 生图。 |
| **G1.3** | 位置：**新增 Stage 2.5 image-gen**，位于 Stage 2 之后、Stage 3 之前。Stage 3 injector 接收 Stage 2.5 产物作为 generatedAssets 旁路输入。 |
| **G1.4** | 存储：每 job 自己的 `<workdir>/img-generated/<slideIndex>-<slotIdx>.png`，最终由 packager 复制进 zip。**不做跨 job 缓存**（Wave 4 范围内）。 |
| **G1.5** | **每 job 硬上限 12 张**生成图。超过时跳过 + warning。 |
| **G1.6** | T2I prompt = 模板风格 preamble + slide 上下文 + Writer 的 `imageHints[i]`。preamble 由 manifest 的 `label/description` + 一组固定风格描述词构成。 |
| **G1.7** | T2I 失败/超时：**fallback 到 `_placeholder.jpg`**，写 warning，**绝不让整个 job 失败**。 |
| **G1.8** | "把 image 页放进候选" = 当前 Stage 0 在 `includeImages=true` 时已经把 image fragments 装进 pool；**不需额外改动**。 |
| **G2.1** | 持久化：**新建 V3 自己的 `ppt_v3_projects` 表**，并给现有 `ppt_v3_jobs` 加 `project_id` 列。**不复用 V2 的 `/api/ppt/projects`**。 |
| **G2.2** | "Conversation 消息" = **每次 generate 请求 = 一条消息**（不引入 NL→params 的额外 LLM）。点击历史消息 → 重新加载该 job 的 preview/zip。 |
| **G2.3** | 模板栏：**rich cards** 显示 label + description + capability badges（image/chart/video/audio）。**v1 不做缩略图**。 |
| **G2.4** | 表单位置：**conversation 中部底部** 的输入区（textarea + 4 toggles + 数字输入 chips + Send 按钮）。 |
| **G2.5** | **替换** `apps/frontend/app/tools/html-ppt-v3/page.tsx`，不并存。 |
| **G2.6** | **全新视觉风格**——既非 V2 玻璃态、也非现版 V3 pastel。新风格由 ξ thread 自由设计（建议方向：编辑型工作台、克制中性色 + 强对比 type，详见 §5.4）。 |

---

## 1. 全景图

```
┌─────────────────────────────────────────────────────────────────────┐
│ Wave 4                                                              │
│                                                                     │
│ Track A — 模型生图（独立可发布）                                     │
│   λ  T2I provider abstraction  ──┐                                  │
│                                  ├──► μ  Stage 2.5 + injector hybrid │
│                                  │     + storage + caps + warnings  │
│                                  │                                  │
│ Track B — 三栏 Studio 前端                                          │
│   ν  V3 projects/messages 后端 ──┐                                  │
│                                  ├──► ξ  Frontend 3-column workbench │
│                                  │     (replace existing page)      │
│                                                                     │
│ Closure                                                             │
│   ο  QA 收口（A+B 全过 → 复跑 matrix → live smoke → ship）          │
└─────────────────────────────────────────────────────────────────────┘
```

**并行度**：λ / μ / ν / ξ 互不直接依赖代码。可以 4 个同时 spawn。
- ξ 仅依赖 ν 的 controller URL 形状（在本文档 §6 已固定 → ξ 不需要 ν 落地就能照接口写）。
- μ 仅依赖 λ 的 provider 函数签名（在本文档 §3 已固定 → μ 不需要 λ 落地就能照签名写）。
- ο 等 λ μ ν ξ 全部 ✅ 后启动。

---

## 2. Track A — Goal 1：模型生图主路径

### 2.1 设计动因
当前 V3 图片只来自模板 `img/` 目录。当 hint 与文件名都不匹配时，落到 `_placeholder.jpg`，导致首屏图片严重不切题。Wave 4 让 T2I 在 hybrid 模式下接管这部分 fallback 路径。

### 2.2 端到端流程（Stage 2.5 插入点）

```
Stage 0 PoolBuild  →  Stage 1 Planner  →  Stage 2 Writer
                                              │
                                              ▼  produces ContentIR (含 imageHints)
                                  ╭──────────────────────────╮
                                  │  Stage 2.5 ImageGen      │
                                  │                          │
                                  │  对每个 image slot：     │
                                  │   1. 在 templateDir/img  │
                                  │      用 hint 评分匹配    │
                                  │   2. score > 0 → 记录    │
                                  │      "use local: <name>" │
                                  │   3. score = 0 → 调 T2I  │
                                  │      provider，落盘到    │
                                  │      workdir/img-generated/ │
                                  │   4. T2I 失败 → 记录     │
                                  │      "use placeholder"   │
                                  │   5. 累计 ≥12 → 跳过 +   │
                                  │      warning             │
                                  │                          │
                                  │  返回 generatedAssets:   │
                                  │   Map<slideIndex,        │
                                  │       Map<slotIdx,       │
                                  │           "img/foo.png"  │
                                  │           or "img-       │
                                  │           generated/.."  │
                                  │           or PLACEHOLDER>│
                                  ╰──────────────┬───────────╯
                                                 ▼
                                       Stage 3 Injector
                                       （image-resolver 优先消费
                                        generatedAssets，否则走旧逻辑）
                                                 ▼
                                       Stage 4 Packager
                                       （workdir/img-generated/
                                        必须复制进最终 outputDir）
```

### 2.3 不变的事

- ContentIR schema **不动**（决策：不做 ICR；generatedAssets 走 stage 旁路而非塞进 IR）
- Stage 1/2/3 既有代码不动；Stage 3 只在 image-resolver 内部加一个"先看 generatedAssets"的分支
- Stage 4 packager 不动；它已经是按目录递归复制 workdir → outputDir，新建的 `img-generated/` 子目录天然被带走
- env 缺失（`HTML_PPT_V3_T2I_API_KEY` 没设）→ Stage 2.5 全部走 placeholder 路径，等价于 Wave 3 行为，不破坏现有 e2e

---

## 3. Track A 接口固定（spawn agent 不需问）

### 3.1 λ — T2I Provider 接口

```ts
// apps/backend/src/modules/ppt-chat/html-ppt-v3/image-gen/provider.types.ts

export type T2IRequest = {
  prompt: string;          // 完整 prompt（已含风格 preamble）
  size?: "1024x1024" | "1280x720" | "1792x1024";
  signal?: AbortSignal;
};

export type T2IResult =
  | { ok: true; bytes: Buffer; mime: "image/png" | "image/jpeg" | "image/webp" }
  | { ok: false; reason: string };

export interface T2IProvider {
  readonly name: string;          // e.g. "minimax-image", "openai-dall-e-3"
  generate(req: T2IRequest): Promise<T2IResult>;
}
```

```ts
// apps/backend/src/modules/ppt-chat/html-ppt-v3/image-gen/index.ts

/** 读环境变量；env 缺失返回 null（Stage 2.5 据此决定是否调用） */
export function loadT2IProviderFromEnv(): T2IProvider | null;
```

**env 约定**：

| Var | 必填 | 说明 |
|---|---|---|
| `HTML_PPT_V3_T2I_PROVIDER` | 是（启用时） | `minimax-image` \| `openai-image` \| `doubao-image` \| ... |
| `HTML_PPT_V3_T2I_API_KEY` | 是（启用时） | provider 凭据 |
| `HTML_PPT_V3_T2I_MODEL` | 否 | 默认走 provider 的稳定模型 |
| `HTML_PPT_V3_T2I_TIMEOUT_MS` | 否 | 默认 60000 |
| `HTML_PPT_V3_T2I_MAX_PER_JOB` | 否 | 默认 12 |

### 3.2 μ — Stage 2.5 接口

```ts
// apps/backend/src/modules/ppt-chat/html-ppt-v3/stages/stage2_5-image-gen.ts

export type Stage25Input = {
  request: GenerateRequest;
  manifest: TemplateManifestV2;
  plan: PlanIR;
  content: ContentIR;
  templateDir: string;
  workdir: string;                 // job workdir（Stage 3 用同一个）
  jobId: string;
  provider: T2IProvider | null;    // null = 跳过 T2I，全部 fallback 到本地或 placeholder
};

/** key = slideIndex；value 数组下标对齐 ContentIR.slides[i].imageHints[i] */
export type GeneratedImageAsset = { src: string; source: "local" | "generated" | "placeholder" };
export type GeneratedAssetMap = Record<number, GeneratedImageAsset[]>;

export type Stage25Result = {
  generatedAssets: GeneratedAssetMap;
  warnings: string[];
  source: "model" | "fallback" | "skipped";   // 至少 1 张走 T2I 成功 → "model"，全部 placeholder/local → "fallback"，无 image 页或 provider=null → "skipped"
  metrics: { localCount: number; generatedCount: number; placeholderCount: number; t2iCalls: number; t2iFailures: number };
};

export async function runStage25ImageGen(input: Stage25Input): Promise<Stage25Result>;
```

### 3.3 image-resolver 改动（μ thread 完成）

```ts
// apps/backend/src/modules/ppt-chat/html-ppt-v3/injector/image-resolver.ts

export function resolveImages(args: {
  section: Element;
  fragment: PageFragment;
  content: SlideContent;
  templateDir: string;
  warnings: string[];
  generatedAssets?: GeneratedImageAsset[];   // 新增；undefined 时完全保持旧行为
}) { ... }
```

旧调用方（无 generatedAssets）行为不变 → 兼容回归。

### 3.4 orchestration 改动（μ thread 完成，最小化）

在 `orchestration/html-ppt-v3-agent.service.ts` 的 generate 方法 Stage 2 之后、Stage 3 之前插入：

```ts
await this.emit(input, "02_5-image-gen", "running", "Resolving image assets");
const provider = loadT2IProviderFromEnv();
const stage25 = await runStage25ImageGen({
  request, manifest, plan: planResult.plan, content: writeResult.content,
  templateDir, workdir, jobId: input.jobId, provider
});
await this.emit(input, "02_5-image-gen", "completed",
  formatStage25Detail(stage25.metrics),
  { source: stage25.source, warnings: stage25.warnings });
```

Stage 3 调用增加 `generatedAssets: stage25.generatedAssets`。

**SSE STAGE_MAP**（controller）增加 `"02_5-image-gen": "writing"`（沿用 writing 状态，不引入新 JobStatus 以免 ICR）。

---

## 4. Track B — Goal 2：三栏 Studio 前端

### 4.1 设计动因
当前 `/tools/html-ppt-v3` 只有"提交一次 → 看一次"，用户每刷新一次就丢失全部历史。三栏布局对齐 V2 的产品力，但保留 V3 pipeline 的纯净。

### 4.2 数据模型（ν thread 落地）

```sql
CREATE TABLE IF NOT EXISTS ppt_v3_projects (
  id UUID PRIMARY KEY,
  user_id UUID NULL,
  name TEXT NOT NULL,
  last_template_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE ppt_v3_jobs
  ADD COLUMN IF NOT EXISTS project_id UUID NULL;

CREATE INDEX IF NOT EXISTS idx_ppt_v3_jobs_project
  ON ppt_v3_jobs(project_id, created_at DESC);
```

**消息 = 一行 ppt_v3_jobs**（决策 G2.2）。无独立 messages 表。

### 4.3 后端 REST 接口（ν thread 完成）

挂在已有 controller 同前缀 `/html-ppt-v3` 下，新文件不要塞进现 controller：

```
GET    /html-ppt-v3/projects                 → list (按 updated_at DESC)
POST   /html-ppt-v3/projects                 body: { name, templateId? } → 返回 project
PATCH  /html-ppt-v3/projects/:id             body: { name?, lastTemplateId? }
DELETE /html-ppt-v3/projects/:id             级联 ppt_v3_jobs.project_id = NULL（不删 job）

GET    /html-ppt-v3/projects/:id/jobs        → list jobs (按 created_at DESC)
POST   /html-ppt-v3/projects/:id/generate    body 同现有 /generate；服务端把 project_id 写入新 job
```

**保留现有** `POST /html-ppt-v3/generate`（不带 project）作为兼容，不删，但前端新页面只用上面的 project-scoped 入口。

`POST /generate` 与 `POST /projects/:id/generate` 共用同一个 `generate()` handler 内部逻辑，区别只在是否传 `projectId`。

### 4.4 前端三栏（ξ thread 完成）

```
┌──────────────┬──────────────────────────────────┬──────────────┐
│              │                                  │              │
│  Projects    │       Conversation               │  Templates   │
│              │                                  │              │
│  [+] new     │  ┌────────────────────────────┐  │  ┌────────┐  │
│  ● Proj A    │  │ msg: theme + 7 pages + ✓   │  │  │ tpl 01 │  │
│  ○ Proj B    │  │ → preview iframe inline    │  │  │ badges │  │
│  ○ Proj C    │  │ → download zip             │  │  └────────┘  │
│              │  └────────────────────────────┘  │  ┌────────┐  │
│              │  ┌────────────────────────────┐  │  │ tpl 02 │  │
│              │  │ msg: ... in progress ...   │  │  └────────┘  │
│              │  └────────────────────────────┘  │  ...         │
│              │                                  │              │
│              │  ───────────────────────────     │              │
│              │  [textarea theme]                │              │
│              │  pages [8] words [1800]          │              │
│              │  ☐img ☐vid ☐chart ☐audio  Send  │              │
│              │  当前模板：✓ <name>              │              │
└──────────────┴──────────────────────────────────┴──────────────┘
```

**核心交互**：
- 左：项目 CRUD（新建、重命名、删除、点击切换）
- 中上：当前项目的 jobs 反向时间序列。每条消息渲染：参数概要 + iframe preview（done 状态）+ 下载按钮 + warnings/source 徽章
- 中下：固定输入区。Send 触发 `POST /html-ppt-v3/projects/:id/generate`，新 job 通过 SSE 流式更新当前消息卡
- 右：模板列表。每张卡 = label + description + 4 个 capability badge（图/视/图表/音）；点击 = 设为当前项目 lastTemplateId

**SSE 重用**：每条 in-progress 的消息卡持有自己的 EventSource，连到 `/html-ppt-v3/sse/:jobId`，done 时关闭。

**视觉**（G2.6 全新风格指引）：
- 不用现版 V3 的 mint/amber pastel + 大圆角胶囊
- 不用 V2 的玻璃态 + 渐变阴影
- 建议方向：编辑型工作台 ——
  - 中性底（off-white #f7f7f5 或墨色 #0c0d10 二选一，由 ξ 决定）
  - 单色强调色（克制；建议靛蓝 / 砖红 / 森绿 三选一）
  - 直角或 4-6px 小圆角；细 1px 分隔线；无大阴影
  - Type-driven：标题用 serif 或 mono，正文 sans 但字重对比强（400 vs 700）
  - 按钮无渐变，纯色填充或 outline
- 具体由 ξ thread 自由发挥，DoD 只要求"和 V2、现版 V3 都不重样"

### 4.5 删什么 / 留什么

- **删**：`apps/frontend/app/tools/html-ppt-v3/page.tsx` 全部内容
- **留**：所有 V3 后端 controller / endpoint URL（含 `/generate`、`/sse`、`/preview`、`/download`、`/templates`）
- **新增**：上面 §4.3 的 6 个新 endpoint；新前端页面
- **不动**：V2 的 `/api/ppt/projects` 完全无接触

---

## 5. Thread spawn prompts（人类拷贝整段给 sub-agent）

> 共 5 个 thread。λ μ ν ξ 可同时 spawn，ο 最后启动。
> Greek 字母延续：α β γ δ ε（W2）→ ζ η θ ι κ（W3）→ **λ μ ν ξ ο（W4）**

### 5.1 Thread λ — T2I provider 抽象

```
你是 html-ppt-v3 Wave 4 Thread λ。
读 docs/00..04, docs/07-CURRENT_IMPLEMENTATION_SUMMARY.md, docs/08-WAVE_4_PLAN.md §3.1。
范围：仅落地 image-gen/ 目录的 provider 抽象，不动 stages/，不动 orchestration/，不动 injector/。

任务：
1. 新建 apps/backend/src/modules/ppt-chat/html-ppt-v3/image-gen/
   ├─ provider.types.ts   # 严格按 docs/08 §3.1 的 T2IRequest / T2IResult / T2IProvider 类型
   ├─ env-provider.ts     # 实现 loadT2IProviderFromEnv()
   ├─ providers/minimax-image.ts   # 至少 1 个真实 adapter
   ├─ providers/openai-image.ts    # 至少 1 个真实 adapter
   └─ index.ts
2. env-provider.ts 行为：
   - 读 HTML_PPT_V3_T2I_PROVIDER；未设 → return null（不抛错）
   - 读 HTML_PPT_V3_T2I_API_KEY；未设 → return null + console.warn
   - 按 provider name 分发到 providers/*；未识别 provider → return null + console.warn
3. provider 内部约束：
   - timeout 默认 60000，可被 HTML_PPT_V3_T2I_TIMEOUT_MS 覆盖
   - 失败/超时/非 2xx → 返回 { ok:false, reason } 而不是抛
   - 不重试（重试由 Stage 2.5 决定，提供方只做一次纯调用）
4. 测试脚本 tests/verify-image-gen-provider.ts：
   - 用 mock provider（不调真实 API）覆盖 success / timeout / non-2xx / 字节为空
   - 用 env mock 覆盖 loadT2IProviderFromEnv 的 null 路径与 dispatch 路径
   - 串到 package.json: "verify:html-ppt-v3-image-gen": "ts-node tests/verify-image-gen-provider.ts"
   - 加进 verify:html-ppt-v3 串行链
5. 不要写真实 API 烟测；real-API smoke 由 ο thread 做 gated。

DoD：
- npm run verify:html-ppt-v3-image-gen 通过
- npm run typecheck --workspace @codex/backend 通过
- 在 THREAD_STATUS.md 把 Wave 4 λ 行 Status 改成 ✅，附 Last Done 一行
```

### 5.2 Thread μ — Stage 2.5 + injector hybrid + agent service 接线

```
你是 html-ppt-v3 Wave 4 Thread μ。
读 docs/00..04, docs/07, docs/08-WAVE_4_PLAN.md §2 §3。
依赖：λ thread 的 image-gen/ 目录（按 docs/08 §3.1 接口；λ 没落地时按签名 mock 即可写代码）。

任务：
1. 新文件 apps/backend/src/modules/ppt-chat/html-ppt-v3/stages/stage2_5-image-gen.ts
   实现 docs/08 §3.2 的 runStage25ImageGen。规则：
   - 遍历 plan.slides，找 pageType ∈ image-* 的 slide
   - 对每个 slide 的每个 imageHints[i]：
     a) 在 templateDir/img/ 用现有 image-resolver.ts 的评分函数（抽出来 export 一个 scoreImageHint(hint, files) 工具）
        - score > 0 → push { src: `img/${file}`, source: "local" }
        - score = 0 → 进入 T2I 路径
     b) T2I 路径：
        - 如累计已生成 ≥ HTML_PPT_V3_T2I_MAX_PER_JOB（默认 12）→ push placeholder + warning
        - 如 provider == null → push placeholder + warning "T2I provider not configured"
        - 否则构造 prompt = buildT2IPrompt(manifest, plan.slides[s], content.slides[s], hint)
        - 调 provider.generate；ok → 写盘 workdir/img-generated/<slideIndex>-<i>.png（保留 mime → 后缀），push { src: `img-generated/<file>`, source: "generated" }
        - !ok → push placeholder + warning
   - 收集 metrics 与 warnings，按 §3.2 返回 Stage25Result
2. buildT2IPrompt(...) 在同文件实现：
   - 风格 preamble = 由 manifest.label["zh-CN"] / description["zh-CN"] 提炼 + 固定后缀
     "16:9 horizontal composition, no text overlay, no watermark, professional editorial illustration"
   - 主题段 = `${plan.theme || ""} | ${plan.slides[s].slideTitle}`
   - hint 段 = hint
   - 用换行拼接
3. 修改 injector/image-resolver.ts：
   - 抽出 scoreImageHint 与 listImageFiles 为 export
   - resolveImages 增加 optional generatedAssets 参数（按 §3.3 签名）
   - 优先消费 generatedAssets[i].src；未提供时走旧路径
   - 既有调用方不传 generatedAssets → 行为完全不变（回归保护）
4. 修改 orchestration/html-ppt-v3-agent.service.ts：
   - 仅追加 §3.4 的 Stage 2.5 调用与 emit
   - Stage 3 调用追加 generatedAssets: stage25.generatedAssets
   - 不删不改任何已有 stage 调用
5. 修改 html-ppt-v3.controller.ts：
   - STAGE_MAP 增加 "02_5-image-gen": "writing"（沿用现有 JobStatus，不引入新状态以免 ICR）
6. 测试脚本 tests/verify-html-ppt-v3-stage25.ts：
   - case A: provider=null → 全部 placeholder/local，warnings 含 "T2I provider not configured"
   - case B: provider 全成功 → metrics.generatedCount > 0
   - case C: provider 全失败 → metrics.t2iFailures > 0，无 throw
   - case D: 超过 cap → metrics.placeholderCount 反映 cap 后的剩余
   - 串到 verify:html-ppt-v3 链
7. 不动 prompts/ 目录；不动 stage1/2/3 内部逻辑；不动 ContentIR schema。

DoD：
- npm run verify:html-ppt-v3-stage25 通过
- npm run verify:html-ppt-v3 全过
- npm run typecheck --workspace @codex/backend 通过
- THREAD_STATUS.md Wave 4 μ 行 Status ✅
```

### 5.3 Thread ν — V3 项目/消息后端

```
你是 html-ppt-v3 Wave 4 Thread ν。
读 docs/00..04, docs/07, docs/08-WAVE_4_PLAN.md §4.2 §4.3。
范围：新建 V3 自己的 projects 持久化与 controller。绝不碰 V2 的 ppt-chat 任何文件。

任务：
1. 新文件 apps/backend/src/modules/ppt-chat/html-ppt-v3/projects/ppt-v3-project.service.ts：
   - 表结构按 §4.2 (projects 新表 + jobs 加 project_id 列；用 IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)
   - CRUD: createProject / listProjectsByUser / getProject / patchProject / deleteProject(级联 jobs.project_id=NULL)
   - listJobsByProject(projectId)
2. 修改 jobs/ppt-v3-job.service.ts:
   - createJob 增加 optional projectId 参数；存进 project_id 列
   - mapJobRow 多一个 projectId 字段
3. 新文件 projects/ppt-v3-projects.controller.ts:
   - 路由按 §4.3 全部 6 个端点
   - POST /projects/:id/generate 内部委托给现有 controller 的 runJob，但 createJob 时传 projectId
   - 复用现有 SSE clients map（不要重复实现），可以把 emit/clients 从 v3 controller 抽到 sse/sse-bus.service.ts 再共享
4. 注册到 html-ppt-v3.module.ts
5. 测试脚本 tests/verify-html-ppt-v3-projects.ts:
   - 创建 project → 列出 → patch → 删除
   - generate 走 project-scoped 路径，jobs 列表能回查到
   - 删除 project 后 jobs 记录仍在（project_id=NULL）
   - 串到 verify:html-ppt-v3 链
6. shared/job.types.ts 不改 schema 字段（projectId 走数据库列，不走 GenerateRequest）

DoD：
- npm run verify:html-ppt-v3-projects 通过
- npm run typecheck --workspace @codex/backend 通过
- THREAD_STATUS.md Wave 4 ν 行 Status ✅
```

### 5.4 Thread ξ — 三栏前端工作台（替换 page.tsx）

```
你是 html-ppt-v3 Wave 4 Thread ξ。
读 docs/00..04, docs/07, docs/08-WAVE_4_PLAN.md §4 §5.4。
范围：完全替换 apps/frontend/app/tools/html-ppt-v3/page.tsx；可拆 components 进同目录或 components/html-ppt-v3/。

任务：
1. 删旧 page.tsx 内容，按 §4.4 ASCII 图实现三栏 grid 布局
2. 数据接入（依赖 ν thread 接口；ν 没落地前先用本地 mock 跑通 UI）：
   - 启动加载 GET /api/html-ppt-v3/projects；为空则 POST 创建首个 "My First Deck"
   - 切换 active project → GET /api/html-ppt-v3/projects/:id/jobs 渲染中间消息列
   - Send → POST /api/html-ppt-v3/projects/:id/generate → 开 EventSource → 流式更新对应消息卡
   - 模板列表：GET /api/html-ppt-v3/templates；点击卡 → PATCH /projects/:id { lastTemplateId }
3. 中间消息卡：
   - in-progress 显示 stage 进度 + warnings 黄标
   - done 显示参数 + iframe preview + 下载按钮 + source/warnings 徽章
   - failed 显示错误 + 重试按钮（重试 = 用同参数再 POST 一次 generate）
4. 底部输入区：
   - textarea theme（500 char limit）
   - 数字 input pageCount(5-30) wordBudget(500-15000)
   - 4 个 toggle: includeImages / includeVideo / includeChart / includeAudio
   - Send 按钮：禁用条件 = !theme.trim() || !lastTemplateId || 当前有 in-progress job
5. 视觉风格 G2.6：必须明显区别于 V2 玻璃态与现版 V3 pastel；推荐方向 §4.4 已写。具体配色由你定，但提交前 self-check：
   - 不出现径向 / 线性 gradient 大面积铺底
   - 不出现 backdrop-filter: blur
   - 不出现 999px 大圆角胶囊
6. 加 README 注释说明哪个 component 负责哪个区域
7. 不动 V2 frontend 任何文件；不动 V3 backend 任何文件

DoD：
- npm run typecheck --workspace @codex/frontend 通过
- 浏览器手测 5 项：
  a) 新建 / 切换 / 重命名 / 删除项目
  b) 提交一次生成 → 中间消息卡显示阶段流转 → done 后 iframe 出现
  c) 点击右栏模板卡 → 当前项目 lastTemplateId 切换且 UI 反映
  d) 关闭页面再打开 → 项目列表与历史消息保留
  e) 视觉风格通过 §5.4 self-check
- THREAD_STATUS.md Wave 4 ξ 行 Status ✅
```

### 5.5 Thread ο — 收口 + 复跑 matrix + live smoke

```
你是 html-ppt-v3 Wave 4 Thread ο。等 λ μ ν ξ 全部 ✅ 再启动。
读 docs/00..04, docs/07, docs/08-WAVE_4_PLAN.md。

任务：
1. 复跑 npm run verify:html-ppt-v3，记录每个子脚本通过情况
2. 复跑 matrix（npm run verify:html-ppt-v3-matrix），对比 Wave 3 baseline
3. 在没设 T2I env 的情况下跑 verify:html-ppt-v3-live-smoke，确认 Stage 2.5 走 placeholder 路径不影响 live LLM 流程
4. 如人类用户提供 T2I env，跑一次 gated real-T2I smoke：
   - 1 个 image-heavy 模板 + includeImages=true + theme="Wave 4 烟测"
   - 验证 outputDir 下确实有 img-generated/*.png
   - 验证 zip 下载里包含同样文件
   - 验证 SSE event 含 02_5-image-gen
5. 验证前端三栏：
   - 用 puppeteer / playwright 写最小冒烟（如基础设施允许）；否则人工跑 §5.4 DoD a-e
   - 验证模板 capability badges 与 manifest.capabilities 一致
6. 写 docs/09-WAVE_4_SHIPLOG.md：
   - 实际通过的脚本清单
   - matrix 数据对比
   - 已知未解 issue（如有）→ 录入 THREAD_STATUS.md 的 Known Issues 表
7. 在 THREAD_STATUS.md 追加 milestone log 与 Wave 4 ✅ 行

DoD：
- 上述全部通过
- 人类用户在浏览器跑过一次完整流程并确认观感符合 G2.6 风格指引
```

---

## 6. Definition of Done — Wave 4 整体

- [ ] λ ✅：image-gen/ 落地，verify:html-ppt-v3-image-gen 通过
- [ ] μ ✅：Stage 2.5 + injector hybrid 落地，verify:html-ppt-v3-stage25 通过，agent service 已挂 Stage 2.5
- [ ] ν ✅：projects 表 + 6 个 endpoint 落地，verify:html-ppt-v3-projects 通过
- [ ] ξ ✅：三栏 page.tsx 替换完成，浏览器 5 项手测过
- [ ] ο ✅：matrix 复跑无回归，live smoke 通过，docs/09-WAVE_4_SHIPLOG.md 落地
- [ ] env 不设 T2I 时整条 pipeline 行为与 Wave 3 完全一致（Stage 2.5 全 placeholder 路径）
- [ ] V2 模块零变更（grep 未触及 ppt-chat 旧文件）
- [ ] V3 既有 5 个 stage 内部逻辑零变更（diff 仅在 stages/stage2_5-* 与 orchestration agent service 的追加调用、injector/image-resolver 新增分支）

---

## 7. 风险 & 缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| T2I provider 接口与真实 API 不匹配 | μ thread 写完 stage 2.5 但接 λ 时形状对不上 | §3.1 已固化签名；λ 必须按签名实现，不允许改 |
| 真实 T2I 太慢导致 SSE 超时 | 用户体验差 | per-image timeout 60s + 累计 cap 12；最坏 12*60=720s；建议人类首次 gated smoke 时跑 includeImages=true 但 pageCount=8 |
| Stage 2.5 引入新 JobStatus | 需要 ICR + DB migration | 复用 "writing" 状态规避（§3.4 已固定） |
| 前端数据模型与 ν 接口对不齐 | ξ 返工 | §4.3 已固定 6 个 endpoint 的 URL/method/body 形状；ν 必须按文档实现 |
| 删旧 page.tsx 后 V2 用户误闯 | 用户疑惑 | 前端 V2 在 `/tools/html-ppt`，V3 在 `/tools/html-ppt-v3`，互不干扰；不需路由迁移 |
| 模板 lastTemplateId 与 PATCH 竞态 | 多 tab 编辑同 project | v1 不处理；v2 再说 |

---

## 8. 不在 Wave 4 范围内（明确推迟）

- T2I 跨 job 缓存（按 prompt hash dedupe）→ Wave 5 候选
- 模板缩略图 PNG 生成 → 单独任务；ξ 在 v1 留位置（card 图区先放占位 SVG）
- NL→params chat（Goal 2 G2.2 选 a 已排除）→ 不做
- V3 项目对话历史的导出 / 分享 → 不做
- 多用户协作 / RBAC → 不做（V3 仍单用户为主）
- 视觉 QA 自动化（Playwright 截图回归）→ 单独任务，与本 Wave 解耦
