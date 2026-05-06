# html-ppt-v3 — Project Plan

> **读者**：本项目所有开发者 / 协作 Agent。**首读必读**。
> **作者**：架构 Agent（Opus），审定：人类用户。
> **状态**：v1.0 (2026-05-02)，supersedes 旧 `THREAD_STATUS.md` 中 A/B/C/D 线程划分。

---

## 1. 一句话目标

> 用户输入 4 项 → 后端调 2 次 LLM + 一系列脚本 → 返回一份**真实可用、设计精美**的 HTML-PPT（zip 下载 + 浏览器翻页预览）。

---

## 2. 输入 / 输出契约

### 用户输入（Request）

| 字段 | 类型 | 说明 |
|---|---|---|
| `theme` | string | 内容主题（自然语言，1–500 字） |
| `pageCount` | int | 页数，5–30 |
| `wordBudget` | int | 全 deck **总字符数**预算（500–15000） |
| `templateId` | string | 必选，从 20 模板中选一个，如 `01-tech-web3` |
| `includeImages` | bool | 是否启用图片页 |
| `includeVideo` | bool | 是否启用视频页 |

### 系统输出

1. **zip 下载** — 完整 deck 目录打包，含 `index.html` / `style.css` / `assets/` / `img/`，离线可双击运行。
2. **浏览器预览** — 通过 `GET /html-ppt-v3/preview/:jobId/index.html` 加载，前端提供 prev/next 翻页。
3. **持久化** — 同一 `jobId` 在服务重启后仍可下载与预览。

---

## 3. 关键设计决策（已与用户敲定）

| # | 决策 | 含义 |
|---|---|---|
| D1 | **保留 v3 基础件，重写 stages/prompts** | `manifest/`（schema 升级到 v2）/ `packager/zip-packager.ts` / `orchestration/html-ppt-v3-llm-client.ts` 保留并演进；`stages/*` 与 `prompts/*` **整体重写** |
| D2 | **首末页固定，中间页模型自由组合** | 模板提供 `fixed.cover` + `fixed.closing` 两个固定 fragment，加一个 `pool: { pageType → fragment }` 池供模型从中选取并排序 |
| D3 | **图/视频页：硬性裁剪选项池** | 用户关闭 `includeImages` 时，**直接从 pool 中删除** image-* 类型，模型看不到这些选项；视频同理 |
| D4 | **wordBudget 是全 deck 总额** | Stage 1 计算 `perPageBudget = wordBudget / pageCount`；Stage 2 在每页内分摊到各 slot；任何单 slot 仍受 `maxChars` 硬性截断 |
| D5 | **模型选图表类型，但不改 Chart.js 代码** | 标准化一个 `chart` pageType：fragment 内只有 `<canvas data-chart-slot="primary">`；注入器根据模型给的 `chartType ∈ {line,bar,pie,gantt}` **动态合成** Chart.js init 脚本。模板原 chart JS 在 fragment 化时丢弃 |
| D6 | **异步 + SSE + jobId** | Controller 立即返回 `jobId` 走 SSE 推进度；前端 / 后端通过 jobId 拉预览与下载；jobId 入库持久化 |
| D7 | **2 次 LLM 调用：Plan → Write** | Stage 1 只规划（pageType + topicPoints + chartType + 字数分配）；Stage 2 只写正文与 chartData。HTML/CSS 由脚本（cheerio）注入 |

---

## 4. 业务流程总览

```
HTTP POST /html-ppt-v3/generate
  ↓ {theme, pageCount, wordBudget, templateId, includeImages, includeVideo}
Controller 写入 ppt_v3_jobs (status=pending), 返回 {jobId}, 同时 fork 异步 pipeline
  │
  └→ AgentService.run(jobId)
       │
       ├─ Stage 0  TemplatePoolBuilder（纯脚本）
       │     loadManifestV2(templateId)
       │     filter pool by includeImages/includeVideo
       │     → AvailablePool
       │
       ├─ Stage 1  Planner（LLM #1）
       │     in:  theme, pageCount, wordBudget, AvailablePool, fixed.cover/closing
       │     out: PlanIR { slides: [{pageType, slideTitle, topicPoints[], chartType?, charBudget}, ...] }
       │     验证: 页数严格 = pageCount, 第1页 cover, 末页 closing, pageType ∈ AvailablePool
       │
       ├─ Stage 2  Writer（LLM #2）
       │     in:  PlanIR + 每页 fragment 的 anchors（含 maxChars）
       │     out: ContentIR { slides: [{ slotFills, chartData?, imageHints? }, ...] }
       │     验证: 每个 slot ≤ maxChars, chart 页含 chartData, image 页含 imageHints
       │
       ├─ Stage 3  Injector（纯脚本，cheerio）
       │     copy templates/{templateId}/ → workdir/{jobId}/
       │     stitch fragments by PlanIR order → workdir/{jobId}/index.html
       │     fill slots from ContentIR.slotFills
       │     synthesize Chart.js init for each chart page
       │     resolve image slots（库内固定占位 OR 关键词搜索本地图库）
       │
       ├─ Stage 4  Packager
       │     zip workdir/{jobId}/ → output/{jobId}.zip
       │     update ppt_v3_jobs (status=done, zip_path, preview_path)
       │
       └─ SSE 推送进度，最终 done event 含 previewUrl + downloadUrl
```

---

## 5. 范围内 / 范围外

### 范围内（v3 必交付）
- 6 项交付物（见 §6）
- 20 个模板全部支持
- 全链路 typecheck 干净 + e2e 通过率 ≥ 90%
- 服务重启后 jobId 仍可下载/预览

### 范围外（v3 不做，记入 backlog）
- 用户上传自定义图片
- 多语言切换（先支持 zh-CN，模板 label 已含 en 字段，留接口）
- 实时协同编辑
- LLM 一稿后的 critic / 自动重写循环
- 模板自定义颜色 / 主题色变量

---

## 6. 交付物清单（DoD）

| # | 交付物 | 验收方式 |
|---|---|---|
| 1 | 20 个模板的 v2 manifest + fragment 文件 | `verify-template-fragments.ts` 全过 |
| 2 | Controller 端到端：POST → SSE → done | `verify-e2e-generate.ts` 全过 |
| 3 | DB 持久化：重启后 GET /download 仍可用 | `verify-job-persistence.ts` 全过 |
| 4 | Preview 端点：浏览器可静态访问每页资源 | `verify-preview-static.ts` 全过 |
| 5 | 前端 Viewer：iframe 加载 + 翻页交互 | 手测 + 截图 |
| 6 | 文档齐全：本 docs/ 目录所有 .md 完整 | 人工审 |

---

## 7. 阶段计划

| Phase | 时序 | 内容 | 交付 |
|---|---|---|---|
| **Phase 0** | 立即 | 本套 6 份文档定稿 + 6 个 thread 启动 prompt 备好 | docs/* + THREAD_STATUS.md |
| **Phase 1** | 并行 | T、B、V、Q 立即开工；P、I 用 mock fixture 同步开工 | 各 thread README + 接口骨架 |
| **Phase 2** | T 完成后 | P、I 切换到真实 manifest；联调 | E2E 第一次跑通 |
| **Phase 3** | 收口 | Q 跑全量 e2e；修复发现的 bug；前端打磨 | 全 DoD 打勾 |

---

## 8. 文档导航

| 文件 | 内容 | 必读人 |
|---|---|---|
| `00-PROJECT_PLAN.md`（本） | 目标 / 决策 / 范围 / 阶段 | 所有人 |
| `01-ARCHITECTURE.md` | 模块图 / 数据流 / pipeline 详解 | 所有人 |
| `02-INTERFACE_CONTRACTS.md` | 跨 thread 共享的 TypeScript 类型（**冻结**） | 所有人 |
| `03-TEMPLATE_FRAGMENT_SPEC.md` | manifest v2 schema、fragment 拆分规则、示例 | T、I 必读，P 选读 |
| `04-MULTI_AGENT_STRATEGY.md` | 6 thread 划分 / 文件归属 / 协作协议 / 启动 prompt | 所有人 |
| `../THREAD_STATUS.md` | 实时状态板（每个 thread 完成里程碑后更新） | 所有人 |

---

## 9. 旧文档关系

- 旧 `THREAD_STATUS.md` 中的 A/B/C/D 线程划分 **作废**，本计划完全替代。
- `manifest.types.ts` 的 `PAGE_TYPES` 枚举沿用（语义未变，结构从"固定 deck"升级为"fragment pool"）。
- `KI-001 ~ KI-005`（旧已知问题）：KI-001/002/005 由 Thread P/I 在新设计中天然解决；KI-003/004 由 Thread B（持久化）解决。
