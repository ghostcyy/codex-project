# html-ppt-v3 — Template Fragment Specification

> 把 20 个固定 deck 模板转换成"骨架 + fragment 池"的规范。
> **主要读者**：Thread T（执行拆分）、Thread I（消费 fragment）。

---

## 1. 目标产物结构

每个模板转换后，目录结构变为：

```
.agents/skills/html-ppt/templates/full-decks/gemini/01-tech-web3/
├── manifest.json              ← v1（保留，本期不用，可删）
├── manifest-v2.json           ← 新增，本期权威
├── shell.html                 ← 新增，外壳框架
├── style.css                  ← 保留
├── assets/                    ← 保留
├── img/                       ← 保留
└── fragments/                 ← 新增子目录
    ├── cover.html
    ├── closing.html
    ├── grid-2.html
    ├── grid-3.html
    ├── grid-4.html
    ├── grid-5.html
    ├── chart.html
    ├── image-full.html        ← 仅当模板含此 pageType
    ├── sidebar.html
    └── title-text.html
```

**原 `index.html` 留在原地作为参考**，可以加 `.bak` 后缀；不被 v3 pipeline 消费。

---

## 2. shell.html 规范

`shell.html` 是 deck 的 HTML 框架，包含：
- `<!DOCTYPE html>`、`<head>`（含原模板的 `<meta>`、`<title>`、`<link rel="stylesheet">`）
- `<body class="<deckClass>">`
- 一个 `<main class="deck">` 容器
- 占位符注释 **`<!-- SLIDES -->`**（Stage 3 的 stitcher 替换为拼接好的所有 slide HTML）
- 末尾 `<script src="...">`（Chart.js、必要的导航 JS）+ 一个占位符 **`<!-- CHART_INITS -->`**（Stage 3 在此追加合成的 chart 初始化代码）

**示例**：
```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>{{deckTitle}}</title>
  <link rel="stylesheet" href="style.css">
  <script src="assets/chart.umd.min.js" defer></script>
</head>
<body class="tpl-web3">
  <main class="deck">
    <!-- SLIDES -->
  </main>
  <script>
    // 翻页导航 JS（轻量、自包含）
    document.addEventListener('DOMContentLoaded', () => { /* ... */ });
  </script>
  <!-- CHART_INITS -->
</body>
</html>
```

**禁止**：在 shell.html 里硬编码任何 `<section class="slide">`。

---

## 3. fragment HTML 规范

每个 fragment 文件**只包含**一个 `<section class="slide" data-page-type="<pageType>">…</section>`。
**禁止**包含 `<html>`、`<head>`、`<script>`。

**chart fragment**：必须含一个 `<canvas data-chart-slot="primary"></canvas>`。**不要**写 `id` 属性，由 stitcher 注入。**不要**自带 `new Chart(...)` 初始化。

**image fragment**：每个图位写 `<img data-image-slot="0">`（按下标对应 ContentIR.imageHints[0/1/...]）。`src` 由 image-resolver 注入。

**video fragment**：写 `<video data-video-slot="primary" controls></video>`，`src` 由 image-resolver 同样的查找逻辑选 `assets/videos/` 下的文件。

**示例 grid-3.html**：
```html
<section class="slide" data-page-type="grid-3">
  <div class="header">
    <span class="kicker"></span>
    <h2 class="h2"></h2>
  </div>
  <div class="content-area">
    <div class="grid-3">
      <div class="card"><h3></h3><p></p></div>
      <div class="card"><h3></h3><p></p></div>
      <div class="card"><h3></h3><p></p></div>
    </div>
  </div>
  <div class="footer"><span></span></div>
</section>
```

---

## 4. anchor selector 规范

每个 anchor 的 `selector` **必须**：
- 相对于 `<section class="slide">` 的根（不带 `section` 前缀）
- 唯一定位到一个元素（`:nth-child(N)` 必要时使用）
- 只匹配 `<h1>` `<h2>` `<h3>` `<p>` `<span>` 等**叶子文本元素**，不允许指向有子元素的容器（除非该元素是 cheerio 的 `.text(value)` 安全目标）

**slotId 命名约定**：
| 模式 | 含义 |
|---|---|
| `title` | 页主标题 |
| `kicker` | 副提示/小标签 |
| `subtitle` | 副标题 |
| `footer` | 页脚 |
| `card-N-heading` | 第 N 个 card 标题（N 从 1 起） |
| `card-N-body` | 第 N 个 card 正文 |
| `chart-caption` | 图表下方说明 |
| `image-N-caption` | 第 N 个图片说明 |

`maxChars` 取自原模板 v1 manifest 的相应字段（或人工度量）。

---

## 5. capabilities 规范

`manifest-v2.json` 的 `capabilities` 字段**必须如实**描述模板支持的能力，否则用户禁用图/视频时会跳过得不正确。

```jsonc
"capabilities": {
  "chartTypes": ["line", "bar", "pie"],   // 该模板的 chart fragment 经测试支持的图表类型
  "hasImagePages": true,
  "hasVideoPages": false,
  "hasAudioPages": false
}
```

**chartTypes**：默认 = `["line","bar","pie","gantt"]`（chart fragment 是通用的 `<canvas>`）。如某模板的 CSS 强制了图表样式只适合特定类型，可以裁剪。

---

## 6. 拆分流程（Thread T 工作步骤）

对每个模板：

1. **打开原 `index.html`**，找出所有 `<section class="slide">` 块。
2. **按 pageType 分组**：所有 `data-title="..."` 的 section，参考原 v1 manifest 的 `pageType` 字段做归类。
3. **对每个 pageType 选一个 canonical 实例**（通常选第一个或视觉最干净的那个）。
4. **清空内容**：删除所有文本子节点（`<h1>` `<h2>` `<h3>` `<p>` `<span>` 内的文字），保留 HTML 结构。
5. **chart 处理**：把所有 `<canvas id="xxx">` 改成 `<canvas data-chart-slot="primary">`，删除 `<script>new Chart(...)</script>` 引用块（这些进 `chart-inits`，由 Stage 3 合成）。
6. **image 处理**：保留 `<img>` 标签结构，删除 `src`，加 `data-image-slot="N"`。
7. **保存**为 `fragments/<pageType>.html`。
8. **量取 maxChars**：用浏览器开发者工具或人工估算每个文本插槽的容量（保守取值，宁可少不可多溢出）。
9. **写 manifest-v2.json**，列出 `pool` 全部 pageType + `fixed.cover` + `fixed.closing` + `capabilities`。
10. **shell.html**：把原 `<head>` 与 `<body>` 框架抽出，正文换成 `<!-- SLIDES -->` 占位。

---

## 7. Chart.js 默认 options（Thread I 提供）

```ts
// injector/chart-defaults.ts （Thread I 拥有）

export const CHART_DEFAULTS: Record<ChartType, Chart.ChartOptions> = {
  line:  { responsive: true, maintainAspectRatio: false,
           plugins: { legend: { position: 'bottom' } } },
  bar:   { responsive: true, maintainAspectRatio: false,
           plugins: { legend: { position: 'top' } } },
  pie:   { responsive: true, maintainAspectRatio: false,
           plugins: { legend: { position: 'right' } } },
  gantt: { /* gantt 用 bar + indexAxis:'y' 实现 */
           indexAxis: 'y', responsive: true, maintainAspectRatio: false },
};
```

**Gantt 实现**：Chart.js 没有原生 gantt，用 `type: 'bar'` + `indexAxis: 'y'` + 数据集形如 `[{ x: [start, end], y: 'task' }]`。Stage 1 prompt 应当告诉 LLM 这一约定。

---

## 8. image-resolver 规范（Thread I）

`img/` 目录下文件命名约定：`<keyword>-<index>.jpg`，如 `blockchain-01.jpg` `wallet-02.jpg`。

resolver 算法：
```
match(hint: string, files: string[]): string {
  const tokens = hint.toLowerCase().split(/\s+/);
  const scored = files.map(f => ({
    f,
    score: tokens.reduce((acc, t) => acc + (f.includes(t) ? 1 : 0), 0)
  }));
  scored.sort((a,b) => b.score - a.score);
  return scored[0].score > 0 ? scored[0].f : "_placeholder.jpg";
}
```

**Thread T 必须**：在每个模板 `img/` 下放一张 `_placeholder.jpg`（中性占位图）。

---

## 9. 验证清单（每个模板转换完，跑一遍）

- [ ] `manifest-v2.json` 通过 `templateManifestV2Schema.parse()`
- [ ] `shell.html` 含 `<!-- SLIDES -->` 与 `<!-- CHART_INITS -->`
- [ ] `fragments/cover.html` 与 `fragments/closing.html` 存在
- [ ] `pool` 至少含 `grid-2`、`grid-3`（基本款）
- [ ] 每个 fragment 文件以 `<section class="slide" data-page-type="...">` 开头
- [ ] 每个 anchor 的 selector 在 fragment 内**有且仅有**一个匹配（cheerio 校验）
- [ ] chart fragment 含 `<canvas data-chart-slot="primary">` 且无 `<script>`
- [ ] image fragment 的 `<img>` 有 `data-image-slot="N"` 且无 `src`
- [ ] `capabilities.chartTypes` 与 fragment 实际支持一致
- [ ] `img/_placeholder.jpg` 存在（如有 image fragment）

Thread T 必须为每个模板写一份 `verify-template-fragments.ts` 的子用例，跑过才算 done。

---

## 10. Edge cases

- **某模板原本完全没有 chart 页**：`pool` 不写 `chart`，`capabilities.chartTypes = []`。Stage 1 不会规划 chart 页。
- **某模板只有 1 个 grid-N 变体**（如只有 grid-3，没有 grid-2/4/5）：`pool` 仅含 grid-3。Stage 1 prompt 会知晓。
- **cover/closing 锚点过少**（如只有 title）：保留即可，optional 锚点可不填。
- **fragment 过多**：建议每模板 pool 控制在 5–10 种。
- **图片素材稀缺**：Thread T 至少补足 3 张通用占位图，文件名带行业关键词，让 image-resolver 有得选。

---

## 11. 转换工具（可选）

Thread T 可以写一个 `manifest/legacy-to-v2.ts` 半自动转换工具：
- 读 v1 `manifest.json`
- 读 `index.html`，按 v1 manifest 的 slideIndex 找出每个 section
- 按 pageType 去重，自动写 fragment 文件
- 但 anchors 与 maxChars 需要人工 review

如果不写工具，纯人工转换 20 个模板预计 1–2 个工作日。
