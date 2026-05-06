# html-ppt-v3 — Wave 2 Plan

> **目标**：让 `/tools/html-ppt-v3` 页面在浏览器里点一下，**真实调用 LLM**，端到端产出可用 deck，能翻页、能下载。
> **触发条件**：Wave 1（GPT 已交付）实现已就绪，verify-* 全过（fake LLM）。
> **作者**：架构 Agent，2026-05-02。

---

## 1. Wave 1 → Wave 2 缺口清单

| # | 缺口 | 严重度 | 解封 thread |
|---|---|---|---|
| **G1** | 从未真正调过 LLM；prompt+schema 在 MiniMax 真实输出下能不能过校验未知 | 🔴 阻塞 | Thread α |
| **G2** | Stage 1/2 fallback 静默吞错，UI 看不见 `source=model\|fallback` | 🔴 阻塞 | Thread α |
| **G3** | iframe 翻页不工作（shell.html 无监听器；cross-origin keydown 被拒） | 🔴 阻塞 | Thread β |
| **G4** | 模板 `img/` 目录可能空 → 所有图回落到 placeholder | 🟡 影响视觉 | Thread γ |
| **G5** | preview 静态服务对相对资源路径未做端到端实测 | 🟡 可能掉样式 | Thread δ |
| **G6** | injector warnings 收集但未通过 SSE 上抛 | 🟡 影响诊断 | Thread β（顺手） |

---

## 2. Thread 划分（4 主线 + 1 收口）

| Thread | 角色 | 必须先做 | 估时 |
|---|---|---|---|
| **α** | Live LLM Smoke + Prompt Hardening | Wave 1 已就绪 | 2–4 h |
| **β** | 翻页 nav.js + Viewer 联调 + warnings 上抛 | 无依赖（可并行） | 3–4 h |
| **γ** | 模板图库审计与补图 | 无依赖 | 2 h |
| **δ** | Preview 静态资源烟测 | 无依赖 | 1 h |
| **ε** | 20×3×4 = 240 组合矩阵 QA | α/β/γ/δ 全过 | 4–6 h |

---

## 3. 文件归属（Wave 2 增量）

| 路径 | Owner |
|---|---|
| `prompts/stage1-planner.prompt.ts` / `stage2-writer.prompt.ts` | **α** |
| `orchestration/html-ppt-v3-llm-client.ts` 调参（temperature/maxTokens） | **α** |
| `tests/verify-live-llm-smoke.ts`（新） | **α** |
| `apps/backend/src/modules/ppt-chat/html-ppt-v3/orchestration/html-ppt-v3-agent.service.ts` 加 source/warning 进 emit | **α** + **β**（α 加字段，β 渲染） |
| `templates/full-decks/gemini/<id>/shell.html` 全部 20 个增 nav.js include | **β** |
| `templates/full-decks/gemini/_shared/nav.js`（新，所有模板共享） | **β** |
| `apps/frontend/app/tools/html-ppt-v3/page.tsx` 翻页改写 + log warnings | **β** |
| `templates/full-decks/gemini/<id>/img/*` 补图 + `manifest/img-audit.ts`（新） | **γ** |
| `tests/verify-preview-static.ts` 增端到端浏览器级 fetch | **δ** |
| `tests/verify-matrix.ts`（新） | **ε** |

> 新增 `templates/_shared/` 目录共享 nav.js / chart.umd.min.js；Stage 3 injector 已经 copy 整目录，无需额外改动。

---

## 4. 各 thread 启动 prompt（人类用户复制即用）

### 4.1 Thread α — Live LLM Smoke + Prompt Hardening
```
你是 html-ppt-v3 项目 Wave 2 的 Thread α（实战 LLM 烟测与 prompt 加固）。

必读：
- docs/00-PROJECT_PLAN.md（业务目标）
- docs/01-ARCHITECTURE.md（pipeline）
- docs/02-INTERFACE_CONTRACTS.md（PlanIR/ContentIR schema）
- docs/05-WAVE_2_PLAN.md（本波缺口与 thread 边界）
- THREAD_STATUS.md（当前状态 + Wave 2 行）

任务（按顺序）：
1. 跑一次真实 LLM 生成：
   起后端，POST /api/html-ppt-v3/generate {theme:"AI Agent 在中小企业落地", pageCount:8, wordBudget:1800,
   templateId:"01-tech-web3", includeImages:false, includeVideo:false}
   监听 SSE，记录每个 stage 的实际耗时与 LLM 原始返回（用 logger）。
   关键观察：planResult.source 与 writeResult.source 是否 == "model"（不是 fallback）。

2. 如果 source == "fallback"：
   - 启用 LLM client debug log 抓取真实返回 JSON
   - 对比 planIRSchema / contentIRSchema 的实际报错点
   - 修改 prompts/stage1-planner.prompt.ts 与 stage2-writer.prompt.ts：
     · 显式列举允许的 pageType 值（来自 pool.middle keys）
     · 给 1 个完整 JSON example
     · 强调 "JSON only, no markdown fence"（MiniMax 经常包 ```json）
     · 给 chartType 的明确语义
   - 改完重跑 step 1，直到 source == "model" 稳定通过

3. 让 SSE 事件携带 plannerSource / writerSource：
   - 修改 orchestration/html-ppt-v3-agent.service.ts：onProgress event 在 stage-done 的 detail 里加 "source: model|fallback" 字段
   - 修改 html-ppt-v3.controller.ts handlePipelineProgress：把 source 透传到 SSE summary

4. 写 tests/verify-live-llm-smoke.ts：
   - 不直接调 LLM（CI 不能花钱）
   - 改为读环境变量 HTML_PPT_V3_LIVE_LLM=1 时才跑
   - 标准化输出：source / 耗时 / 字段失败位 / 错误堆栈

5. 当前 prompt 字数 / 模型选择不要乱改；如需切换模型，找用户确认。

边界：
- 你只许动 prompts/、orchestration/html-ppt-v3-agent.service.ts、orchestration/html-ppt-v3-llm-client.ts、html-ppt-v3.controller.ts handlePipelineProgress 一处函数、tests/verify-live-llm-smoke.ts 新建
- 不许动 stages/ 实现、shared/、injector/、frontend、模板文件
- 任何 prompt 改动后必须再跑 verify-stage1-planner.ts / verify-stage2-writer.ts 保证回归通过

完成时：
- THREAD_STATUS.md 把 Wave 2 Thread α 改 ✅
- 留一行里程碑日志：本次烟测 LLM 模型 / source 达成率 / 改了哪些 prompt
```

### 4.2 Thread β — 翻页 nav.js + Viewer 联调 + Warnings 上抛
```
你是 html-ppt-v3 项目 Wave 2 的 Thread β（前端翻页与诊断）。

必读：
- docs/00-PROJECT_PLAN.md
- docs/01-ARCHITECTURE.md（重点 §10 preview 节）
- docs/05-WAVE_2_PLAN.md（缺口 G3 / G6）
- apps/frontend/app/tools/html-ppt-v3/page.tsx 现状

任务：
1. 创建 .agents/skills/html-ppt/templates/full-decks/gemini/_shared/nav.js
   功能：
   - DOMContentLoaded 后收集所有 .slide，初始化 currentIndex=0
   - 监听 keydown ArrowLeft/ArrowRight/Space → prev/next slide，scrollIntoView({behavior:'smooth'})
   - 监听 window.message：{type:"html-ppt-v3:navigate", direction:"prev"|"next"|number}
   - 监听 window.message：{type:"html-ppt-v3:goto", index:number}
   - postMessage 回父窗口：{type:"html-ppt-v3:state", currentIndex, totalSlides}
   - 屏幕底部固定一个简单的页码徽章 "<currentIndex+1> / <totalSlides>"（CSS 内联，不依赖 style.css）

2. 修改 packager/zip-packager.ts（如已 copy 整目录则无需改），确认 _shared/ 目录会被打入 zip

3. 修改 manifest/manifest-v2.loader.ts 或 stage3-injector.ts：每个生成的 index.html 在 </body> 前 inject
   <script src="../_shared/nav.js"></script>
   （路径相对 workdir/<jobId>/ → 实际是 templates/_shared/nav.js 拷贝到 workdir/_shared/nav.js）
   提示：更稳妥的方式是 deck-stitcher 直接把 nav.js 内容 inline 到 shell.html 占位符 <!-- NAV_JS -->

4. 在 shell.html 的所有 20 个模板里，确保末尾有 <!-- NAV_JS --> 占位（或 <!-- CHART_INITS --> 后面紧跟）
   如未约定，请用 inline 方案：在 deck-stitcher 拼装末尾追加 <script>...nav.js 内容...</script>

5. 改写 frontend page.tsx 的 moveSlide：
   - 仅用 postMessage（删除跨域 dispatchEvent 那段，永远跑不通）
   - 监听 window message {type:"html-ppt-v3:state"} → 更新 UI 显示 "X / Y"
   - 添加键盘监听（页面级，非 iframe）：左右箭头转发到 iframe.contentWindow.postMessage

6. 改 page.tsx 渲染 SSE log：
   - 接收 stage-done 时把 summary.detail 中的 "source: fallback" 高亮成红色提醒（"⚠️ 此阶段使用了 fallback，非 LLM 输出"）
   - 如 SSE done 携带 warnings[]（待 α 在 controller 加上），同样渲染

边界：
- 你只许动 templates/_shared/nav.js（新建）、所有 20 个 templates/<id>/shell.html、injector/deck-stitcher.ts（如选 inline 方案）、apps/frontend/app/tools/html-ppt-v3/page.tsx
- 不许动 prompts/、stages/、shared/、jobs/、preview/

完成时：
- 在浏览器手测：键盘左右、页内按钮都能翻页
- 在浏览器手测：SSE log 能看到 source 与 warnings
- 更新 THREAD_STATUS.md
```

### 4.3 Thread γ — 模板图库审计与补图
```
你是 html-ppt-v3 项目 Wave 2 的 Thread γ（模板图库管理）。

必读：
- docs/03-TEMPLATE_FRAGMENT_SPEC.md §8 image-resolver 规范
- docs/05-WAVE_2_PLAN.md G4

任务：
1. 写 manifest/img-audit.ts CLI 工具：
   - 遍历 .agents/skills/html-ppt/templates/full-decks/gemini/<id>/img/
   - 对每个模板：
     · 列出 img/ 内全部图片文件
     · 对照 manifest-v2.json 的 pool 中所有 image-* fragment 的 imageSlotSelectors 数量
     · 计算"图位需求 vs 可用图数"比例
     · 如比例 < 3:1 或 img/ 缺 _placeholder.jpg → 标红
   - 输出表格：templateId | hasImagePool | imageCount | placeholderExists | status
   - npm 脚本：npm run html-ppt-v3:img-audit

2. 跑 audit，把结果贴回 THREAD_STATUS.md 里程碑日志

3. 对所有"标红"模板：
   - 确保 _placeholder.jpg 存在（用通用占位图）
   - 至少补 5 张关键词命名的图（命名规则 docs/03 §8）
   - 图片来源：复用同行业其他模板的图，或从项目已有素材库捞，**不要**外网下载
   - 如不可避免下载，用 unsplash 公共 API（free tier）并加 LICENSE 注释

边界：
- 你只许动 .agents/skills/html-ppt/templates/full-decks/gemini/*/img/* 和 manifest/img-audit.ts、apps/backend/package.json（仅加 script 行）
- 不许动 backend / frontend 代码

完成时：
- 全部 20 模板 audit 通过（status=ok）
- 更新 THREAD_STATUS.md
```

### 4.4 Thread δ — Preview 静态资源烟测
```
你是 html-ppt-v3 项目 Wave 2 的 Thread δ（preview 资源烟测）。

必读：
- docs/01-ARCHITECTURE.md §10 preview
- docs/05-WAVE_2_PLAN.md G5

任务：
1. 阅读 preview/preview.controller.ts 当前实现，确认：
   - GET /html-ppt-v3/preview/:jobId/index.html
   - GET /html-ppt-v3/preview/:jobId/style.css
   - GET /html-ppt-v3/preview/:jobId/assets/*
   - GET /html-ppt-v3/preview/:jobId/img/*
   - GET /html-ppt-v3/preview/:jobId/_shared/nav.js  ← 注意 Thread β 会引入
   全部能返回 200 + 正确 content-type，且拒绝 ".." 路径穿越

2. 增强 tests/verify-preview-static.ts：
   - mock 一个 done job（直接 jobService.markDone + 在 outputDir 拷贝任一真实模板）
   - 启动测试 NestJS app
   - fetch 上述每条路径，断言：
     · status 200
     · content-type 正确（html / css / image/png / image/jpeg / application/javascript）
     · 字节数 > 0
   - 路径穿越用例：fetch /preview/<jobId>/../../etc/passwd → 期望 400/403

3. 如发现 controller 不能服务 _shared/ 路径或 nested 子路径有 bug → 在 preview-static.ts 修

边界：
- 你只许动 preview/preview-static.ts、preview/preview.controller.ts、tests/verify-preview-static.ts
- 不许动其他

完成时：
- npm run verify:html-ppt-v3-preview 全过
- 更新 THREAD_STATUS.md
```

### 4.5 Thread ε — 矩阵 QA（最后启动）
```
你是 html-ppt-v3 项目 Wave 2 的 Thread ε（矩阵质量验证）。

启动条件：α/β/γ/δ 全部 ✅。

必读：
- docs/00 / docs/01
- docs/05-WAVE_2_PLAN.md

任务：
1. 写 tests/verify-matrix.ts：
   - 矩阵：20 templateId × 3 pageCount(6/12/20) × 4 (image/video) 组合 = 240 用例
   - 走 MOCK LLM（不烧钱），但确保 mock 输出真实模拟 LLM 行为（含偶发 invalid json）
   - 收集每用例 result.trace（plannerSource/writerSource/injectorWarnings）
   - 输出报告：./local-runtime/html-ppt-v3/matrix-report.json
   - 通过门槛：成功率 ≥ 90%，injector warnings 为 0 的用例 ≥ 80%

2. 失败用例归因表：
   - 哪个 templateId × 哪个 pageCount × 失败 stage 与原因
   - 如发现集中在某模板 → 报回 Thread T（人类协调）补救

3. 跑一次 LIVE LLM 子集：从 240 中随机抽 5 个，HTML_PPT_V3_LIVE_LLM=1 跑
   - 观察 source=model 比例
   - 抽样保存 LLM 原始返回到 ./local-runtime/html-ppt-v3/live-samples/<n>.json

边界：
- 你只许动 tests/verify-matrix.ts 与该测试需要的 mock helper
- 不许改任何业务实现（发现 bug 在 STATUS 报 issue，按 thread 归属转交）

完成时：
- matrix-report.json 通过门槛
- 更新 THREAD_STATUS.md，整个 Wave 2 标 🟢
```

---

## 5. 完成标准（Wave 2 DoD）

- [ ] Thread α: 真实 LLM 调用 source=model 成功率 ≥ 90%
- [ ] Thread β: iframe 翻页可用（键盘 + 按钮 + 页码显示）
- [ ] Thread γ: 全 20 模板 img-audit 通过
- [ ] Thread δ: preview 静态服务全部资源类型 200
- [ ] Thread ε: 240 用例矩阵成功率 ≥ 90%
- [ ] 浏览器打开 `/tools/html-ppt-v3` → 4 项填表 → 生成 → 翻页 → 下载，**全程无人工干预**

---

## 6. 升级 / 风险

- **Risk-1**：MiniMax JSON 输出能力可能不稳。如 source=model 始终上不去 90%，候选方案：
  - 切换到 Anthropic Claude（已在 v2 验证过 structured output 稳定）
  - 在 Stage 1/2 加 "JSON Mode 后处理"：即使返回不是严格 JSON，先用 regex 提取 ```json...``` 块再 parse
- **Risk-2**：翻页方案 inline JS 与模板原有 JS 冲突。如出现，按模板 case-by-case 处理。
- **Risk-3**：图库补全成本可能超 2h（视图片质量要求）。如不达标，先放过，记录 backlog，不阻塞 ship。

---

## 7. 启动顺序与时间线

```
Day 1
 09:00  Thread α 启动        ┐
 09:00  Thread γ 启动        │ 并行
 09:00  Thread δ 启动        │
 12:00  Thread β 启动        ┘ （β 不强依赖 α，可并行）
 18:00  α/β/γ/δ 收口

Day 2
 09:00  Thread ε 启动        ← 等前 4 thread 全 ✅
 14:00  ε 矩阵报告出
 14:30  人工浏览器手测
 17:00  Wave 2 close
```
