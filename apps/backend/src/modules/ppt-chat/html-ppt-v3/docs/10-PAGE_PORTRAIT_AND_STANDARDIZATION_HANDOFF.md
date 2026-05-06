# HTML-PPT V3 页肖像与标准化改版主 Agent 交接

本文档给主 agent 使用，目标是让编排框架代码按当前 V3 模板 contract 工作。这里描述的是已经落地的实现状态，不是待设计方案。

## 1. 核心结论

- `manifest-v2.json` 是唯一 JSON source of truth。Gemini 模板目录中的 legacy `manifest.json` 已清理，任何新代码不得读取它。
- 中间页选择键已经从 `pageType` 切到 `fragmentId`。`pageType` 只保留为大类标签，例如 `grid-2`、`chart`、`sidebar`。
- 每个源中间页都独立生成 fragment：`fragments/slide-02.html`、`fragments/slide-03.html` 等。重复 `pageType` 不再去重。
- `pagePortrait` 是模型选型依据，描述页面布局、组件、密度、标签和适用场景。
- 多图表页使用 `chartSlots + chartDataBySlot`。legacy `chartData/chartCanvasSelector` 只作为单图表 `primary` 兼容入口。
- 每个 anchor 都包含 `tarChars` 和 `maxChars`；`tarChars` 是推荐写作长度，`maxChars` 是硬上限。
- parser 已把 SVG/CSS 图表目标标准化为 `canvas[data-chart-slot]`，并收紧媒体检测，避免 `image-placeholder`、`video-frame`、`play-btn` 误判。

## 2. 当前接口契约

`TemplateManifestV2.pool`：

```ts
Record<fragmentId, PageFragment>
```

`PageFragment` 关键字段：

```ts
{
  fragmentId: string;              // slide-09
  pageType: PageType;              // chart/grid-2/sidebar...
  sourcePageType?: PageType;
  sourceSlideIndex: number;
  sourceSlideTitle: string;
  htmlFile: string;                // fragments/slide-09.html
  pagePortrait: PagePortrait;
  chartSlots: ChartSlot[];
  chartCanvasSelector?: string;    // legacy primary alias only
  anchors: SlotAnchor[];
  mediaKinds: MediaKind[];
}
```

`PagePortrait` 关键字段：

```ts
{
  summary: string;
  layoutFamily: "cover" | "closing" | "grid" | "chart" | "mixed" | "table" | "media" | "timeline" | "text";
  componentSignature: string;      // grid:1x2 x1 + chart:line x1 + stat x1
  density: "low" | "medium" | "high";
  components: PageComponent[];
  componentCounts: Record<string, number>;
  tags: string[];
  useCases: string[];
}
```

`ChartSlot` 关键字段：

```ts
{
  slotId: string;                  // primary/chart-1/chart-2
  selector: string;                // canvas[data-chart-slot='primary']
  kind: "line" | "bar" | "xbar" | "s" | "pie" | "donut" | "gantt" | "area" | "unknown";
  defaultRenderType: "line" | "bar" | "pie" | "gantt";
  componentId: string;
}
```

`SlotAnchor` 关键字段：

```ts
{
  slotId: string;
  selector: string;
  tarChars: number;                // 推荐目标，ceil(maxChars / 2)
  maxChars: number;                // 硬上限
  optional: boolean;
  kind?: SlotAnchorKind;
  sourceText?: string;             // 只存 manifest，不进 Stage 2 prompt
}
```

`PlanIR.slides[]`：

- cover/closing 不要求 `fragmentId`。
- 所有中间页必须包含 `fragmentId`。
- 中间页 `pageType` 必须等于 `manifest.pool[fragmentId].pageType`。

`ContentIR.slides[]`：

- 中间页必须回显 `fragmentId`，并与 PlanIR 一致。
- 含 `chartSlots` 的页面必须输出 `chartDataBySlot`，每个 `slotId` 都必须有数据。
- 只有没有 `chartSlots` 的 legacy chart 页才使用 `chartData`。

## 3. 标准化与页肖像生成

模板再生成入口仍是 `manifest-v2.parser.ts`，但 source 变为：

- 必需：`index.html`
- 必需：现有或新生成的 `manifest-v2.json`
- 可选：无。`manifest.json` 不再存在，也不应作为依赖。

标准化规则：

- cover/closing 固定输出 `fragments/cover.html`、`fragments/closing.html`。
- 中间页按源页序输出 `fragments/slide-XX.html`，例如源第 9 页是 `slide-09`。
- 所有中间源页都进入 `pool`，不按 `pageType` 去重。
- chart 标准化会识别 canvas、SVG 图表、CSS 图表容器，替换为独立 canvas slot。
- 一页多个 chart target 时生成多个 `chartSlots`，Stage 3 逐 slot 注入。
- anchor 标准化会写入 `tarChars`，位置在 `maxChars` 前；只有 cover 页 `slotId` 含 `body` 的 anchor 使用压缩容量，非 cover 页保持原 manifest 容量。
- `pagePortrait` 同时保留混合页的所有组件。例如 `grid + xbar-chart + s-chart` 不能被简化成纯 chart。
- grid 描述必须区分 `1x4`、`2x2`、`1x2` 等布局，优先使用 CSS grid 信息，缺失时按子项数量 fallback。
- 媒体检测只以真实媒体 DOM、slot、URL 或强语义类名为准；静态占位类不应污染 `mediaKinds`。

## 4. 主 Agent 编排适配点

Stage 0：

- 输出 `availableMiddleFragments`，不要再输出或依赖 `availableMiddlePageTypes` 作为选择键。
- pool 裁剪必须基于 fragment 级 `mediaKinds` 和能力标记，不能只看 `pageType`。
- 进度日志建议保持 `availableMiddleFragments=slide-XX/pageType:mediaKinds`，便于排查物理剪枝。

Stage 1：

- Prompt 展示 `fragmentId + pagePortrait + chartSlots + media flags`。
- 模型必须从 `allowedMiddleFragmentIds` 选择中间页，可重复选择。
- PlanIR 校验必须拒绝缺少 `fragmentId` 的中间页。
- PlanIR 校验必须拒绝 `fragmentId` 不存在或 `pageType` 不匹配的中间页。

Stage 2：

- Prompt 按 `fragmentId` 回取 fragment，暴露 `pagePortrait/anchors/chartSlots/mediaKinds`。
- `anchors` 暴露 `slotId/kind/tarChars/maxChars/optional`；模型以 `tarChars` 为推荐长度，以 `maxChars` 为硬截断上限。
- 不发送完整 HTML、CSS、anchor selector、`sourceText`。
- 含 `chartSlots` 的页面必须要求 `chartDataBySlot` 覆盖所有 slot。
- `ContentIR` 校验必须检查 `fragmentId` 与 PlanIR 对齐。

Stage 3：

- Stitching 必须按 `fragmentId` 取中间页 fragment。
- 生成的 section 可保留 `data-fragment-id`，用于调试实际选中的页变体。
- Chart injector 遍历 `fragment.chartSlots`，每个 canvas 分配独立 id，并生成独立 Chart.js init script。
- legacy `chartData` 只在单图表 `primary` fallback 时使用。

模板工具链：

- 不得读取 legacy `manifest.json`。
- 需要源页数量时，从 `index.html` 的 `section.slide` 或 `manifest-v2.sourceSlideIndex` 推导。
- 清理后 fragment 目录只应保留 manifest-v2 引用的 HTML 文件。

## 5. 代表案例

`11-corporate-consulting`：

- 中间页数量：11。
- `slide-09`、`slide-10`、`slide-11` 都是独立 chart fragment。
- 三页 `pageType` 都是 `chart`，但 `fragmentId`、布局和 chart kind 不同。
- 当前肖像摘要：
  - `slide-09`: `grid:1x2 x1 + chart:line x1 + card x2 + stat x1 + list x1`
  - `slide-10`: `grid:1x2 x1 + chart:pie x1 + card x2`
  - `slide-11`: `grid:1x3 x1 + chart:bar x1 + card x1 + stat x3`

`22-quantum-computing`：

- 中间页数量：17。
- 默认媒体开关全 false 时，模型只能看到非媒体 fragments：`slide-04`、`slide-06`、`slide-15`、`slide-16`、`slide-17`、`slide-18`。
- `includeChart=true` 时追加 `slide-07` 到 `slide-10`。
- `includeImages=true` 时追加 `slide-02`、`slide-03`、`slide-05`、`slide-13`、`slide-14`。
- `includeAudio=true` 时追加 `slide-11`；`includeVideo=true` 时追加 `slide-12`。

## 6. 验证命令

主 agent 完成任何编排适配后至少运行：

```powershell
npm run verify:html-ppt-v3-templates --workspace @codex/backend
npm run verify:html-ppt-v3-shared --workspace @codex/backend
npm run verify:html-ppt-v3-stage1 --workspace @codex/backend
npm run verify:html-ppt-v3-stage2 --workspace @codex/backend
npm run verify:html-ppt-v3-stage3 --workspace @codex/backend
npm run verify:html-ppt-v3-no-residue --workspace @codex/backend
npm run verify:html-ppt-v3-agent --workspace @codex/backend
npm run verify:html-ppt-v3-stage25 --workspace @codex/backend
npm run verify:html-ppt-v3-matrix --workspace @codex/backend
npm run typecheck --workspace @codex/backend
```

`verify:html-ppt-v3` 包含 live smoke。只有真实 LLM 环境配置完成时再跑整包命令。

## 7. 不变量

- 模型永远不直接看完整 fragment HTML，不写 HTML/CSS/JS。
- 中间页选择永远用 `fragmentId`。
- `pageType` 永远只表示大类，不可作为唯一模板键。
- `manifest-v2.json` 是唯一 JSON source of truth。
- 每个源中间页必须有且只有一个 manifest 引用的 `slide-XX.html` fragment。
- chart 语义类型和 Chart.js 渲染类型分离；`xbar/s/unknown` 可以默认按 `line` 渲染。
- no-media 需求必须在 Stage 0 物理剪枝完成，不应依赖后续阶段“不要选”。
