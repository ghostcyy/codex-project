# HTML-PPT V3 模板学习路径与交接文档

本文档面向新开的 Codex 对话，目标是让接手者快速理解 HTML-PPT V3 的 Gemini 模板体系，并能独立处理“模板解析、模板质量、候选池、模型填充、注入修复”相关问题。

范围以 V3 Gemini 模板系统为主。原始 `html-ppt` skill 只作为学习背景，不展开 V1/V2 renderer 历史。

## 1. 阅读路线

建议按下面顺序阅读，避免直接跳进 injector 或 prompt 导致上下文错位。

1. 先读原始 skill：
   - `C:\Users\YuanYuan\Person\Software\Codex\.agents\skills\html-ppt\SKILL.md`
   - 重点理解：主题、full-deck、runtime、slide、deckClass、anchors、静态 HTML deck 的设计思想。

2. 再读 V3 设计文档：
   - `apps/backend/src/modules/ppt-chat/html-ppt-v3/docs/01-ARCHITECTURE.md`
   - `apps/backend/src/modules/ppt-chat/html-ppt-v3/docs/02-INTERFACE_CONTRACTS.md`
   - `apps/backend/src/modules/ppt-chat/html-ppt-v3/docs/03-TEMPLATE_FRAGMENT_SPEC.md`
   - `apps/backend/src/modules/ppt-chat/html-ppt-v3/docs/07-CURRENT_IMPLEMENTATION_SUMMARY.md`

3. 最后读 V3 代码链路：
   - `shared/`：冻结数据契约、Zod schema、request/job/PlanIR/ContentIR/manifest-v2 类型。
   - `manifest/`：模板解析、fragment 生成、mediaKinds 检测。
   - `prompts/`：Stage 1/2 prompt，只给模型结构化候选与 anchors。
   - `stages/`：Stage 0/1/2/2.5/3 的执行入口。
   - `injector/`：HTML 注入、slot 填充、图片/图表处理、页码/残留清理、nav runtime。
   - `orchestration/`：串联各阶段、发送 SSE 进度、调用 packager。

## 2. 当前模板架构

### 2.1 模板来源

V3 的模板 source of truth 是：

`C:\Users\YuanYuan\Person\Software\Codex\.agents\skills\html-ppt\templates\full-decks\gemini\*`

每个 Gemini 模板目录通常包含：

| 文件或目录 | 职责 |
| --- | --- |
| `index.html` | 原始 demo deck，保留完整展示页和示例内容，用于解析 source sections。 |
| `style.css` | 模板主样式，通常按 `body.<deckClass>` 或 `.tpl-*` 作用域编写。 |
| `shell.html` | V3 运行时 shell，包含 head、CSS/JS 引用和 `<!-- SLIDES -->` 插入点。 |
| `manifest-v2.json` | V3 模板清单，唯一 JSON source of truth，描述 fixed cover/closing、中间页 pool、anchors、pagePortrait、chartSlots、mediaKinds、assetDirs。 |
| `fragments/*.html` | 从原始 section 抽取并规范化后的单页 fragment。中间页按源页号写为 `slide-XX.html`，不再按 `pageType` 去重。 |
| `assets/` | 本地基础运行资源，例如 `base.css`、`fonts.css`、`runtime.js`、animations。 |
| `img/` | 模板本地图片库与 `_placeholder.jpg`。V3 最终图片引用必须走相对 `img/...`。 |

### 2.2 源模板与生成产物的区别

源模板是“可学习的视觉示例”，生成产物是“按用户主题重新填充后的 deck”。二者不能混同。

| 层级 | 是否给模型看完整 HTML | 主要用途 |
| --- | --- | --- |
| 原始 `index.html` | 不直接给模型看 | 提供 section、视觉结构、可抽取文本、媒体结构。 |
| `fragments/*.html` | 不直接给模型看完整内容 | Injector 的确定性拼接单位。 |
| `manifest-v2.json` | 通过 Stage 0/1/2 转成结构化摘要 | 告诉模型哪些 `fragmentId` 可选、每页页肖像是什么、有哪些 anchors/chartSlots 需要填。 |
| Stage 1 prompt | 否 | 只给裁剪后的候选池摘要，让模型规划页型和页标题。 |
| Stage 2 prompt | 否 | 只给每页 anchors：`slotId/kind/tarChars/maxChars/optional`，让模型填文案和图表数据。 |
| 最终 `index.html` | 模型不写 | 本地 injector 拼接 fragments、填 slots、注入图表/图片/runtime。 |

核心原则：模型不应该看到完整模板 HTML，不应该复制模板示例文案，也不应该直接写 HTML/CSS/JS。

### 2.3 关键运行概念

- `deckClass`：模板 CSS 作用域，例如 `tpl-interior-design`。若 deckClass 错或 body class 丢失，样式会整体失效。
- `.slide.is-active`：基础运行样式用它控制当前页显隐。若 `assets/base.css` 缺失或路径错误，会出现所有页堆叠在一个页面。
- `.slide-number`：页码容器。V3 会写入 `data-current/data-total`，由模板 CSS 或文本机制显示真实页码。
- `.progress-bar`：PPT 进度条。V3 nav runtime 会确定性创建或更新它。
- `fragmentId`：模型稳定选页键，例如 `slide-09`。中间页必须用它精确选择具体页面变体。
- `pageType`：页面大类，例如 `chart/grid-2/grid-3`。它只用于分类和兼容，不再作为 pool 唯一键。
- `pagePortrait`：页肖像，给模型看的布局和组件摘要，包含 `summary/componentSignature/tags/useCases/components/componentCounts`。
- `chartSlots`：一页可以有多个图表槽，例如 `primary`、`chart-1`、`chart-2`。每个槽有独立 selector、语义 kind 和 Chart.js 默认渲染类型。
- `canvas[data-chart-slot]`：图表占位，由 Stage 3 根据 ContentIR 的 `chartDataBySlot` 逐 slot 注入 Chart.js 初始化脚本。legacy `chartData` 只兼容单图表 `primary`。
- `mediaKinds`：每个 fragment 的真实媒体能力标记，包含 `image/video/chart/audio`。Stage 0 物理裁剪候选池时以它为准。
- `tarChars/maxChars`：`tarChars` 是推荐写作长度，`maxChars` 是硬上限。当前只有 cover 页 `slotId` 含 `body` 的 anchor 使用压缩容量；非 cover 页保持原 manifest 容量，并令 `tarChars=ceil(maxChars/2)`。

## 3. 模板解析链路

模板解析入口是：

`apps/backend/src/modules/ppt-chat/html-ppt-v3/manifest/manifest-v2.parser.ts`

它的目标是把 legacy Gemini 模板转换成 V3 可控的 `manifest-v2.json + fragments + shell.html`。

### 3.1 解析流程

1. 读取模板目录中的 `index.html`，并以 `manifest-v2.json` 作为模板元数据来源；legacy `manifest.json` 已清理，不应再依赖。
2. 从 `index.html` 抽取每个 `<section class="slide">`。
3. 规范化每页 `data-page-type`，区分 cover、closing、中间页，并为源页生成稳定 `fragmentId=slide-XX`。
4. 对 section 执行结构清理：
   - 移除原模板内联脚本，避免与 V3 runtime 冲突。
   - `<img>` 转换为 `data-image-slot`。
   - 所有 chart canvas、SVG 图表、CSS 图表容器转为独立 `canvas[data-chart-slot]`，并生成 `chartSlots[]`。
   - video/audio/chart/image 结构交给 media detector 标记。
5. 把每页写成独立 fragment。cover/closing 固定为 `fragments/cover.html`、`fragments/closing.html`，中间页按源页号写为 `fragments/slide-XX.html`。
6. 为每页生成 `pagePortrait`，识别 grid 行列、card/stat/list/table/image/video/chart 等组件。混合页必须保留全部组件，例如 `grid x1 + xbar-chart x1 + s-chart x1`。
7. 生成 `manifest-v2.json`，包含 fixed cover/closing、中间页 pool、anchors、pagePortrait、mediaKinds、chartSlots、chart/image/video selector 等；每个 anchor 都写入 `tarChars`，且该字段位于 `maxChars` 前。
8. 生成或同步 `shell.html`，作为 Stage 3 拼接最终 deck 的外壳。

### 3.2 visible text 如何变成 anchors

V3 不让模型直接改 HTML，而是把“用户可见且应该随主题变化的文字”提升成 anchors。

核心策略：

- 扫描 `h1/h2/h3/h4/p/li/td/th/span/small/strong/em/div` 等可见文本节点。
- 优先给语义块建立 anchor，例如标题、段落、列表项、卡片标题、指标数字、表格单元格、badge、footer。
- 避免给同一句话的内层 `span/strong` 重复建 anchor。
- 跳过页码、进度条、运行时控件、纯图标、纯装饰符。
- 对 footer 类容器要谨慎：不能把包含 `.slide-number` 或 `.progress-bar` 的整个容器注册为 anchor，只能注册其中普通文本子节点。

Anchor 关键字段：

| 字段 | 说明 |
| --- | --- |
| `slotId` | 给模型和 injector 对齐用的唯一槽位 ID。 |
| `selector` | 本地 injector 定位 DOM 用，不发送给模型。 |
| `kind` | 文本语义，例如 `title/body/listItem/statNumber/footer/badge/cta`。 |
| `tarChars` | 推荐写作长度，当前为 `ceil(maxChars / 2)`。 |
| `maxChars` | 模型填充的硬长度上限。 |
| `optional` | 可选 anchor 是否允许缺失。 |
| `sourceText` | 原模板文本，仅用于本地 residue 检测和调试，不发送给模型。 |

### 3.3 mediaKinds 如何识别

媒体识别入口是：

`apps/backend/src/modules/ppt-chat/html-ppt-v3/manifest/media-kind-detector.ts`

识别规则覆盖：

- `image`：`<img>`、`data-image-slot`、图片类名、`style="background:url(...)"`、CSS `url(...)`、本地或远程图片 URL。
- `chart`：`<canvas>`、`data-chart-slot`、`.chart-card`、`.line-chart/.bar-chart/.pie-chart/.xbar-chart/.s-chart`、图表 SVG 等。
- `audio`：`<audio>`、`.audio-frame`、`.audio-player`、语音波形、音频文件扩展名等。普通 `.play-btn` 不单独判定为 audio，避免误伤静态视觉按钮。
- `video`：`<video>`、`data-video-slot`、视频文件扩展名等。普通 `.video-frame` 不单独判定为 video，避免误伤静态展示卡片。

新增或修改模板后必须重新生成 `manifest-v2.json` 和 fragments，并跑模板校验。不要只改最终 HTML。

## 4. 模板如何供给模型选择

### 4.1 Stage 0：候选池构建

入口：

`apps/backend/src/modules/ppt-chat/html-ppt-v3/stages/stage0-pool-build.ts`

核心逻辑在：

`apps/backend/src/modules/ppt-chat/html-ppt-v3/shared/plan-ir.types.ts`

`buildAvailablePool()` 读取 `manifest-v2.json`，并按用户开关做物理裁剪。`AvailablePool.middle` 是 `Record<fragmentId, PageTypeSummary>`，不是 `Record<pageType, ...>`。

- `includeImages=false`：移除所有 image pageType 和 `mediaKinds` 包含 `image` 的 fragment。
- `includeVideo=false`：移除所有 video pageType 和 `mediaKinds` 包含 `video` 的 fragment。
- `includeChart=false`：移除所有 chart pageType 和 `mediaKinds` 包含 `chart` 的 fragment，同时 `chartTypesAvailable=[]`。
- `includeAudio=false`：移除所有 audio pageType 和 `mediaKinds` 包含 `audio` 的 fragment。

这一步是源头控制。模型没有看到的 fragment，不应该在最终产物出现。Stage 0 进度日志会输出 `availableMiddleFragments=slide-XX/pageType:mediaKinds`，用于确认物理剪枝结果。

### 4.2 Stage 1：Planner 选择页面结构

入口：

`apps/backend/src/modules/ppt-chat/html-ppt-v3/stages/stage1-planner.ts`

Prompt：

`apps/backend/src/modules/ppt-chat/html-ppt-v3/prompts/stage1-planner.prompt.ts`

Stage 1 是第一次文本模型调用。模型只接收：

- 用户请求：`theme/pageCount/wordBudget/templateId/includeImages/includeVideo/includeChart/includeAudio`。
- 裁剪后的 `AvailablePool` 摘要。
- 固定 cover/closing。
- 可选中间页 `fragmentId` 列表。
- 每个候选页的 `pageType/pagePortrait.summary/componentSignature/tags/useCases/chartSlots/mediaKinds`。
- 可选 chartTypes，仅在 `includeChart=true` 时存在。

模型输出 `PlanIR`，只负责：

- 精确页数规划。
- 首页必须 cover。
- 末页必须 closing。
- 中间页必须从裁剪后的 `allowedMiddleFragmentIds` 选择 `fragmentId`，并回填匹配的 `pageType`。
- 给每页生成 `title/topicPoints/charBudget`。
- 如果选择 legacy 单图表 chart 页，选择合法 `chartType`；如果 fragment 已有 `chartSlots`，以 slot 的 `defaultRenderType` 为准。

`validatePlanIR()` 会拒绝：

- 页数不精确。
- slideIndex 不连续。
- 中间页缺少 `fragmentId`。
- `fragmentId` 不在 pool，或输出的 `pageType` 与该 fragment 的 `pageType` 不一致。
- 未勾选媒体却输出 image/chart/video/audio。
- chartType 不合法。
- 总字数预算偏差超过允许范围。

## 5. 模板如何供给模型填充

### 5.1 Stage 2：Writer 填充 anchors

入口：

`apps/backend/src/modules/ppt-chat/html-ppt-v3/stages/stage2-writer.ts`

Prompt：

`apps/backend/src/modules/ppt-chat/html-ppt-v3/prompts/stage2-writer.prompt.ts`

Stage 2 是第二次文本模型调用。模型不重新选页，不写 HTML，只接收：

- Stage 1 已通过校验的 `PlanIR`。
- 每页的 `fragmentId`，用于精确取回具体页变体。
- 每页的 `pagePortrait` 和 `chartSlots`。
- 每页对应 fragment 的 `anchors` 摘要。
- 每个 anchor 只暴露：`slotId/kind/tarChars/maxChars/optional`。
- 需要 `chartDataBySlot`、imageHints、videoHint 的提示。

不会发送给模型：

- 完整 HTML。
- CSS。
- anchor selector。
- `sourceText`。
- 被 Stage 0 裁剪掉的 fragment。

模型输出 `ContentIR`：

| 字段 | 用途 |
| --- | --- |
| `fragmentId` | 回显 PlanIR 的选页键，中间页必须一致。 |
| `slotFills` | 按 `slotId` 填充正文、标题、指标、badge、footer 等。 |
| `chartDataBySlot` | 多图表页的主路径，按 `slotId` 提供 labels/datasets。 |
| `chartData` | legacy 单图表兼容入口，只作为 `primary` 的 fallback。 |
| `imageHints` | 图片页或图片 slot 的生成/检索提示。 |
| `videoHint` | 视频页提示，当前 V3.1 不作为主路径。 |

`validateContentIR()` 会检查：

- slide 数量和 PlanIR 对齐。
- pageType 和 PlanIR 对齐。
- fragmentId 和 PlanIR 对齐。
- 必填 anchors 必须填。
- 文案以 `tarChars` 为推荐目标，不超过 `maxChars`。
- 含 `chartSlots` 的页面必须提供 `chartDataBySlot`，并覆盖每个 `slotId`。
- legacy chart 页必须提供合法 `chartData`。
- image/video 相关字段与当前 fragment 需求一致。

## 6. 本地注入与产物生成

### 6.1 Stage 2.5：图片生成

如果用户启用图片页，且 PlanIR/ContentIR 中确实包含图片 slot，Stage 2.5 会调用 MiniMax 图片生成能力。

相关代码：

- `apps/backend/src/modules/ppt-chat/html-ppt-v3/stages/stage2_5-image-generation.ts`
- `apps/backend/src/modules/ppt-chat/html-ppt-v3/image-gen/minimax-image-client.ts`
- `apps/backend/src/modules/ppt-chat/html-ppt-v3/shared/generated-image.types.ts`

输出是 `GeneratedImageMap`，保存到 job 输出目录下的相对路径，例如：

`img/generated/slide-05-slot-01.png`

图片失败不会阻断 PPT 生成，会写 warning，并由 Stage 3 fallback 到模板本地图片或 `_placeholder.jpg`。

### 6.2 Stage 3：Injector 确定性生成 HTML

入口：

`apps/backend/src/modules/ppt-chat/html-ppt-v3/stages/stage3-injector.ts`

主要模块：

| 模块 | 职责 |
| --- | --- |
| `deck-stitcher.ts` | 根据 PlanIR 的 `fragmentId` 选择具体 fragments 并拼接 deck。 |
| `slot-filler.ts` | 用 ContentIR 填充 anchors，缺失必填项时生成主题化 fallback。 |
| `strong-parser.ts` | 把 `|STRONG|` 标记转成强调标签。 |
| `image-resolver.ts` | 解析图片路径，优先生成图片，其次模板本地 `img/`，最后 placeholder。 |
| `chart-injector.ts` | 遍历 `chartSlots`，根据 `chartDataBySlot` 为每个 canvas 生成独立 Chart.js 初始化脚本。 |
| `post-stitch-cleaner.ts` | 重写页码、替换模板残留、清理旧 demo 文本。 |
| `nav-runtime.ts` | 注入 V3 翻页 runtime，维护 postMessage 状态和 progress bar。 |

关键规则：

- 缺失必填 anchor 时不能保留模板原文，必须 fallback。
- `sourceText` 命中模板残留时，必须替换为主题化文案。
- `.slide-number` 由本地脚本按最终实际页序写 `data-current/data-total`。
- `.progress-bar` 由 V3 nav runtime 创建或更新。
- 图片路径必须是相对 `img/...`，不能出现远程图片 URL。
- Chart canvas 不依赖原模板脚本，由 V3 按 slot 重新合成 init script；一页多个图表会生成多个 canvas id 和多个 init script。

### 6.3 Stage 4：Packager

Stage 4 不调用模型，只负责：

- 复制模板资产。
- 写最终 `index.html`。
- 打包 zip。
- 生成 preview/download 路径。
- 保证 preview 资源以 jobId 作用域访问，拒绝路径穿越。

## 7. 示例：`11-corporate-consulting` 三张 chart 页链路

这个模板适合验证“按页 fragment”和“页肖像”是否生效。源模板第 9/10/11 页都包含图表，但布局和图表语义不同，因此必须分别成为 `slide-09`、`slide-10`、`slide-11` 三个 pool 条目。

### 7.1 Fragment 生成

解析器会把三张源页转换为：

| 源页 | fragmentId | htmlFile | chartSlots 预期 |
| --- | --- | --- | --- |
| 第 9 页 | `slide-09` | `fragments/slide-09.html` | `kind: "line"` |
| 第 10 页 | `slide-10` | `fragments/slide-10.html` | `kind: "pie"` |
| 第 11 页 | `slide-11` | `fragments/slide-11.html` | `kind: "bar"` |

关键变化：

- 原始 SVG/CSS 图表目标会被替换为 `canvas[data-chart-slot]`。
- 每个图表目标生成独立 `ChartSlot`，单图表页通常用 `slotId: "primary"`。
- 周边 grid/card/stat 等结构会进入 `pagePortrait.components`，不能因为页面有 chart 就丢掉 grid 信息。
- 原模板内联脚本和 demo 图例会被移除，由 V3 Stage 3 统一注入图表。

### 7.2 Manifest 中的 pool

`manifest-v2.json` 的中间页 pool 应按 `fragmentId` 存储：

```json
{
  "pool": {
    "slide-09": { "fragmentId": "slide-09", "pageType": "chart" },
    "slide-10": { "fragmentId": "slide-10", "pageType": "chart" },
    "slide-11": { "fragmentId": "slide-11", "pageType": "chart" }
  }
}
```

注意：三个条目的 `pageType` 都可以是 `chart`，但它们不是同一个模板。模型选择必须用 `fragmentId`，`pageType` 只是分类。

### 7.3 pagePortrait 如何描述差异

每页都要有页肖像，常用字段包括：

- `summary`：给模型看的短描述。
- `layoutFamily`：`chart/grid/mixed/...`。
- `componentSignature`：例如 `grid:1x2 x1 + chart:line x1 + stat x1`。
- `componentCounts`：例如 `{ "grid": 1, "chart": 1, "chart:line": 1 }`。
- `tags/useCases`：用于提示模型选择“趋势分析、结构对比、指标看板”等场景。

grid 描述要区分 `1x4`、`2x2`、`1x2` 等布局。混合页必须保留所有组件，例如一页有 `grid + xbar-chart + s-chart`，元数据应同时表达 `grids=1/chartsByKind.xbar=1/chartsByKind.s=1` 这类信息。

### 7.4 Stage 1 如何选择具体 chart 页

只有当 `includeChart=true` 时：

- `buildAvailablePool()` 保留 `mediaKinds` 包含 `chart` 的 fragments。
- Stage 1 prompt 展示 `availableMiddleFragments`，每项带 `fragmentId/pageType/pagePortrait/chartSlots`。
- 模型必须输出 `fragmentId: "slide-09"` 这种精确键，同时输出匹配的 `pageType: "chart"`。

如果 `includeChart=false`，这些 fragment 不会进入 prompt；模型即使幻觉输出 chart，也会被 `validatePlanIR()` 拒绝。

### 7.5 Stage 2/3 如何处理多图表

Stage 2 对含 `chartSlots` 的页面必须输出：

```json
{
  "fragmentId": "slide-09",
  "pageType": "chart",
  "chartDataBySlot": {
    "primary": {
      "type": "line",
      "labels": ["A", "B", "C"],
      "datasets": [{ "label": "趋势", "data": [1, 2, 3] }]
    }
  }
}
```

如果一页有多个 slot，`chartDataBySlot` 必须覆盖每个 `slotId`。Stage 3 会遍历 `fragment.chartSlots`，为每个 canvas 生成独立 id 和独立 Chart.js init script。

## 8. 常见模板问题排查手册

### 8.1 模板预览白屏

优先检查：

- `shell.html` 或预览 HTML 是否带正确 `deckClass`。
- `assets/base.css` 是否存在并被加载。
- `.slide.is-active` 是否存在显隐规则。
- 当前预览页是否被正确加上 `is-active`。

### 8.2 图表空白

优先区分是“模板预览空白”还是“最终 deck 空白”。

- 预览空白：可能是预览层没有执行原模板脚本或没有静态 chart fallback。
- 最终 deck 空白：检查 `canvas[data-chart-slot]`、PlanIR 的 `fragmentId`、fragment 的 `chartSlots`、ContentIR 的 `chartDataBySlot`、Stage 3 生成的 chart init script。

### 8.3 图片页越权

症状：用户未勾选图片页，但最终 PPT 出现图片页。

排查顺序：

1. 检查对应 fragment DOM 是否有 `<img>`、背景 `url(...)`、图片类名。
2. 检查 `manifest-v2.json` 的 `mediaKinds` 是否包含 `image`。
3. 检查 Stage 0 pool 在 `includeImages=false` 时是否移除了该 fragment。
4. 检查 Stage 1 prompt 中是否仍泄漏 image fragment。

主修复点应是 parser/mediaKinds/source template，不是最终 HTML 删除。

### 8.4 远程图片泄漏

最终 HTML/CSS 不允许出现远程图片 URL。

检查范围：

- `index.html`
- `shell.html`
- `style.css`
- `fragments/*.html`
- inline style 的 `background:url(...)`

远程图片应改为模板本地 `img/...`，或者改为非图片渐变背景。

### 8.5 模板残留

症状：最终 PPT 里出现 `ECO_HARMONY // 2026`、`MATERIAL_DATA`、`Board of Directors`、`APAC Growth` 等模板 demo 文本。

排查顺序：

1. 该文本是否被提升成 anchor。
2. anchor 是否有 `sourceText`。
3. Stage 2 prompt 是否包含对应 `slotId/kind/tarChars/maxChars`。
4. ContentIR 是否填了对应 slot。
5. `post-stitch-cleaner` 是否能按 `sourceText` 命中并 fallback。

如果可见正文没有 anchor，应修 `promoteVisibleTextAnchors` 或模板结构，不要只在最终 HTML 搜索删除。

### 8.6 页码异常

症状包括：页码缺失、重复显示、显示 `606/15/15`、保留原模板总页数。

检查：

- `.slide-number` 是否被 anchor 覆盖导致删除。
- `post-stitch-cleaner.ts` 是否写入正确 `data-current/data-total`。
- 文本内容是否被清空以避免和 CSS `attr()` 伪元素重复。
- 模板 CSS 是否同时用文本和伪元素显示页码。

### 8.7 进度条缺失

检查：

- V3 nav runtime 是否被注入。
- `.progress-bar > span` 是否被创建。
- 翻页时 progress width 是否更新。
- 是否错误恢复了原模板 `assets/runtime.js` 并与 V3 runtime 冲突。

### 8.8 样式不生效

检查：

- body 是否有正确 `deckClass`。
- `style.css` 是否被复制到 outputDir。
- `assets/base.css` 路径是否本地化，不能是 `../../../../assets/...`。
- `shell.html` 的 CSS 引用是否和 packager 输出结构一致。

## 9. 新 Codex 接手建议

### 9.1 第一条完整追踪路径

建议从单个模板开始，例如 `11-corporate-consulting`：

1. 打开源模板 `index.html`，找到第 9/10/11 页 chart。
2. 查看对应 `fragments/slide-09.html`、`fragments/slide-10.html`、`fragments/slide-11.html`。
3. 查看 `manifest-v2.json` 中这些 fragment 的 `fragmentId/pageType/pagePortrait/chartSlots/mediaKinds/anchors`。
4. 构造 `includeChart=true` 的 Stage 0 pool。
5. 查看 Stage 1 prompt 中模型看到的 `availableMiddleFragments`。
6. 查看 Stage 2 prompt 中该页 anchors 和 `chartDataBySlot` 要求。
7. 跑 Stage 3，检查最终 `index.html` 的 slot fills、chart init、页码、进度条。

### 9.2 修复优先级原则

遇到模板问题时，优先从源头修：

1. 源模板结构和本地资源。
2. parser 规则。
3. manifest-v2 字段。
4. Stage 0 候选池。
5. Stage 1/2 prompt payload。
6. Stage 3 injector fallback。

不要把“最终 HTML 删除某个坏元素”作为主修复路径。那通常会掩盖候选池、anchors 或 mediaKinds 的源头错误。

### 9.3 修改后最小验证命令

常用命令：

```powershell
npm run generate:html-ppt-v3-manifests --workspace @codex/backend
npm run verify:html-ppt-v3-templates --workspace @codex/backend
npm run verify:html-ppt-v3-stage1 --workspace @codex/backend
npm run verify:html-ppt-v3-stage2 --workspace @codex/backend
npm run verify:html-ppt-v3-stage3 --workspace @codex/backend
npm run verify:html-ppt-v3-no-residue --workspace @codex/backend
npm run verify:html-ppt-v3-agent --workspace @codex/backend
npm run verify:html-ppt-v3-matrix --workspace @codex/backend
npm run typecheck --workspace @codex/backend
```

`verify:html-ppt-v3` 会包含 live smoke，只有配置了真实 LLM 环境时再跑。

如果只改模板 preview 前端，还要跑：

```powershell
npm run typecheck --workspace @codex/frontend
```

如果涉及图片页和本地图库，还要跑：

```powershell
npm run html-ppt-v3:img-audit --workspace @codex/backend
```

### 9.4 最小回归矩阵

建议至少覆盖：

| 场景 | 目的 |
| --- | --- |
| `includeImages=false/includeChart=false/includeAudio=false/includeVideo=false` | 确认媒体 fragment 被物理裁剪。 |
| `includeImages=true` | 确认图片 fragment 可进入候选池，最终图片路径为相对 `img/...`。 |
| `includeChart=true` | 确认 chart fragments 可进入候选池，最终 `chartDataBySlot` 被逐 slot 注入。 |
| `11-corporate-consulting` | 检查 `slide-09/10/11` 三张 chart 页、anchors 覆盖率、footer、页码、进度条、企业模板残留。 |
| `19-interior-design` | 检查 chart preview/final deck、浅色模板样式、页码。 |
| `06-realestate-smart` | 检查背景图片 URL 识别和图片页越权。 |

## 10. 接手者必须能回答的问题

读完本文档和对应代码后，新的 Codex 应该能回答：

- 一个 Gemini 模板目录里每个文件负责什么。
- `manifest-v2.json` 如何生成，为什么它是唯一 JSON source of truth。
- `fragmentId`、`pageType`、`pagePortrait`、`chartSlots` 各自负责什么。
- Stage 0/1/2 分别给模型什么，模型返回什么。
- 为什么模型选页必须用 `fragmentId`，不能再用 `pageType`。
- 为什么模型不应该看到完整 HTML。
- anchors、mediaKinds、sourceText、slotFills、chartDataBySlot 如何贯穿生成链路。
- 图片、图表、音频、视频为什么必须在候选池阶段物理裁剪。
- 页码、进度条、模板残留、远程图片泄漏应该从哪里查。
- 修模板问题时，为什么优先修 parser/manifest/source，而不是最终 HTML 删除。
