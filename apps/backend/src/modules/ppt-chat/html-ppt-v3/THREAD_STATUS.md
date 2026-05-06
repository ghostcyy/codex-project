# html-ppt-v3 — Thread Status Board

> **首读必读**：所有 thread 在开工前读 `docs/00-PROJECT_PLAN.md` ~ `docs/04-MULTI_AGENT_STRATEGY.md`。
> **更新规则**：每个 thread 只许改自己那一行 / 自己负责的栏位。
> **Last updated**: 2026-05-03 by 架构 Agent (Opus)
> **Supersedes**: 旧版（A/B/C/D 4 线程划分），已作废。

---

## 0. Phase 进度

| Phase | 状态 | 描述 |
|---|---|---|
| Phase 0 | ✅ 完成 | docs/* + Thread S shared contracts 已就绪 |
| Phase 1 | ✅ 完成 | T/P/I/B/V mock 与骨架均已落地 |
| Phase 2 | ✅ 完成 | 首个真实模板 agent E2E 已跑通（**fake LLM**） |
| Phase 3 | ✅ 完成（fake-LLM 维度） | Q 验证脚本与重启冒烟 OK，但**未真调过 LLM** |
| **Wave 2** | ✅ 完成（功能层） | α/β/γ/δ/ε 已落地；live LLM 烟测通过 |
| **Wave 3** | ✅ 完成（功能层） | Q1-Q4 4 个 bug 已闭合，详见 `docs/06-WAVE_3_PLAN.md` |
| **Wave 4** | 🔵 **待启动** | Goal 1（模型生图，Stage 2.5）+ Goal 2（三栏 Studio 前端替换），详见 `docs/08-WAVE_4_PLAN.md`；λ/μ/ν/ξ 4 thread 可并行 + ο 收口 |

---

## 1. Thread 状态一览

| Thread | 角色 | Status | Last Done | Next | Blocker | Owner Agent |
|---|---|---|---|---|---|---|
| **S** | 共享契约 | ✅ 完成 | `shared/` contracts + `verify-shared-contracts.ts` | 支持 ICR 后续变更 | 无 | Codex main |
| **T** | 模板拆分 | ✅ 完成 | 20/20 `manifest-v2` + fragments generated and verified | 后续人工微调 anchors/maxChars | 无 | Codex subagent T |
| **P** | LLM Pipeline | ✅ 完成 | Stage 0/1/2 + prompts + LLM client verified | 后续 live LLM smoke | 无 | Codex subagent P |
| **I** | Injector | ✅ 完成 | Fragment-based Stage 3 verified | 后续真实模板视觉 QA | 无 | Codex subagent I |
| **B** | Backend / DB / Preview | ✅ 完成 | DB jobs + async controller + preview/download verified | 后续 service restart smoke | 无 | Codex subagent B |
| **V** | Viewer 前端 | 🟢 里程碑已达成 | Lightweight `/tools/html-ppt-v3` page typechecks | 浏览器手测 + visual polish | 无 | Codex subagent V |
| **Q** | QA / E2E | 🟢 里程碑已达成 | Shared/template/stage/job/preview/agent verify scripts landed | 20-template matrix | 无 | Codex main |

### Wave 2 — 实战可用化（详见 `docs/05-WAVE_2_PLAN.md`）

| Thread | 角色 | Status | 任务 | Blocker | Owner Agent |
|---|---|---|---|---|---|
| **α** | Live LLM 烟测 + Prompt 加固 | ✅ 完成 | prompt 加固；source/warnings SSE 透传；gated live smoke | 真实 LLM 需手动设置 `HTML_PPT_V3_LIVE_LLM=1` | Codex subagent α |
| **β** | 翻页 nav.js + Viewer 联调 + warnings 上抛 | ✅ 完成 | inline nav runtime；postMessage 翻页；前端 fallback/warning 高亮 | 浏览器人工手测待做 | Codex subagent β |
| **γ** | 模板图库审计与补图 | ✅ 完成 | img-audit CLI；20 模板 placeholder/图片池审计通过 | 无 | Codex subagent γ |
| **δ** | Preview 静态资源烟测 | ✅ 完成 | preview nested resources + traversal verification | 无 | Codex subagent δ |
| **ε** | 240 组合矩阵 QA | ✅ 完成 | 240/240 mock matrix 成功；229/240 warning-free；artifact failures 0 | 无 | Codex subagent ε |

### Wave 3 — 生产可用性闭合（详见 `docs/06-WAVE_3_PLAN.md`）

> 触发：人类用户在浏览器手测 Wave 2 产物时发现 4 个 bug（artifact: `C:\Users\YuanYuan\Desktop\调试\test\6c3271cc-...`）

| Thread | 角色 | Status | 任务 | 解决 | Owner Agent |
|---|---|---|---|---|---|
| **ζ** | Schema Gating（+chart, +audio） | ✅ 完成 | includeChart + includeAudio 落地 | Q1, Q3 | Codex subagent ζ |
| **η** | 前端 2 个新 toggle | ✅ 完成 | page.tsx 4 处 state + 2 个新 checkbox | Q1, Q3 | Codex subagent η |
| **θ** | Injector 硬化 | ✅ 完成 | post-stitch-cleaner + slot-filler 强清 | Q2, Q4 (defensive) | Codex subagent θ |
| **ι** | Fragment 重生 | ✅ 完成 | 20 模板 fragments 重生成 | Q2 (root), Q4 (root) | Codex subagent ι |
| **κ** | QA 收口 | ✅ 完成 | verify-no-residue + matrix 300/300 | 防回归 | Codex subagent κ |

### Wave 4 — 产品化（详见 `docs/08-WAVE_4_PLAN.md`）

> 触发：人类用户 2026-05-03 提出 Goal 1（模型生图）+ Goal 2（三栏 Studio 前端替换）。
> 锁定决策已固化在 `docs/08-WAVE_4_PLAN.md` §0.2。

| Thread | 角色 | Status | 任务 | 依赖 | Owner Agent |
|---|---|---|---|---|---|
| **λ** | T2I provider 抽象 | 🔵 待启动 | image-gen/ 目录 + env 驱动 + 2 个 adapter + verify 脚本 | 无 | — |
| **μ** | Stage 2.5 + injector hybrid | 🔵 待启动 | stage2_5-image-gen + image-resolver 扩展 + agent service 接线 | λ 接口签名（已固定 §3.1） | — |
| **ν** | V3 项目/消息后端 | 🔵 待启动 | ppt_v3_projects 表 + 6 个 endpoint + jobs.project_id 列 | 无 | — |
| **ξ** | 三栏前端工作台（替换） | 🔵 待启动 | 删 page.tsx 重写；左项目 / 中对话+输入 / 右模板卡 | ν 接口（已固定 §4.3） | — |
| **ο** | QA 收口 | ⚪ 暂缓 | matrix 复跑 + live smoke + WAVE_4_SHIPLOG | λ μ ν ξ 全 ✅ | — |

**Wave 3 已知缺口（Q-IDs）**：
- **Q1** Audio 未门控（`buildAvailablePool` 不过滤 audio；schema 无 `includeAudio`）
- **Q2** 页码硬编码 `data-current=5 data-total=20` 与实际不符
- **Q3** Chart 未门控（同 Q1）
- **Q4** Fragment 残留 `ECO_HARMONY // 2026`、`LIGHT_ORCHESTRATION // 2026` 等烙印；slot-filler 不清未填 anchor → 默认文案泄漏

### Status Legend
- 🔵 待开始
- 🟡 进行中
- 🟢 里程碑已达成（等下一里程碑）
- ✅ 整个 thread 完成（DoD 全过）
- 🔴 阻塞中
- ⚪ 暂未启动（依赖未就绪）

---

## 2. ICR（接口变更请求）

> 任何 thread 想改 `shared/` 中已冻结的契约，必须先在此立项，等人类裁决。

| ICR # | 提议方 | 描述 | 影响 thread | 状态 |
|---|---|---|---|---|
| — | — | （暂无） | — | — |

新增格式：`ICR-NNN | Thread X | 一句话描述 | A,B,C | proposed/accepted/rejected/done`

详细说明追加到 `docs/02-INTERFACE_CONTRACTS.md` 文件末尾的 ICR 详情区。

---

## 3. Known Issues / Technical Debt

> Phase 1 之前先把旧版 KI 的去留拍板：

| ID | 描述 | 计划归属 | 状态 |
|---|---|---|---|
| KI-001（旧） | setTextContent 清除 `<strong>` 子节点 | Thread I（重写注入器，新设计中天然解决） | 🟢 by-design |
| KI-002（旧） | maxChars 最低 10 偏小 | Thread T（拆分时重新度量） | 🟢 by-design |
| KI-003（旧） | jobId 用内存 Map 存，重启丢失 | Thread B（DB 持久化） | 计划解决 |
| KI-004（旧） | zip 输出到 os.tmpdir 重启丢失 | Thread B（HTML_PPT_V3_OUTPUT_DIR 配置） | 计划解决 |
| KI-005（旧） | stage2 prompt 未规定表格 slot | Thread P（重写 prompt） | 🟢 by-design |

---

## 4. 里程碑日志（Append-only）

> 每个 thread 完成一个里程碑后追加一行；不要删别人的。

```
[2026-05-02 18:38] Architect Agent — 写完 docs/00..04 + 重置 THREAD_STATUS.md
[2026-05-02 19:10] Codex main — Thread S contracts landed; verify:html-ppt-v3-shared passed
[2026-05-02 21:50] Codex agents — Threads T/P/I/B/V delivered first implementation wave; individual verify scripts passed
[2026-05-02 21:55] Codex main — Real-template agent E2E passed; backend/frontend typecheck passed
[2026-05-02 22:30] Architect Agent — Wave 2 plan landed (docs/05-WAVE_2_PLAN.md); 4 缺口已定位 (G1-G6); 4 个 thread spawn prompt 就绪
[2026-05-03 00:00] Codex agents — Wave 2 α/β/γ/δ implementation returned; source/warnings, nav runtime, img audit, preview hardening integrated
[2026-05-03 00:24] Codex subagent ε — Matrix QA passed: 240/240 success, 229/240 warning-free, planner fallback 6, writer fallback 5, artifact failures 0
[2026-05-03 00:31] Codex main — Real LLM smoke passed with plannerSource=model and writerSource=model; frontend proxy generated job a250d022-e9d1-4edb-b2dd-871035bbfa2a and preview returned 200
[2026-05-03 09:30] Architect Agent — 浏览器手测发现 Q1-Q4 (audio/chart 未门控；页码硬编码；fragment 残留)；Wave 3 plan 落地于 docs/06-WAVE_3_PLAN.md；5 thread spawn prompt 就绪
[2026-05-03 14:00] Architect Agent — Wave 4 plan 落地于 docs/08-WAVE_4_PLAN.md；15 项 G1.x/G2.x 决策已固化；λ/μ/ν/ξ/ο 5 thread spawn prompt 就绪；前 4 个可并行
```

---

## 5. 协作约定速查

- **新启 agent 的标准 prompt**：见 `docs/04-MULTI_AGENT_STRATEGY.md` § 7（每个 thread 都有现成 prompt 模板，整段复制即可）。
- **看不懂某契约**：看 `docs/02-INTERFACE_CONTRACTS.md`，仍不懂就 ICR。
- **Phase 1 启动顺序建议**：S → T 启动 →（同时）P/I/B/V 用 mock 启动。
- **每个 thread 完成 DoD 的标志**：本表 Status 列改 ✅，且自己的 verify-*.ts 全过。

---

## 6. 文件归属速查

详见 `docs/04-MULTI_AGENT_STRATEGY.md` § 3。摘要：

```
shared/                    → S
manifest/                  → T
templates/full-decks/      → T
stages/{0,1,2}/, prompts/, orchestration/  → P
injector/, stages/stage3   → I
packager/, jobs/, preview/, controller, module, migrations  → B
apps/frontend/.../html-ppt-v3-viewer/      → V
tests/                     → Q
```

---

## 7. 当前优先动作（人类用户）

Wave 1-3 已闭合。Wave 4 进入产品化（Goal 1 模型生图 + Goal 2 三栏 Studio）。

1. ✅ Phase 0–3 完成（fake LLM 维度）
2. ✅ Wave 2 完成（α/β/γ/δ/ε live LLM smoke 通过）
3. ✅ Wave 3 完成（ζ/η/θ/ι/κ；Q1-Q4 4 个生产 bug 已闭合）
4. ⏭️ **同时启动 Wave 4 Thread λ / μ / ν / ξ** —— 4 段独立 prompt 见 `docs/08-WAVE_4_PLAN.md` §5.1-5.4
5. ⏭️ 4 thread 全 ✅ → 启动 Thread ο（matrix 复跑 + live smoke + SHIPLOG）
6. ⏭️ ο 通过 + 浏览器复测 → Ship Wave 4
