# html-ppt-v3 — Interface Contracts

> **冻结契约**：本文件定义跨 thread 共享的所有 TypeScript 类型与常量。
> **任何修改**必须先在 §10 提交"接口变更请求"，由人类用户拍板，多方同意后才能改。
> 实现位置：`apps/backend/src/modules/ppt-chat/html-ppt-v3/shared/`，由 **Thread S** 拥有写权限。

---

## 1. 总入口

`shared/index.ts` re-export 全部类型。其他 thread **只许** `import { ... } from "../shared"`，不得绕开。

---

## 2. PageType 与 ChartType（常量枚举）

```ts
// shared/manifest-v2.types.ts

export const PAGE_TYPES = [
  "cover",        // 固定首页
  "closing",      // 固定末页
  "grid-2",
  "grid-3",
  "grid-4",
  "grid-5",
  "sidebar",
  "title-text",
  "chart",
  "image-full",
  "image-text",
  "image-grid",
  "video",
  "audio",
  "table",
  "path-flow",
] as const;
export type PageType = typeof PAGE_TYPES[number];

export const MIDDLE_PAGE_TYPES = PAGE_TYPES.filter(
  (t) => t !== "cover" && t !== "closing"
) as readonly Exclude<PageType, "cover" | "closing">[];

export const CHART_TYPES = ["line", "bar", "pie", "gantt"] as const;
export type ChartType = typeof CHART_TYPES[number];

export const IMAGE_PAGE_TYPES: readonly PageType[] = [
  "image-full", "image-text", "image-grid",
];
export const VIDEO_PAGE_TYPES: readonly PageType[] = ["video"];
export const AUDIO_PAGE_TYPES: readonly PageType[] = ["audio"];
```

---

## 3. Manifest v2

```ts
// shared/manifest-v2.types.ts

import { z } from "zod";

export const slotAnchorSchema = z.object({
  slotId:   z.string().min(1),
  selector: z.string().min(1),                    // 相对 fragment 根 <section> 的 CSS 选择器
  tarChars: z.number().int().min(1).max(2000).optional(), // 兼容旧输入；生成的 manifest 必须包含
  maxChars: z.number().int().min(1).max(2000),
  optional: z.boolean().default(false),
});
export type SlotAnchor = z.infer<typeof slotAnchorSchema>;

export const pageFragmentSchema = z.object({
  pageType:           z.enum(PAGE_TYPES),
  htmlFile:           z.string(),                 // 相对模板根的路径，如 "fragments/grid-3.html"
  topicSlots:         z.number().int().min(0).max(8),
  topicSlotMaxChars:  z.number().int().min(0).max(600),
  anchors:            z.array(slotAnchorSchema),
  // chart 专属
  chartCanvasSelector: z.string().optional(),     // 默认 "canvas[data-chart-slot='primary']"
  // image 专属
  imageSlotSelectors:  z.array(z.string()).default([]), // 顺序对应 imageHints 数组下标
  // video 专属
  videoSlotSelector:   z.string().optional(),
});
export type PageFragment = z.infer<typeof pageFragmentSchema>;

export const templateManifestV2Schema = z.object({
  schemaVersion: z.literal(2),
  id:            z.string().min(1),               // "01-tech-web3"
  deckClass:     z.string().regex(/^tpl-[a-z0-9-]+$/),
  label:         z.object({ "zh-CN": z.string(), en: z.string() }),
  description:   z.object({ "zh-CN": z.string(), en: z.string() }),

  // 框架文件
  shellHtmlFile: z.string(),                      // "shell.html" — 含 <!-- SLIDES --> 占位
  cssFiles:      z.array(z.string()),
  jsFiles:       z.array(z.string()),
  assetDirs:     z.array(z.string()),             // ["assets","img"]

  // 固定首末
  fixed: z.object({
    cover:   pageFragmentSchema,
    closing: pageFragmentSchema,
  }),

  // 中间池
  pool: z.record(z.enum(PAGE_TYPES), pageFragmentSchema),

  // 能力声明
  capabilities: z.object({
    chartTypes:    z.array(z.enum(CHART_TYPES)).default([]),  // 支持的图表类型
    hasImagePages: z.boolean().default(false),
    hasVideoPages: z.boolean().default(false),
    hasAudioPages: z.boolean().default(false),
  }),
});
export type TemplateManifestV2 = z.infer<typeof templateManifestV2Schema>;
```

---

## 4. AvailablePool（Stage 0 输出）

```ts
// shared/plan-ir.types.ts

export type AvailablePool = {
  templateId: string;
  /** 仅"中间页"可用的 pageType → fragment 摘要（去掉了 selector 等低层细节，给 LLM 看） */
  middle: Record<string, PageTypeSummary>;
  cover:   PageTypeSummary;
  closing: PageTypeSummary;
  chartTypesAvailable: ChartType[];
};

export type PageTypeSummary = {
  pageType: PageType;
  topicSlots: number;
  topicSlotMaxChars: number;
  /** 该 fragment 总文字容量（所有非 optional 锚点 maxChars 之和的 90%） */
  approxCharCapacity: number;
  /** 用 LLM 看得懂的人话描述（给 prompt 拼） */
  description: string;
  /** 仅对 chart 页有意义 */
  isChart: boolean;
  /** 仅对 image 页有意义 */
  isImage: boolean;
  /** 仅对 video 页有意义 */
  isVideo: boolean;
};
```

---

## 5. PlanIR（Stage 1 输出 → Stage 2 输入）

```ts
// shared/plan-ir.types.ts

import { z } from "zod";

export const plannedSlideSchema = z.object({
  slideIndex:   z.number().int().min(1),
  pageType:     z.enum(PAGE_TYPES),
  slideTitle:   z.string().min(1).max(60),
  topicPoints:  z.array(z.string().min(1).max(80)),  // 数量必须 = 该 fragment 的 topicSlots
  chartType:    z.enum(CHART_TYPES).optional(),       // 仅 chart 页必填
  charBudget:   z.number().int().min(50).max(3000),
});
export type PlannedSlide = z.infer<typeof plannedSlideSchema>;

export const planIRSchema = z.object({
  templateId:  z.string(),
  totalChars:  z.number().int(),                      // = req.wordBudget
  pageCount:   z.number().int(),                      // = req.pageCount
  slides:      z.array(plannedSlideSchema),
});
export type PlanIR = z.infer<typeof planIRSchema>;
```

**验证函数**（Stage 1 输出后必跑，签名固定）：
```ts
// shared/plan-ir.types.ts
export function validatePlanIR(
  plan: PlanIR,
  req: GenerateRequest,
  pool: AvailablePool
): { ok: true } | { ok: false; reasons: string[] };
```

---

## 6. ContentIR（Stage 2 输出 → Stage 3 输入）

```ts
// shared/content-ir.types.ts

import { z } from "zod";

export const chartDataIRSchema = z.object({
  type:    z.enum(CHART_TYPES),
  labels:  z.array(z.string()),
  datasets: z.array(z.object({
    label:           z.string(),
    data:            z.array(z.number()),
    backgroundColor: z.union([z.string(), z.array(z.string())]).optional(),
    borderColor:     z.union([z.string(), z.array(z.string())]).optional(),
  })),
});
export type ChartDataIR = z.infer<typeof chartDataIRSchema>;

export const slideContentSchema = z.object({
  slideIndex:  z.number().int().min(1),
  pageType:    z.enum(PAGE_TYPES),
  slotFills:   z.record(z.string(), z.string()),  // slotId → text（可含 |STRONG|）
  chartData:   chartDataIRSchema.optional(),       // 仅 chart 页
  imageHints:  z.array(z.string()).optional(),     // 仅 image 页
  videoHint:   z.string().optional(),              // 仅 video 页
});
export type SlideContent = z.infer<typeof slideContentSchema>;

export const contentIRSchema = z.object({
  templateId: z.string(),
  slides:     z.array(slideContentSchema),
});
export type ContentIR = z.infer<typeof contentIRSchema>;
```

**特殊语义**：`|STRONG|` 在 slotFill 文本中作为加粗分隔符。Injector 见到 `"关键词|STRONG| 后续"` 时把 `"关键词"` 包成 `<strong>`。无 `|STRONG|` 即纯文本。

**验证函数**：
```ts
// shared/content-ir.types.ts
export function validateContentIR(
  content: ContentIR,
  plan: PlanIR,
  manifestV2: TemplateManifestV2
): { ok: true } | { ok: false; reasons: string[] };
```

---

## 7. Job & Request

```ts
// shared/job.types.ts

import { z } from "zod";

export const generateRequestSchema = z.object({
  theme:          z.string().min(1).max(500),
  pageCount:      z.number().int().min(5).max(30),
  wordBudget:     z.number().int().min(500).max(15000),
  templateId:     z.string().min(1),
  includeImages:  z.boolean(),
  includeVideo:   z.boolean(),
});
export type GenerateRequest = z.infer<typeof generateRequestSchema>;

export const JOB_STATUSES = [
  "pending", "planning", "writing", "injecting", "packaging", "done", "failed",
] as const;
export type JobStatus = typeof JOB_STATUSES[number];

export type PptV3Job = {
  id:           string;
  userId:       string | null;
  request:      GenerateRequest;
  templateId:   string;
  status:       JobStatus;
  outputDir:    string | null;
  zipPath:      string | null;
  previewPath:  string | null;
  plan:         PlanIR | null;
  content:      ContentIR | null;
  error:        string | null;
  createdAt:    Date;
  completedAt:  Date | null;
};
```

---

## 8. SSE 事件类型

```ts
// shared/sse.types.ts

export type SSEEvent =
  | { event: "job-created";  data: { jobId: string } }
  | { event: "stage-start";  data: { stage: Exclude<JobStatus,"pending"|"done"|"failed"> } }
  | { event: "stage-done";   data: { stage: Exclude<JobStatus,"pending"|"done"|"failed">; summary?: unknown } }
  | { event: "progress";     data: { percent: number; message?: string } }
  | { event: "done";         data: { jobId: string; previewUrl: string; downloadUrl: string } }
  | { event: "error";        data: { message: string; stage?: JobStatus } };
```

前端 EventSource 必须处理上述每个事件名。

---

## 9. LLM Client（Thread P 拥有，但签名冻结）

```ts
// orchestration/html-ppt-v3-llm-client.ts （Thread P 拥有）

export interface HtmlPptV3LLMClient {
  callStructured<T extends z.ZodTypeAny>(args: {
    systemPrompt: string;
    userPrompt: string;
    schema: T;
    maxTokens?: number;
    temperature?: number;
    /** 重试次数（默认 1） */
    retries?: number;
  }): Promise<z.infer<T>>;
}
```

任何 thread 调用 LLM 必须经此接口。**不许**直接 import @anthropic-ai/sdk。

---

## 10. 接口变更请求（ICR）

如某 thread 发现现有契约不够用：

1. 在 `THREAD_STATUS.md` → "ICR 提案" 区开一行：`ICR-NNN | 提议方 | 一句话描述 | 状态`
2. 在本文件末尾追加 ICR 详细说明（旧定义 → 新定义 → 影响哪些 thread → 迁移方案）
3. **暂停**所有受影响 thread 的相关代码改动
4. 等人类用户审定 → 状态改为 `accepted` / `rejected`
5. accepted → Thread S 改 `shared/`，其他 thread 同步重跑 typecheck

---

## 11. 命名约定

- 文件：kebab-case（`manifest-v2.parser.ts`）
- 类型：PascalCase
- 常量枚举：UPPER_SNAKE_CASE
- zod schema：`xxxSchema`
- 函数：camelCase
- 测试入口：`verify-<feature>.ts`
- 子目录：单数（`injector/`, `prompt/`），除非该目录就是集合（`tests/`, `prompts/` 历史保留）

---

## 12. 文件路径常量

```ts
// shared/paths.ts (Thread S 拥有)

export const TEMPLATES_ROOT = path.resolve(__dirname,
  "../../../../../../../../.agents/skills/html-ppt/templates/full-decks/gemini");

export const HTML_PPT_V3_OUTPUT_DIR =
  process.env.HTML_PPT_V3_OUTPUT_DIR ??
  path.resolve(__dirname, "../../../../../../../../.local-runtime/html-ppt-v3");
```

`HTML_PPT_V3_OUTPUT_DIR` 下结构：
```
.local-runtime/html-ppt-v3/
├── workdirs/<jobId>/    ← 解压的可预览目录
└── output/<jobId>.zip   ← 打包后的 zip
```
