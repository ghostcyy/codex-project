# html-ppt-v3 — Multi-Agent Collaborative Development Strategy

> 如何让多个 Claude Code agent 同时开发本项目，**互不干扰、互不踩脚、可合并**。
> 主体思想：**契约先行 + 文件独占 + Mock 解耦 + 状态板异步同步**。

---

## 1. 核心原则

### P1 — 契约先行（Contract First）
所有跨 thread 的接口都集中在 `shared/` 目录（Thread S 拥有）。任何 thread 都只能 **import 不能 modify**。这是物理隔离 thread 之间影响的最重要边界。

### P2 — 文件独占（File Ownership）
每个文件 / 子目录由**一个**且**仅一个** thread 拥有写权限。其他 thread 可读、不可改。冲突一律由人类用户裁决。

### P3 — Mock 优先（Mock-First）
每个 thread 在开工时**先**为自己的上下游写出 mock fixture，使本 thread 可以**独立运行 + 独立测试**。等其他 thread 真实输出 ready，再切换。这样消除等待，最大化并行。

### P4 — 文件级异步同步（Async via Files）
threads 不通过聊天上下文沟通（agent 之间看不见对方对话）。一切沟通通过：
- `THREAD_STATUS.md`（实时状态）
- `INTERFACE_CONTRACTS.md` § ICR（变更请求）
- 各 thread 在自己 README 里写的"对外承诺"

### P5 — 验证即交付（Verify or Die）
每个 thread 必须自带 `verify-X.ts` 脚本，必须能在 `cd apps/backend && npx tsx <path>` 下零错误退出。其他 thread 在依赖你之前会先跑你的 verify。

---

## 2. Thread 划分（6 个）

| Thread | 中文名 | 主要产出 | 可立即开工 |
|---|---|---|---|
| **S** | 共享契约 | `shared/` 目录所有类型与常量 | ✅ Phase 0 第一周完成 |
| **T** | 模板拆分 | 20 模板的 `manifest-v2.json` + `fragments/*.html` + `shell.html` | ✅（Phase 1 起） |
| **P** | LLM Pipeline | `stages/stage{0,1,2}.ts` + `prompts/*` + `orchestration/*` | ✅（用 Mock 启动） |
| **I** | Injector | `injector/*` + `stages/stage3-injector.ts` | ✅（用 Mock 启动） |
| **B** | Backend / DB | controller、`jobs/*`、`preview/*`、`packager/*` | ✅ |
| **V** | Viewer 前端 | `apps/frontend/.../html-ppt-v3-viewer/*` | ✅（用 Mock zip 启动） |
| **Q** | QA / E2E | `tests/verify-*.ts` 全套 | Phase 2/3，依赖前面有产出 |

> 7 个角色，Q 不算独立线程也行（也可由人类亲自跑）。建议 6 主线 + 1 流动 QA。

---

## 3. 文件归属矩阵

| 路径（相对 `html-ppt-v3/`） | 拥有 thread | 备注 |
|---|---|---|
| `docs/*` | 架构 Agent（已交付） | 后续仅人类修改 |
| `THREAD_STATUS.md` | 全员（按行所有权） | 改自己的状态行 |
| `shared/*` | **S** | 唯一可改 |
| `manifest/manifest-v2.*.ts` | **T** | |
| `manifest/pool-builder.ts` | **T** | |
| `manifest/(legacy) manifest.*.ts` | T（仅删除权限） | 本期不用，可整体删 |
| `.agents/skills/html-ppt/templates/full-decks/gemini/<id>/*` | **T** | 20 模板内容 |
| `stages/stage0-pool-build.ts` | **P** | |
| `stages/stage1-planner.ts` | **P** | |
| `stages/stage2-writer.ts` | **P** | |
| `prompts/*.ts` | **P** | |
| `orchestration/html-ppt-v3-agent.service.ts` | **P** | |
| `orchestration/html-ppt-v3-llm-client.ts` | **P** | |
| `injector/*` | **I** | |
| `stages/stage3-injector.ts` | **I** | 旧文件 I 重写 |
| `packager/zip-packager.ts` | **B** | |
| `jobs/*` | **B** | |
| `preview/*` | **B** | |
| `html-ppt-v3.controller.ts` | **B** | |
| `html-ppt-v3.module.ts` | **B** | |
| `tests/*` | **Q**（其他 thread 可贡献用例 PR 给 Q） | |
| `apps/frontend/.../html-ppt-v3-viewer/*` | **V** | |
| 数据库 migration `apps/backend/src/migrations/*ppt_v3*` | **B** | |

---

## 4. 阶段时序图

```
Phase 0 (1 天)  —— 由架构 Agent + Thread S 完成
  ├─ docs/ 5 份文档定稿（已完成）
  ├─ Thread S 落地 shared/ 目录所有类型与 zod schema
  └─ THREAD_STATUS.md 列出 6 个 thread 状态

Phase 1 (3–5 天)  —— 6 thread 并行（除 Q）
  ├─ Thread T: 转换 20 个模板（最耗时，建议早开始）
  ├─ Thread P: 用 mock manifest（手写 1 个示例）开发 stages 0/1/2
  ├─ Thread I: 用 mock plan + content（手写 fixture）开发 injector
  ├─ Thread B: 写 entity / migration / controller / preview / SSE
  ├─ Thread V: 用 mock SSE + mock zip 开发 viewer
  └─ THREAD_STATUS 每完成里程碑就更新

Phase 2 (2–3 天)  —— 联调
  ├─ T 完成 → P/I 切换到真实 manifest
  ├─ P 完成 → B 联端到端
  ├─ I 完成 → P 联端到端
  ├─ Thread Q 启动，写 verify-e2e-generate.ts
  └─ 解决 ICR（如有）

Phase 3 (2–3 天)  —— 收口
  ├─ 全 verify-*.ts 跑通
  ├─ V 联到真实 SSE / preview 端点
  ├─ 性能优化
  └─ DoD 检查
```

---

## 5. 协作机制

### 5.1 启动准入
每个 agent 开工前，**强制**做：
1. 读 `docs/00-PROJECT_PLAN.md`
2. 读 `docs/01-ARCHITECTURE.md`
3. 读 `docs/02-INTERFACE_CONTRACTS.md`
4. 读 `docs/04-MULTI_AGENT_STRATEGY.md`（本文）
5. 读 `THREAD_STATUS.md` 看自己 thread 当前状态、blocker、ICR
6. 读自己 thread 在 `02-` 与 `03-` 中的相关章节
7. 不读其他 thread 的实现代码（避免无意识耦合）

### 5.2 收尾准出
每个 thread 完成一个里程碑后，**强制**做：
1. 跑自己的 `verify-*.ts`，确保 0 error
2. 跑 `cd apps/backend && npm run typecheck`，确保 0 error
3. 更新 `THREAD_STATUS.md` 自己的状态行（仅自己的行！）
4. 如修改了对外契约，去 `INTERFACE_CONTRACTS.md` § ICR 提案
5. 如发现某 known issue 已解决，去 `THREAD_STATUS.md` Known Issues 区域勾掉
6. 最后一句话总结里程碑成果，留在 STATUS 里

### 5.3 如何处理冲突

| 情况 | 处理 |
|---|---|
| 你想改不属于你的文件 | 不改。在 STATUS 留 blocker，标 thread X，请人类协调 |
| 你需要的契约不存在 | 提 ICR；同时**临时**在自己 thread 内写 mock 类型继续工作 |
| 你的输出与下游不匹配 | 检查 `02-INTERFACE_CONTRACTS.md`，谁不符合谁改；契约文档是仲裁 |
| 你跑 typecheck 报错指向别 thread 的文件 | 不改别人代码；在 STATUS 报 blocker，附错误堆栈 |
| 同一里程碑两个 thread 都标 ✅ 但联调失败 | 跑 Q 的 e2e；找出第一个失败点，归因到具体 thread；该 thread 重新开 issue |

### 5.4 ICR（接口变更请求）流程

```
Step 1: thread X 在 THREAD_STATUS.md "ICR 提案" 区开行：
        ICR-001 | Thread P | 需要在 PlanIR 加 chartHints | proposed

Step 2: thread X 在 docs/02-INTERFACE_CONTRACTS.md 末尾追加 ICR 详情：
        - 当前定义
        - 提议定义
        - 影响 thread：S, P, I
        - 迁移方案

Step 3: 暂停受影响代码改动；其他 thread 继续干自己不受影响的部分

Step 4: 人类用户审定 → 在 STATUS 把 ICR 状态改为 accepted/rejected

Step 5: accepted → Thread S 落地修改；其他 thread 重跑 typecheck，更新代码
```

---

## 6. Mock Fixture 约定

每个 thread 自带 `__fixtures__/` 子目录，存放 mock 数据。命名 + 结构如下：

```
stages/__fixtures__/
  ├── mock-available-pool.json
  └── mock-plan-ir.json

injector/__fixtures__/
  ├── mock-plan-ir.json
  ├── mock-content-ir.json
  └── mock-manifest-v2.json   ← 一个完整 minimum example

apps/frontend/.../html-ppt-v3-viewer/__fixtures__/
  └── mock-sse-trace.json
```

Thread S 在 `shared/` 提供一个 helper：
```ts
// shared/test-utils.ts
export function loadFixture<T>(absPath: string, schema: ZodTypeAny): T;
```

---

## 7. Spawn Agent — 启动 Prompt 模板

将下面对应 thread 的 prompt 喂给一个新 agent（每 thread 起一个独立会话）。Prompt 已包含必要的上下文边界与产出验收。

> ⚠️ 启动每个 agent 前，**先确保 Phase 0 已完成**（docs/* 与 shared/* 已就绪）。

### 7.1 Thread S — 共享契约
```
你是 html-ppt-v3 项目的 Thread S（共享契约层）。

目录：apps/backend/src/modules/ppt-chat/html-ppt-v3/

任务：
1. 阅读 docs/00 ~ docs/04 全部规划文档
2. 创建 shared/ 目录，按 docs/02-INTERFACE_CONTRACTS.md 落地：
   - manifest-v2.types.ts
   - plan-ir.types.ts
   - content-ir.types.ts
   - job.types.ts
   - sse.types.ts
   - paths.ts
   - test-utils.ts
   - index.ts (re-export)
3. 每个文件用 zod 写运行时校验 + 用 z.infer 派生 TS 类型
4. 跑 cd apps/backend && npm run typecheck → 必须 0 error
5. 在 THREAD_STATUS.md 把 Thread S 状态改为 ✅
6. 提交一个 commit：feat(html-ppt-v3): seed shared contracts (Thread S)

约束：
- 不要写任何业务逻辑代码
- 不要修改 shared/ 之外的文件
- 类型与 docs/02 必须 100% 一致（人类已审）
```

### 7.2 Thread T — 模板拆分
```
你是 html-ppt-v3 项目的 Thread T（模板拆分）。

任务：
1. 阅读 docs/00、docs/01、docs/02、docs/03、docs/04（必读）
2. 等 Thread S 完成（看 THREAD_STATUS.md）
3. 写 manifest/legacy-to-v2.ts 半自动转换工具（从旧 index.html 抽 fragment）
4. 对 .agents/skills/html-ppt/templates/full-decks/gemini/01-tech-web3/ 跑工具，
   产出 manifest-v2.json + shell.html + fragments/*.html
5. 人工 review，修正 anchor selector 与 maxChars
6. 写 manifest/manifest-v2.loader.ts、manifest-v2.validator.ts、pool-builder.ts
7. 写 tests/verify-template-fragments.ts（验证当前 1 个模板）
8. 跑通后，处理剩余 19 个模板（每完成 5 个更新一次 STATUS 进度）
9. 完成全部后，verify-template-fragments.ts 必须 20/20 全过

约束：
- 你拥有 .agents/skills/html-ppt/templates/full-decks/gemini/<id>/* 与 manifest/* 的写权限
- 不许碰 shared/、stages/、injector/、jobs/、preview/、controller、module、frontend
- 任何契约疑问 → 看 docs/02 或开 ICR
```

### 7.3 Thread P — LLM Pipeline
```
你是 html-ppt-v3 项目的 Thread P（LLM 管道与编排）。

任务：
1. 阅读 docs/00、docs/01、docs/02、docs/04
2. 等 Thread S 完成
3. 删除旧的 stages/stage{1,2}-planner.ts / writer.ts，重写
4. 实现：
   - stages/stage0-pool-build.ts（脚本，无 LLM）
   - stages/stage1-planner.ts（调 LLM，输出 PlanIR）
   - stages/stage2-writer.ts（调 LLM，输出 ContentIR）
   - prompts/stage1-planner.prompt.ts、stage2-writer.prompt.ts
   - orchestration/html-ppt-v3-agent.service.ts（驱动 stage 0→2，调 stage 3 时通过 DI 拿 InjectorService）
   - orchestration/html-ppt-v3-llm-client.ts（演进现有版本，确保签名同 docs/02 § 9）
5. 写 stages/__fixtures__/mock-manifest-v2.json（手写一份，独立于 Thread T 进度）
6. 写 tests/verify-stage1-planner.ts、verify-stage2-writer.ts（用 mock 跑）
7. 联调阶段：等 Thread T 第 1 个真实 manifest ready，切换 fixture 跑通
8. 联调阶段：等 Thread I ready，跑 stages/__fixtures__ → injector 端到端
9. 跑通后更新 STATUS

约束：
- 你不许碰 shared/、injector/、jobs/、preview/、controller、module、template 文件
- LLM 调用一律走 html-ppt-v3-llm-client.ts，不许直接 import @anthropic-ai/sdk
- prompt 字符串模板必须可单测（用纯函数生成）
```

### 7.4 Thread I — Injector
```
你是 html-ppt-v3 项目的 Thread I（HTML 注入器）。

任务：
1. 阅读 docs/00、docs/01、docs/02、docs/03、docs/04
2. 等 Thread S 完成
3. 删除旧 stages/stage3-injector.ts，全新重写
4. 实现：
   - injector/deck-stitcher.ts（拼 cover + middle + closing）
   - injector/slot-filler.ts（cheerio 注入文本，处理 |STRONG|）
   - injector/strong-parser.ts（独立函数，单测）
   - injector/chart-injector.ts（合成 Chart.js init JS）
   - injector/chart-defaults.ts（4 类型默认 options）
   - injector/image-resolver.ts（关键词匹配 img/ 文件）
   - stages/stage3-injector.ts（拼装上述模块的 facade）
5. 写 injector/__fixtures__/ 含 mock-manifest-v2.json + mock-plan-ir.json + mock-content-ir.json
6. 写 tests/verify-stage3-injector.ts（用 mock 跑，端到端产出 workdir/<jobId>/index.html）
7. 验证产出：cheerio 加载 → 0 个未填必填 slot、0 个 Chart canvas 缺 init script

约束：
- 你不许碰 shared/、stages/{0,1,2}/、prompts/、orchestration/、jobs/、preview/、template 文件
- 不许在注入器里调 LLM（这是脚本层）
- 必须用 cheerio 而非 regex 改 HTML
```

### 7.5 Thread B — Backend / DB / Preview
```
你是 html-ppt-v3 项目的 Thread B（后端持久化与端点）。

任务：
1. 阅读 docs/00、docs/01、docs/02、docs/04
2. 等 Thread S 完成
3. 实现：
   - jobs/ppt-v3-job.entity.ts（TypeORM）
   - apps/backend/src/migrations/<ts>-create-ppt-v3-jobs.ts
   - jobs/ppt-v3-job.service.ts（CRUD + 状态机 + 由 SSE 调用的 setStatus）
   - preview/preview.controller.ts（静态文件服务，scope 到 outputDir/<jobId>/）
   - 重写 html-ppt-v3.controller.ts：POST /generate（异步）、GET /sse/:jobId、GET /download/:jobId、GET /preview/:jobId/*
   - 演进 packager/zip-packager.ts（输出到 HTML_PPT_V3_OUTPUT_DIR/output/<jobId>.zip）
   - 重写 html-ppt-v3.module.ts，wire 全部 provider
4. 写 tests/verify-job-persistence.ts（建 job → 重启服务模拟 → 仍可读）
5. 写 tests/verify-preview-static.ts（mock 一个 done job → GET 各资源 200）
6. 联调阶段：等 Thread P 完成，端到端跑 POST→SSE→done

约束：
- 你不许碰 stages/、injector/、prompts/、shared/、template 文件
- SSE 实现遵循 docs/01 § 9
- 路径穿越防护必须做：preview/:jobId/* 拒绝任何含 ".." 的 path
```

### 7.6 Thread V — Viewer 前端
```
你是 html-ppt-v3 项目的 Thread V（前端 Viewer）。

任务：
1. 阅读 docs/00、docs/01、docs/02、docs/04
2. 等 Thread S 完成（仅需类型定义；不依赖后端实现）
3. 在 apps/frontend/src/ 下找现有 PPT 模块，沿用同样的代码风格
4. 实现：
   - 新页面 /html-ppt-v3：表单（4 项 + 图/视频开关）
   - POST /html-ppt-v3/generate → 拿 jobId
   - 监听 EventSource /html-ppt-v3/sse/:jobId，按 docs/02 § 8 解析事件、显示进度
   - done 后：iframe 加载 /html-ppt-v3/preview/:jobId/index.html，外加 prev/next 按钮
       prev/next 实现：iframe 内的 deck 必须有 .slide 元素以 vertical 布局，按钮 scrollIntoView
   - "下载 zip" 按钮 → /html-ppt-v3/download/:jobId
5. 用 __fixtures__/mock-sse-trace.json 在后端没好之前完成 UI 开发
6. 联调阶段：把 mock 切到真实端点

约束：
- 你不许碰任何 backend 文件
- 用项目既有 UI lib（不要引入新框架）
- 处理 SSE 重连（断线后用 lastEventId 续传，可后期优化）
```

### 7.7 Thread Q — QA / E2E
```
你是 html-ppt-v3 项目的 Thread Q（质量保障与端到端验证）。

任务：
1. 阅读所有 docs/
2. 等 Thread T、P、I、B 都至少有 0 类骨架就绪后启动
3. 实现：
   - tests/verify-e2e-generate.ts：起完整 NestJS 测试 app → POST 生成 → 等 SSE done → 校验 zip 与 preview
   - tests/verify-template-fragments.ts（与 Thread T 协同）
   - 跑通 20 模板 × 3 个不同 (pageCount, includeImages, includeVideo) 组合
   - 失败率 ≤ 10% 才算通过
4. 把发现的 bug 归因到具体 thread，写 issue 留 STATUS

约束：
- 不许直接修复 bug（除非动 tests/）
- 报告必须可复现，含触发请求 + 期望 vs 实际
```

---

## 8. Spawn Agent 的实操方式

人类用户在 Claude Code 中：

1. **打开新对话** for each thread
2. 把上面对应的 prompt 整段贴入
3. 让 agent 按指令工作
4. agent 完成后会自己更新 `THREAD_STATUS.md`
5. 人类在主控台 / 另开一个 "调度 agent" 定期：
   - 读 `THREAD_STATUS.md`
   - 处理 ICR
   - 协调跨 thread 阻塞
   - 人工 review 每个 thread 的 commit

可选：用 Claude Code 的 [worktree 隔离]feature，每个 thread 在不同 git worktree 上工作，最终汇合到主分支。

---

## 9. Anti-patterns（禁止）

| ❌ | 为什么 |
|---|---|
| Thread P 直接 import Thread I 的内部模块 | 跨 thread 耦合；只能通过 `shared/` 类型 |
| Thread T 改 `shared/` 加字段 | 必须走 ICR |
| 任何 thread 改 `THREAD_STATUS.md` 中**别人的**状态行 | 只动自己的 |
| 用聊天约定接口（"我们说好的格式"） | 必须落到 docs/02 |
| "这地方旧代码我顺手改了" | 不在你 ownership 内的文件不许改 |
| Thread Q 顺手 fix bug | Q 只报 issue，不写实现 |
| 多个 thread 同时改同一个 PR | 一次一个 thread 提 PR |

---

## 10. 紧急联络

如某 thread 完全 stuck（agent 跑死、契约死锁），人类用户的解锁动作：
1. 看 `THREAD_STATUS.md` 该 thread 的 blocker 描述
2. 决策：拆分任务 / 调整契约 / 砍 scope
3. 用新 prompt 启动一个"修复 agent"，明确告诉它修复目标 + 不许碰其他人代码
4. 修复完更新 STATUS
