# html-ppt-v3 — Architecture

> 模块结构、数据流、pipeline 各 stage 的详细职责。

---

## 1. 模块图

```
apps/backend/src/modules/ppt-chat/html-ppt-v3/
├── docs/                          ← 本套规划文档（架构 Agent 写）
│
├── shared/                        ← 跨 thread 共享类型与常量（Thread S 拥有，只读外露）
│   ├── manifest-v2.types.ts
│   ├── plan-ir.types.ts
│   ├── content-ir.types.ts
│   ├── job.types.ts
│   ├── sse.types.ts
│   └── index.ts                   ← 统一 re-export
│
├── manifest/                      ← Thread T 拥有
│   ├── manifest-v2.loader.ts      （新；从模板目录读 manifest-v2.json + 各 fragment HTML）
│   ├── manifest-v2.parser.ts      （新；CLI 工具，从老 index.html 抽 fragment）
│   ├── manifest-v2.validator.ts   （新；zod 校验 + 完整性检查）
│   ├── pool-builder.ts            （新；按 includeImages/Video 过滤 pool）
│   └── (legacy) manifest.types.ts / manifest.parser.ts / manifest.loader.ts ← v1 残留，本期不用
│
├── stages/                        ← Thread P 拥有（除 stage3）
│   ├── stage0-pool-build.ts
│   ├── stage1-planner.ts          ← 重写
│   └── stage2-writer.ts           ← 重写
│
├── injector/                      ← Thread I 拥有（新建子目录）
│   ├── stage3-injector.ts         ← 重写（旧 stages/stage3-injector.ts 删除）
│   ├── deck-stitcher.ts           （拼接 cover + middle + closing）
│   ├── slot-filler.ts             （cheerio 注入 slotFills，处理 |STRONG| 加粗）
│   ├── chart-injector.ts          （合成 Chart.js init 脚本）
│   ├── image-resolver.ts          （根据 imageHints 选 img/ 库内文件）
│   └── strong-parser.ts           （解析 |STRONG| 分隔符）
│
├── prompts/                       ← Thread P 拥有
│   ├── stage1-planner.prompt.ts   ← 重写
│   └── stage2-writer.prompt.ts    ← 重写
│
├── orchestration/                 ← Thread P 拥有
│   ├── html-ppt-v3-agent.service.ts  ← 重写（驱动 stage 0→4）
│   └── html-ppt-v3-llm-client.ts     ← 保留并演进（已支持 structured output）
│
├── packager/                      ← Thread B 拥有
│   └── zip-packager.ts            ← 保留，加 outputDir 配置
│
├── jobs/                          ← Thread B 拥有（新建）
│   ├── ppt-v3-job.entity.ts       （TypeORM entity）
│   ├── ppt-v3-job.service.ts      （CRUD + 状态机）
│   └── ppt-v3-job.migration.ts    （数据库 schema migration）
│
├── preview/                       ← Thread B 拥有（新建）
│   └── preview.controller.ts      （静态文件服务，scoped 到 jobId 目录）
│
├── tests/                         ← Thread Q 拥有（新建）
│   ├── verify-template-fragments.ts
│   ├── verify-stage1-planner.ts
│   ├── verify-stage2-writer.ts
│   ├── verify-stage3-injector.ts
│   ├── verify-e2e-generate.ts
│   ├── verify-job-persistence.ts
│   └── verify-preview-static.ts
│
├── html-ppt-v3.controller.ts      ← Thread B 拥有
├── html-ppt-v3.module.ts          ← Thread B 拥有
└── THREAD_STATUS.md               ← 全员更新

apps/frontend/src/...html-ppt-v3-viewer/   ← Thread V 拥有
```

---

## 2. 数据流（端到端）

```
┌──────────────────────────────────────────────────────────────────────────┐
│ HTTP Layer (Thread B)                                                    │
│  POST /html-ppt-v3/generate     →  立刻返回 {jobId}, 启动 SSE             │
│  GET  /html-ppt-v3/sse/:jobId   ←  推送阶段事件                           │
│  GET  /html-ppt-v3/preview/:jobId/* ← 静态资源代理                        │
│  GET  /html-ppt-v3/download/:jobId  ← 下载 zip                            │
└──────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ Job Layer (Thread B)                                                     │
│  PptV3JobService.create(req) → row in ppt_v3_jobs (status=pending)       │
│  setStatus(jobId, status, partialResult?)                                │
└──────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ Agent Service (Thread P)                                                 │
│  HtmlPptV3AgentService.run(jobId, req)                                   │
│   │                                                                      │
│   │ Stage 0  TemplatePoolBuilder (Thread T 提供 loader, P 调用)           │
│   │   manifestV2 = loadManifestV2(req.templateId)                        │
│   │   pool = buildAvailablePool(manifestV2, req.includeImages, video)    │
│   │                                                                      │
│   │ Stage 1  Planner (Thread P)                                          │
│   │   plan = await llm.callStructured({                                  │
│   │     prompt: stage1Prompt(req, pool),                                 │
│   │     schema: PlanIRSchema,                                            │
│   │   })                                                                 │
│   │   validatePlan(plan, req, pool)                                      │
│   │                                                                      │
│   │ Stage 2  Writer (Thread P)                                           │
│   │   content = await llm.callStructured({                               │
│   │     prompt: stage2Prompt(plan, manifestV2),                          │
│   │     schema: ContentIRSchema,                                         │
│   │   })                                                                 │
│   │   validateContent(content, plan, manifestV2)                         │
│   │                                                                      │
│   │ Stage 3  Injector (Thread I)                                         │
│   │   workdir = await injector.run({                                     │
│   │     plan, content, manifestV2,                                       │
│   │     templateDir, jobId                                               │
│   │   })                                                                 │
│   │                                                                      │
│   │ Stage 4  Packager (Thread B 提供 zip-packager)                       │
│   │   zipPath = await zipPackager.pack(workdir, jobId)                   │
│   │   await jobService.markDone(jobId, { zipPath, previewPath: workdir })│
│   ▼                                                                      │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Stage 0 — TemplatePoolBuilder（脚本，Thread T 提供 lib，Thread P 调用）

**输入**：`templateId`, `includeImages`, `includeVideo`

**步骤**：
1. `loadManifestV2(templateId)` → 读 `templates/<id>/manifest-v2.json` + 每个 fragment 的 HTML 文件路径
2. `pool = manifestV2.pool` 全集
3. `if (!includeImages) delete pool["image-full"]; delete pool["image-text"]; delete pool["image-grid"]`
4. `if (!includeVideo) delete pool["video"]`
5. 返回 `AvailablePool`：仅含模型可见的 pageTypes + 每种的 capacity (topicSlots / topicSlotMaxChars / 是否含 chart 等)

**输出**：`AvailablePool`（详见 `02-INTERFACE_CONTRACTS.md`）

**注意**：Stage 0 完全确定性，不调 LLM；用 fixture 即可单测。

---

## 4. Stage 1 — Planner（LLM #1，Thread P）

**输入**：`req`, `AvailablePool`, `manifestV2.fixed.{cover,closing}` 的精简描述

**Prompt 结构**（`prompts/stage1-planner.prompt.ts`）：
```
你是 PPT 大纲规划师。以下是用户输入：
- theme: ...
- pageCount: 12
- wordBudget: 5000

可选页面类型（pool）：
- grid-2: 双卡，每卡 ≤120 字
- grid-3: 三卡，每卡 ≤120 字
- chart: 数据图表 + 1 个文字卡（≤124 字）
- title-text: 大标题 + 段落
（image-full / video 已被用户禁用）

固定首页：cover（主标题 + 副标题）
固定末页：closing（结语标题）

请规划 12 页（首页cover + 中间10页 + 末页closing）。
中间 10 页 pageType 可重复、可任意顺序，但必须覆盖主题各侧面。
对每页输出：pageType、slideTitle、topicPoints[]（数量 = 该 pageType 的 topicSlots）、
chartType（仅 chart 页）、charBudget（该页字符配额，所有页之和约 = wordBudget）。

输出严格 JSON，schema 见下方。
```

**结构化输出**（zod schema = `PlanIRSchema`，详见 contracts）

**校验**（Stage 1 落库前必跑）：
- `slides.length === req.pageCount`
- `slides[0].pageType === "cover"`, `slides[last].pageType === "closing"`
- 中间每页 `pageType` ∈ `Object.keys(AvailablePool)`
- chart 页必须有 `chartType ∈ {line,bar,pie,gantt}`
- `Σ charBudget` 与 `wordBudget` 相对误差 ≤ 15%

校验失败 → 抛错，外层重试 1 次（同 prompt + 错误反馈）。

---

## 5. Stage 2 — Writer（LLM #2，Thread P）

**输入**：完整 `PlanIR` + 每页 fragment 的 anchors（含 slotId / maxChars）

**Prompt 结构**：
```
你正在为已规划好的 PPT 撰写正文。每页的 pageType、topicPoints、charBudget 已定。

页 3（pageType=grid-3，charBudget=420，slideTitle="技术分层"）：
  topicPoints:
    - 应用层：用户交互入口
    - 协议层：数据传输标准
    - 网络层：底层通信骨干
  插槽（按顺序填）：
    - title (≤60 字, 必填)：写本页大标题
    - kicker (≤40, 可选)：副提示
    - card-1-heading (≤20, 必填)
    - card-1-body (≤122, 必填)
    - card-2-heading (≤20, 必填)
    - card-2-body (≤120, 必填)
    - card-3-heading (≤20, 必填)
    - card-3-body (≤120, 必填)
    - footer (≤80, 可选)

  写作要点：
    - 单 slot 严格 ≤ 上限
    - 重点词可用 "关键词|STRONG| 后续描述" 格式标记加粗
    - 中文使用全角标点
    - 不要写"这是第三页"之类的元描述

页 5（pageType=chart, chartType=line, charBudget=380）...
  额外输出 chartData = { labels: string[], datasets: [{label, data}] }

输出严格 JSON。
```

**校验**：
- 每个 slot 长度 ≤ `maxChars`（注入器最终会再硬截断 + 警告）
- chart 页有 `chartData.labels.length === chartData.datasets[k].data.length`
- image 页有 `imageHints: string[]`（注入器去 img/ 匹配）

---

## 6. Stage 3 — Injector（脚本，Thread I）

**输入**：`PlanIR`, `ContentIR`, `manifestV2`, `templateDir`, `jobId`

**步骤**：
1. **Copy template**：`cp -r templates/<id>/ workdir/<jobId>/`（保留 assets/ img/ style.css）
2. **Stitch deck**：
   - 读 `manifestV2.fixed.cover.htmlFile` → cover HTML 块
   - 按 `PlanIR.slides` 顺序，对每个中间页 `pageType` → 读对应 fragment HTML 块
   - 读 `manifestV2.fixed.closing.htmlFile` → closing HTML 块
   - 拼接到 `index.html` 模板的 `<main>` 容器内（替换占位符 `<!-- SLIDES -->`）
3. **Slot fill**：用 cheerio 加载 `index.html`，对每页：
   - 给 `<section class="slide">` 加 `data-slide-index="<n>"`
   - 按 anchor.selector 找元素，调 `setSlotText(el, text)`
   - `setSlotText` 解析 `|STRONG|`：将分隔符前的子串包成 `<strong>` 子节点（fix KI-001）
4. **Chart inject**：对每个 chart 页：
   - 找 `<canvas data-chart-slot="primary">`，赋唯一 id `chart-<slideIndex>`
   - 在页面底部 append `<script>` 调用 `new Chart(ctx, { type: chartType, data, options })`
   - `options` 由 `chart-defaults.ts` 提供（4 种类型各一套）
5. **Image resolve**：对每个 image 页：
   - 读 `manifestV2.pool["image-full"].imageSlotIds` → 每个槽对应 `<img>` 元素
   - `imageHints[k]` → 调 `image-resolver` 在 `img/` 目录里按关键词匹配最佳文件，写入 `<img src>`
   - 找不到匹配 → 用占位图 `img/_placeholder.jpg`
6. **Validate**：注入完成后，对全文跑一遍：
   - 没有未填的必填 slot
   - 没有遗留占位符 `{{...}}`
   - 所有 `<canvas>` 都有 init script
7. **Write**：保存到 `workdir/<jobId>/index.html`

---

## 7. Stage 4 — Packager（Thread B）

**输入**：`workdir/<jobId>/`

**步骤**：
1. 读环境变量 `HTML_PPT_V3_OUTPUT_DIR`（默认 `<repo>/.local-runtime/html-ppt-v3/output`），保证持久路径不在 `os.tmpdir()`（fix KI-004）
2. `archiver` 打 zip：`output/<jobId>.zip`
3. 调 `jobService.markDone(jobId, { zipPath, previewPath })`

---

## 8. 持久化（Thread B）

### `ppt_v3_jobs` 表

```sql
CREATE TABLE ppt_v3_jobs (
  id              UUID PRIMARY KEY,
  user_id         UUID NULL,
  request         JSONB NOT NULL,
  template_id     TEXT NOT NULL,
  status          TEXT NOT NULL,                -- pending|planning|writing|injecting|packaging|done|failed
  output_dir      TEXT NULL,                    -- 绝对路径
  zip_path        TEXT NULL,                    -- 绝对路径
  preview_path    TEXT NULL,                    -- = output_dir
  plan            JSONB NULL,                   -- Stage 1 IR
  content         JSONB NULL,                   -- Stage 2 IR
  error           TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ NULL
);
CREATE INDEX idx_ppt_v3_user ON ppt_v3_jobs(user_id, created_at DESC);
```

---

## 9. SSE 事件协议（Thread B → 前端 Thread V）

每个事件 `event: <name>\ndata: <json>\n\n`。完整事件序列：

```
event: job-created     data: {"jobId": "..."}
event: stage-start     data: {"stage": "planning"}
event: stage-done      data: {"stage": "planning", "summary": {...}}
event: stage-start     data: {"stage": "writing"}
event: stage-done      data: {"stage": "writing"}
event: stage-start     data: {"stage": "injecting"}
event: stage-done      data: {"stage": "injecting"}
event: stage-start     data: {"stage": "packaging"}
event: stage-done      data: {"stage": "packaging"}
event: done            data: {"jobId":"...", "previewUrl":"...", "downloadUrl":"..."}
```

失败时：`event: error data: {"message": "...", "stage": "writing"}` 然后关闭流。

---

## 10. Preview 静态服务（Thread B）

`GET /html-ppt-v3/preview/:jobId/*path`：
- 校验 jobId 存在 + status === 'done'
- 把 `*path` 拼到 `output_dir`，做路径穿越防护（拒绝 `..`）
- 用 NestJS `StreamableFile` 返回，content-type 按扩展名设置
- 前端 iframe `src="/html-ppt-v3/preview/<jobId>/index.html"` 即可加载

---

## 11. 失败处理 / 重试

| 阶段 | 失败动作 |
|---|---|
| Stage 1 校验失败 | 同 prompt + 错误反馈，重试 1 次；仍失败 → status=failed |
| Stage 2 校验失败 | 仅对失败的 slide 局部重写，重试 1 次 |
| Stage 3 致命错（fragment 缺失等） | 不重试，status=failed，error 包含详细原因 |
| Stage 4 zip 失败 | 重试 1 次 |

所有 LLM 调用走 `html-ppt-v3-llm-client.ts`，统一带超时 + 重试。

---

## 12. 性能预期

- Stage 1: ~5–10s
- Stage 2: ~15–30s
- Stage 3: <2s
- Stage 4: <2s
- 总：~25–45s/请求 → SSE 异步是必须的

---

## 13. 与 v2 (html-ppt-v2) 关系

v2 与 v3 **完全独立**，互不干扰。v3 的 manifest / Chart / image 处理与 v2 的 IR / V2 renderer 完全不同。**禁止跨包 import**。如果 v2 的 `html-ppt-v2-llm-client.ts` 有可复用工具函数，请复制而非依赖。
