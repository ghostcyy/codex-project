# HTML-PPT V3 Current Implementation Summary

> 本文档总结当前 `html-ppt-v3` 的真实代码实现，用于下一阶段产品规划和架构评审。它不复述早期废弃方案，只描述当前已落地的端到端链路、模型调用、规则判断、确定性脚本、验证体系和已知风险。

---

## 1. Executive Summary

HTML-PPT V3 是一个独立于 V2 的轻量生成链路。它不复用 V2 的三栏项目/聊天工作台，也不复用 V2 的 renderer 编排，而是在 V3 模块内用模板 fragment + 结构化 IR + 确定性注入生成完整 HTML deck。

当前核心架构是：

- **2 次 LLM 调用**：Stage 1 负责规划 `PlanIR`，Stage 2 负责撰写 `ContentIR`。
- **确定性模板注入**：Stage 3/4 不调用模型，只做 fragment 拼接、slot 填充、Chart.js 注入、本地图片解析、页码/进度条/残留清理、zip 打包。
- **异步 job 模式**：浏览器提交请求后拿到 `jobId`，通过 SSE 接收阶段进度，完成后加载 iframe preview 并下载 zip。

当前已具备的用户可见能力：

- 选择 Gemini 模板。
- 设置主题、页数、总字数。
- 选择是否开放图片、视频、图表、音频候选页。
- 后台异步生成并显示阶段进度。
- iframe 预览，支持上一页/下一页和键盘方向键。
- zip 下载。
- 本地图片约束：最终图片资源必须来自相对 `img/...` 或模板 placeholder。
- 页码按最终实际页数重写。
- 自动注入进度条 runtime。
- 模板残留文本替换，避免 `ECO_HARMONY // 2026` 这类模板烙印泄漏。

---

## 2. Code Map

### Backend V3 Module

V3 后端代码集中在：

`apps/backend/src/modules/ppt-chat/html-ppt-v3/`

主要子模块职责如下：

| Directory | Responsibility |
|---|---|
| `shared/` | 冻结的共享契约，包括 request、job、SSE、manifest v2、PlanIR、ContentIR、路径常量和校验函数。 |
| `manifest/` | 模板 manifest v2 加载、解析、校验、候选池构建、媒体类型检测、图片库审计。 |
| `stages/` | Stage 0/1/2/3 的公开执行入口。Stage 3 当前是 injector facade。 |
| `prompts/` | Stage 1 Planner 和 Stage 2 Writer 的 prompt builder。 |
| `orchestration/` | `HtmlPptV3AgentService` 串联 Stage 0-4；`HtmlPptV3LlmClient` 统一模型调用。 |
| `injector/` | 确定性 HTML 生成：deck stitcher、slot filler、strong parser、chart injector、image resolver、post-stitch cleaner、nav runtime。 |
| `jobs/` | `ppt_v3_jobs` 表创建、job CRUD、状态更新、plan/content 持久化。 |
| `preview/` | 按 jobId scoped 的静态 preview 服务，包含路径穿越防护。 |
| `packager/` | 输出目录准备与 zip 打包。 |
| `tests/` | V3 专项验证脚本，包括 contract、template、stage、agent、preview、matrix、live smoke。 |

### Frontend V3 Page

前端页面位于：

`apps/frontend/app/tools/html-ppt-v3/page.tsx`

职责：

- 加载 `/api/html-ppt-v3/templates` 模板下拉列表。
- 提交 `/api/html-ppt-v3/generate` 创建任务。
- 使用 `/api/html-ppt-v3/sse/:jobId` 接收阶段事件。
- 展示阶段日志、fallback/warnings、错误信息。
- 加载 `/api/html-ppt-v3/preview/:jobId/index.html` iframe。
- 通过 `postMessage` 控制 iframe 内 deck 翻页。
- 下载 `/api/html-ppt-v3/download/:jobId` zip。

### Template Source

V3.1 的模板来源是：

`.agents/skills/html-ppt/templates/full-decks/gemini/*`

每个模板目录的关键文件：

| File/Dir | Purpose |
|---|---|
| `manifest-v2.json` | 模板能力、固定首页/尾页、中间页 pool、anchors、mediaKinds、chart/image/video/audio 能力。 |
| `shell.html` | V3 生成时的 HTML 外壳，包含 `<!-- SLIDES -->` 和 `<!-- CHART_INITS -->` 插入点。 |
| `fragments/*.html` | 可被 Stage 0/1/2 使用的页面 fragment。 |
| `assets/` | 模板本地 CSS、JS、字体、动画等。 |
| `img/` | 模板本地图片库和 `_placeholder`。 |

---

## 3. Generation Pipeline

### Stage 0 — Pool Build

**是否调用模型**：否。

输入：

- `GenerateRequest`
- `TemplateManifestV2`

主要逻辑：

- 读取并 normalize request。
- 加载目标模板 `manifest-v2.json`。
- 基于 `includeImages/includeVideo/includeChart/includeAudio` 物理裁剪 `manifest.pool`。
- 输出 `AvailablePool`，只包含模型允许选择的中间页类型。

关键规则：

- 如果 `includeImages=false`，所有 `pageType` 是图片页或 `mediaKinds` 含 `image` 的 fragment 都不会进入 pool。
- 如果 `includeChart=false`，所有 chart fragment 都不会进入 pool，`chartTypesAvailable=[]`。
- video/audio 同理。
- 这是主路径修复方式，不依赖最终 HTML 删除。

### Stage 1 — Planner

**是否调用模型**：是，第 1 次 LLM 调用。

输入：

- normalized request
- Stage 0 裁剪后的 `AvailablePool`

输出：

- `PlanIR`

模型只负责：

- 规划精确页数。
- 固定首页 `cover`、末页 `closing`。
- 为中间页选择允许的 `pageType`。
- 输出每页 `slideTitle`、`topicPoints`、`charBudget`。
- 如果选择 chart 页，输出合法 `chartType`。

模型不负责：

- 写正文。
- 写 HTML。
- 写 CSS。
- 选择未在 pool 中出现的媒体页。

失败处理：

- `callStructured()` 会按 schema parse。
- schema 或业务校验失败时会重试。
- 失败后可走 deterministic fallback，且 `source=fallback` 会透传到 SSE/前端日志。

### Stage 2 — Writer

**是否调用模型**：是，第 2 次 LLM 调用。

输入：

- `PlanIR`
- 每页对应 fragment 的 anchors 精简信息：`slotId/kind/maxChars/optional`

输出：

- `ContentIR`

模型只负责：

- 为每个 anchor 生成主题相关文案。
- 输出 chart 页的 `chartData`。
- 输出 image 页的 `imageHints`。
- 可使用 `|STRONG|` 标记重点词。

模型不负责：

- 重新规划页面。
- 输出 HTML/CSS/JS。
- 读取完整模板 HTML。
- 接触未被 Stage 1 规划的 pageType。

失败处理：

- schema parse 与 `validateContentIR()` 校验失败会重试。
- 失败后可走 deterministic fallback。
- fallback 会生成基础 slot 文案，仍遵守 `maxChars`。
- `source=model|fallback` 透传到 SSE/前端日志。

### Stage 3 — Injector

**是否调用模型**：否。

输入：

- `PlanIR`
- `ContentIR`
- `TemplateManifestV2`
- template directory
- workdir/jobId

主要逻辑：

- 复制模板目录到 job workdir。
- 根据 `PlanIR.slides` 选择 cover / middle fragments / closing。
- 使用 `deck-stitcher` 拼接完整 slide 列表。
- 使用 `slot-filler` 将 `ContentIR.slotFills` 注入 anchor selector。
- 使用 `strong-parser` 解析 `|STRONG|`。
- 使用 `chart-injector` 给 chart canvas 注入 Chart.js init script。
- 使用 `image-resolver` 从本地 `img/` 目录解析图片。
- 使用 `post-stitch-cleaner` 重写页码、替换模板 residue、设置 `data-slide-index/data-slide-total`。
- 注入 V3 nav runtime 与 progress bar。
- 写出最终 `index.html`。

关键确定性保护：

- 缺失 required anchor 不保留模板原文，会写 warning 并使用主题化 fallback。
- `.slide-number` 的 `data-current/data-total` 按最终实际页序重写。
- 模板 residue 用 anchor `sourceText` 和 residue pattern 检测，命中则替换为主题化短标签。
- 图片只解析本地 `img/...`，找不到时使用 `_placeholder`。

### Stage 4 — Packager

**是否调用模型**：否。

输入：

- injected HTML
- template directory
- jobId

主要逻辑：

- 准备 `HTML_PPT_V3_OUTPUT_DIR` 下的 durable output。
- 复制模板资产。
- 写最终 `index.html`。
- 打包 zip。
- 返回 `outputDir/previewPath/zipPath`。

---

## 4. Model Calling Details

### Provider Source

V3 使用后台当前 active LLM config：

- `LlmConfigService.getActiveConfig()`
- 不硬编码 MiniMax、OpenAI 或其他 provider。
- 所有模型流量集中在 `HtmlPptV3LlmClient`。

### Call Entry

统一入口：

`HtmlPptV3LlmClient.callStructured()`

调用参数包括：

- `systemPrompt`
- `userPrompt`
- `schema`
- `maxTokens`
- `temperature`
- `retries`

### JSON Strategy

如果 provider/model 被判断为支持 OpenAI-compatible JSON mode，会加：

```json
{ "response_format": { "type": "json_object" } }
```

如果不支持 JSON mode，会在 system prompt 中追加：

```text
IMPORTANT: Output ONLY valid JSON. No markdown. No prose.
```

模型响应会先尝试 `JSON.parse()`，然后用 zod schema parse。parse 失败时会带上错误信息重试。

### Retry And Fallback

LLM client 层：

- API 请求默认超时 180 秒。
- transient status：408、429、500、502、503、504 会重试。
- abort/timeout/socket 类错误会重试。

Stage 层：

- Stage 1 Planner schema/业务校验失败后可 fallback。
- Stage 2 Writer schema/业务校验失败后可 fallback。
- fallback 不代表失败；它是可用性兜底，但会通过 `source=fallback` 暴露给前端。

### Logging

模型调用会通过 `LlmLoggingService.logPayload()` 记录：

- configId
- userId/projectId/messageId
- source：`html-ppt-v3`
- stage
- requestPayload
- responsePayload
- status：success/error/timeout
- errorMessage
- latencyMs

---

## 5. Rule And Validation Matrix

### Request Rules

`GenerateRequest` 字段：

- `theme`：必填。
- `pageCount`：5 到 30。
- `wordBudget`：500 到 15000。
- `templateId`：必填。
- `includeImages`：默认 false。
- `includeVideo`：默认 false。
- `includeChart`：默认 false。
- `includeAudio`：默认 false。

兼容旧字段：

- `topic` → `theme`
- `charCount` → `wordBudget`
- `wantsImageSlides` → `includeImages`
- `wantsVideoSlides` → `includeVideo`
- `wantsChartSlides` → `includeChart`
- `wantsAudioSlides` → `includeAudio`

### Pool Rules

Stage 0 使用 `mediaKinds` 作为唯一媒体裁剪依据：

- `mediaKinds:["image"]` 且 `includeImages=false` → 不进入 pool。
- `mediaKinds:["chart"]` 且 `includeChart=false` → 不进入 pool。
- `mediaKinds:["video"]` 且 `includeVideo=false` → 不进入 pool。
- `mediaKinds:["audio"]` 且 `includeAudio=false` → 不进入 pool。

因此模型在 Stage 1 prompt 中看不到未启用媒体 fragment。

### Media Detector Rules

媒体检测由 `media-kind-detector.ts` 统一提供，避免 parser/validator/test 规则漂移。

图片识别包括：

- `<img>`
- `data-image-slot`
- `.img-wrap`、`.image`、`.photo`
- inline style 中的 `background:url(...)`
- CSS 中的 `url(...)`
- 本地图片路径 `img/*.jpg/png/webp/gif/svg`
- 远程图片 URL，例如 Unsplash 或带图片扩展名的 http(s) URL

模板级验证会拒绝远程图片 URL。Chart.js CDN 和 Google Fonts 不属于本轮图片 URL 禁止范围。

### PlanIR Rules

`validatePlanIR()` 关键规则：

- `templateId` 必须等于 request templateId。
- `pageCount` 必须等于 request pageCount。
- `totalChars` 必须等于 request wordBudget。
- `slides.length` 必须等于 pageCount。
- 第 1 页必须是 `cover`。
- 最后一页必须是 `closing`。
- slideIndex 必须从 1 连续递增。
- 中间页 pageType 必须存在于 Stage 0 输出 pool。
- chart 页必须有 `chartType`。
- chartType 必须在 `chartTypesAvailable` 中。
- 未勾选 image/video/chart/audio 时，不允许对应 pageType。
- `sum(charBudget)` 与 wordBudget 允许 15% 误差。

### ContentIR Rules

`validateContentIR()` 关键规则：

- `templateId` 必须等于 PlanIR templateId。
- content slides 数量必须等于 plan slides 数量。
- 每页 `pageType` 必须与 PlanIR 对齐。
- 每个 required anchor 必须有内容。
- slot 文案长度不能超过 anchor `maxChars`。
- chart fragment 必须有 `chartData`。
- chartData type 必须等于 planned chartType。
- chart labels 和 datasets data 长度必须匹配。
- 不允许出现 PlanIR 之外的 content slide。

### Injector Rules

Stage 3 的确定性规则：

- 使用 PlanIR 页序选择 fragment。
- 只填 anchor，不让模型写 HTML。
- `|STRONG|` 被转换为 `<strong>`。
- required anchor 缺失时写 warning 并 fallback，不保留模板原文。
- optional anchor 空值不会保留模板默认正文。
- 页码按最终实际 slideIndex/totalSlides 重写。
- residue 命中时替换为主题化短标签。
- chart canvas 必须有 init script。
- 图片必须解析到本地 `img/...` 或 placeholder。
- nav runtime 注入后负责 iframe 翻页状态和 progress bar 更新。

### Preview And Packager Rules

- preview 只服务 status=done 的 job。
- preview 路径 scoped 到 job outputDir。
- download 只允许 status=done 且 zipPath 存在的 job。
- preview static service 有路径穿越防护。

---

## 6. Frontend Runtime Behavior

用户操作流程：

1. 打开 `/tools/html-ppt-v3`。
2. 前端请求 `/api/html-ppt-v3/templates` 加载模板下拉。
3. 用户填写主题、页数、总字数，选择模板和媒体开关。
4. 前端 POST `/api/html-ppt-v3/generate`。
5. 后端立即返回 `jobId`。
6. 前端连接 `/api/html-ppt-v3/sse/:jobId`。
7. SSE 返回阶段事件：
   - `job-created`
   - `stage-start`
   - `stage-done`
   - `progress`
   - `done`
   - `error`
8. done 事件返回 `previewUrl/downloadUrl/warnings`。
9. 前端 iframe 加载 preview。
10. 用户通过按钮或方向键翻页。

重要行为：

- 前端只展示已经发生的阶段，不提前渲染完整 0-4 步。
- `source=fallback` 或 warnings 会在日志中标黄。
- iframe 翻页只使用 `postMessage`，不依赖跨域 keydown dispatch。
- iframe 内 runtime 会向父页面发送：

```json
{
  "type": "html-ppt-v3:state",
  "currentIndex": 0,
  "totalSlides": 15
}
```

---

## 7. Verification And Current Quality Gates

### Scripts

V3 相关 npm scripts 位于 `apps/backend/package.json`：

| Script | Purpose |
|---|---|
| `verify:html-ppt-v3-shared` | 校验 shared contracts。 |
| `verify:html-ppt-v3-templates` | 校验 26 个 Gemini 模板 manifest/fragments/assets/mediaKinds/远程图片 URL。 |
| `html-ppt-v3:img-audit` | 审计模板本地图片库和 placeholder。 |
| `verify:html-ppt-v3-stage1` | 校验 Stage 1 planner、pool 裁剪、fallback。 |
| `verify:html-ppt-v3-stage2` | 校验 Stage 2 writer、slot fills、fallback。 |
| `verify:html-ppt-v3-stage3` | 校验 injector、slot fill、chart/image/page-number/residue/nav runtime。 |
| `verify:html-ppt-v3-no-residue` | 校验最终产物无模板残留、页码正确。 |
| `verify:html-ppt-v3-jobs` | 校验 job persistence。 |
| `verify:html-ppt-v3-preview` | 校验 preview static、nested resources、路径穿越拒绝。 |
| `verify:html-ppt-v3-agent` | 校验端到端 agent 生成链路。 |
| `verify:html-ppt-v3-matrix` | 多模板、多配置 matrix QA。 |
| `verify:html-ppt-v3-live-smoke` | gated live LLM smoke；未设置 env 时跳过。 |
| `verify:html-ppt-v3` | 串行执行完整 V3 验证链。 |
| `generate:html-ppt-v3-manifests` | 从 Gemini 模板重新生成 manifest-v2/fragments/shell。 |

完整验证：

```bash
npm run verify:html-ppt-v3 --workspace @codex/backend
npm run typecheck --workspace @codex/backend
npm run typecheck --workspace @codex/frontend
```

最近验证口径：

- `verify:html-ppt-v3` 已覆盖 shared、templates、image audit、stage1、stage2、stage3、no-residue、jobs、preview、agent、matrix、live-smoke gate。
- Matrix 最近一次口径为 300 cases，成功率 300/300。
- live LLM smoke 默认 gated，需要 `HTML_PPT_V3_LIVE_LLM=1` 才真实消耗模型调用。
- fallback 不是失败，但必须被记录和前端可见。

---

## 8. Known Limitations / Next Planning Hooks

### 真实模型质量仍需持续评估

V3 已经把模型职责压缩为 PlanIR 和 ContentIR，但真实模型仍可能出现：

- JSON 不稳定。
- 规划质量普通。
- 文案风格不够贴合模板。
- fallback 频率偏高。
- anchor 填充语义弱。

下一步建议继续跟踪：

- planner fallback rate
- writer fallback rate
- warning-free rate
- 真实模型 latency
- 每模板生成质量差异

### Anchor 覆盖率仍是模板质量核心

V3 不把完整 HTML 给模型，而是通过 anchors 让模型填内容。因此模板质量高度依赖：

- 所有应随主题变化的可见文本是否都成为 anchor。
- anchor `kind/maxChars/optional/sourceText` 是否准确。
- selector 是否稳定。

后续如果某模板仍泄漏默认文案，优先检查 `manifest-v2.json` 和 fragments anchor 覆盖。

### 媒体开关是候选池裁剪，不是最终删除器

当前策略是：

- 用户未勾选图片/图表/音频/视频时，模型完全看不到对应 fragment。
- 最终 HTML 检查只做防回归，不作为主修复路径。

如果旧 job 或旧导出目录仍有媒体页，需要重新生成新 job 验证。

### 图片策略是本地模板图库

V3.1 不调用图片生成模型。图片只来自：

- 模板 `img/` 目录。
- `_placeholder`。

如果用户需要更丰富图片，需要后续单独设计：

- 本地素材库扩容。
- 图片关键词索引。
- 可选图片生成 stage。
- 图片版权/缓存/清理策略。

### Viewer 仍是轻量版

当前 V3 前端不是 V2 的完整项目/聊天历史体验。它更接近生成控制台：

- 单次请求。
- SSE 进度。
- 预览和下载。

如果要产品化为正式用户工作台，后续可规划：

- 左侧项目历史。
- 对话式需求迭代。
- 生成记录管理。
- 失败重试。
- 模板预览卡片。
- QA 报告可视化。

### 模板视觉一致性仍需要人工/自动评估

当前验证更多关注结构正确性和资源安全，不完全保证视觉审美：

- 标题是否过大。
- 卡片是否遮挡。
- 色彩是否协调。
- 模板风格是否完整继承。
- 每页密度是否合适。

后续可以加入：

- browser screenshot smoke。
- 视觉 QA 指标。
- 模板级设计规范。
- 人工评分样本集。

---

## 9. Practical Next Planning Directions

建议下一阶段按价值排序考虑：

1. **真实模型稳定性**
   - 收集 20-50 次 live job 的 source、warnings、latency、fallback。
   - 根据失败样本调整 Stage 1/2 prompts。

2. **模板 Anchor 质量**
   - 对所有模板输出 anchor 覆盖报告。
   - 优先修复高风险模板的漏填和 residue。

3. **前端产品化**
   - 增加 project history。
   - 增加已生成 deck 列表。
   - 增加失败 job 查看与重试。

4. **模板预览与选择体验**
   - 在前端展示模板缩略图。
   - 展示模板 capabilities。
   - 根据用户媒体开关过滤不可用模板或提示模板能力。

5. **素材体系**
   - 扩展本地图片库。
   - 建立图片 hint 到文件的索引。
   - 后续可选接入图片生成，但不要放进主链路默认路径。

6. **视觉 QA**
   - 增加 Playwright 截图检查。
   - 统计可见 slide 数、遮挡、溢出、首屏内容完整性。
   - 对高风险模板做固定 prompt 回归。

---

## 10. Current Implementation Boundary

V3 当前明确不做：

- 不复用 V2 的 renderer 编排。
- 不让模型输出 HTML/CSS/JS。
- 不在最终 HTML 中删除禁用媒体页作为主策略。
- 不默认调用图片生成。
- 不默认支持音频页。
- 不把 V3 作为 V2 项目聊天系统的直接替代品。

V3 当前明确依赖：

- Gemini full-deck templates 的 `manifest-v2` 质量。
- 后台 active LLM config。
- PostgreSQL job 表。
- 本地 output directory。
- 前端 Next proxy 到 Nest backend。
