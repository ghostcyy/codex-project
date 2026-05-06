# html-ppt-v3 文档索引

新到的开发者 / agent，**按顺序**阅读：

1. **`00-PROJECT_PLAN.md`** — 这个项目要做什么、不做什么、关键决策、阶段时序
2. **`01-ARCHITECTURE.md`** — 模块图、数据流、每个 stage 干什么
3. **`02-INTERFACE_CONTRACTS.md`** — 跨 thread 共享的 TypeScript 类型（**冻结**，改要走 ICR）
4. **`03-TEMPLATE_FRAGMENT_SPEC.md`** — 模板拆分规范（Thread T 必读，Thread I 必读）
5. **`04-MULTI_AGENT_STRATEGY.md`** — 多 agent 协作流程；含每个 thread 的启动 prompt 模板（人类用户拿来 spawn agent）
6. **`../THREAD_STATUS.md`** — 实时状态板（每个 thread 完成里程碑后更新）
7. **`07-CURRENT_IMPLEMENTATION_SUMMARY.md`** — 当前真实代码实现总结；用于下一阶段产品/架构规划
8. **`08-WAVE_4_PLAN.md`** — Wave 4 产品化计划（Goal 1 模型生图 + Goal 2 三栏 Studio 前端替换）；含 5 个 thread 的 spawn prompt
9. **`09-TEMPLATE_LEARNING_PATH_AND_HANDOFF.md`** — Gemini 模板体系学习路径与维护交接
10. **`10-PAGE_PORTRAIT_AND_STANDARDIZATION_HANDOFF.md`** — 页肖像、按页 fragment、`fragmentId` 选页和标准化改版的主 agent 适配交接

---

## 修改文档的规则

- 文档由架构 Agent / 人类用户撰写。
- thread agent **不许**修改 `docs/`，但可以读、引用、提建议（在 STATUS 留言）。
- 如某 thread 觉得文档错了 / 需要补充：在 STATUS 报 issue，由架构 Agent 决定改不改。

## 文档之间的关系

```
00-PROJECT_PLAN  ────► 业务 / 决策 / 范围
       │
       ▼
01-ARCHITECTURE  ────► 模块 / pipeline / 数据流
       │
       ├──► 02-INTERFACE_CONTRACTS  ────► 跨 thread 类型（freeze）
       │
       └──► 03-TEMPLATE_FRAGMENT_SPEC  ────► 模板规范

04-MULTI_AGENT_STRATEGY  ────► 怎么并行 + 启动 prompt
       │
       ▼
THREAD_STATUS  ────► 实时同步面板
```
