# html-ppt-v3 — Wave 3 Plan

> **触发**：人类用户在浏览器手测 Wave 2 产物时发现 4 个生产可用性 bug。
> **目标**：闭合 4 个 bug → `/tools/html-ppt-v3` 可作为 v1 ship 给最终用户。
> **作者**：架构 Agent，2026-05-03。

---

## 1. QA 缺口与根因（由架构 Agent 完成检查）

| # | 现象 | 实证位置 | 根因 |
|---|---|---|---|
| **Q1** | Audio 页仍被纳入候选 | `shared/plan-ir.types.ts:54` `buildAvailablePool` 只过滤 image/video；无 `includeAudio` | Schema + pool builder 缺 audio 维度 |
| **Q2** | 页码 "05 / 20" 与实际不符 | 工件 `index.html:101` `<span class="slide-number" data-current="5" data-total="20">`，stitcher 未重写 | Fragment 保留硬编码 + injector 未做后处理 |
| **Q3** | Chart 页强制纳入 | 同 Q1 — `buildAvailablePool` 不过滤 chart | 同 Q1 |
| **Q4** | `ECO_HARMONY // 2026`、`LIGHT_ORCHESTRATION // 2026`、卡片默认文案等模板残留 | Fragment 文件直接保留：`fragments/grid-4.html:23` `<span>LIGHT_ORCHESTRATION // 2026</span>` | Fragment 抽取时未清空叶子文本；slot-filler 对未填 anchor 不清除 |

**核心判断**：用户说 Q2 "may need to be handled by the model" — 实际**纯脚本**即可（后端拼装时已知 `slideIndex` 与 `totalSlides`，无需 LLM 介入）。**reject** 模型路线，节省 token + 提升确定性。

---

## 2. Thread 划分（4 主线 + 1 QA）

| Thread | 角色 | Owns | 估时 |
|---|---|---|---|
| **ζ** | Schema Gating（chart + audio） | `shared/job.types.ts`、`shared/plan-ir.types.ts`（buildAvailablePool + validatePlanIR）、`stages/stage0-pool-build.ts`、`prompts/stage1-planner.prompt.ts`、`html-ppt-v3.controller.ts` 的 `normalizeGenerateBody`、`tests/verify-stage1-planner.ts` 的 mock 入参 | 1.5 h |
| **η** | Frontend Toggles | `apps/frontend/app/tools/html-ppt-v3/page.tsx` | 0.5 h |
| **θ** | Injector 硬化（页码 + 残留清理） | `injector/deck-stitcher.ts`、`injector/slot-filler.ts`、新建 `injector/post-stitch-cleaner.ts`、`tests/verify-stage3-injector.ts` 加 case | 2 h |
| **ι** | Fragment 重生（清空叶子文本） | `manifest/legacy-to-v2.ts`（或新建 `manifest/clear-fragments.ts`）、20 个模板的 `fragments/*.html` | 2.5 h |
| **κ** | QA 收口 | `tests/verify-no-residue.ts`（新建）、复跑 `verify-matrix.ts` | 1 h |

并行度：ζ / η / θ / ι 同时启动；κ 等前 4 全 ✅。

---

## 3. 各 Thread 详细规范

### 3.1 Thread ζ — Schema Gating

**目标**：让 `chart` 和 `audio` 与 `image/video` 一样，在用户未勾选时**从 pool 物理裁剪**，模型看不到。

**改动清单**：

1. **`shared/job.types.ts`**：
   ```ts
   export const generateRequestSchema = z.object({
     theme: z.string().min(1).max(500),
     pageCount: z.number().int().min(5).max(30),
     wordBudget: z.number().int().min(500).max(15000),
     templateId: z.string().min(1),
     includeImages: z.boolean(),
     includeVideo: z.boolean(),
     includeChart: z.boolean().default(true),    // 新增；默认开（向后兼容）
     includeAudio: z.boolean().default(false),   // 新增；默认关（多数模板没有）
   });
   ```
   注意：`default()` 让旧 client 不传时也能过 zod parse。

2. **`shared/plan-ir.types.ts` `buildAvailablePool`**：在 `IMAGE_PAGE_TYPES` / `VIDEO_PAGE_TYPES` 同位置补：
   ```ts
   if (!req.includeChart && pageType === "chart") continue;
   if (!req.includeAudio && AUDIO_PAGE_TYPES.includes(pageType)) continue;
   ```
   同时把 `chartTypesAvailable` 在 `!req.includeChart` 时设为 `[]`。

3. **`shared/plan-ir.types.ts` `validatePlanIR`**：补两条 reasons：
   ```ts
   if (slide.pageType === "chart" && !req.includeChart) reasons.push(`slide ${slide.slideIndex} uses chart while includeChart=false.`);
   if (slide.pageType === "audio" && !req.includeAudio) reasons.push(`slide ${slide.slideIndex} uses audio while includeAudio=false.`);
   ```

4. **`prompts/stage1-planner.prompt.ts`**：在描述可用 pageType 时如果 `pool.middle` 不含 `chart`/`audio`，提示明确告诉模型"该模板用户已禁用图表/音频页"。

5. **`html-ppt-v3.controller.ts` `normalizeGenerateBody`**：补两个字段映射：
   ```ts
   includeChart: body.includeChart ?? body.wantsChartSlides ?? true,
   includeAudio: body.includeAudio ?? body.wantsAudioSlides ?? false,
   ```

6. **`tests/verify-stage1-planner.ts`**：mock 入参补 `includeChart: true, includeAudio: false`；新增 case `includeChart: false` 验证 pool 不含 chart。

**边界**：不动 injector、frontend、模板。

---

### 3.2 Thread η — Frontend Toggles

**目标**：UI 暴露 2 个新开关；提交时附带。

**改动清单**：`apps/frontend/app/tools/html-ppt-v3/page.tsx`

1. `DEFAULT_REQUEST` 增加 `includeChart: true, includeAudio: false`。
2. 新增 state：`includeChart`、`includeAudio`。
3. `<div className="v3-toggles">` 内补 2 个 checkbox（与 includeImages / includeVideo 一致风格）：
   ```jsx
   <label><input type="checkbox" checked={includeChart} onChange={...} /> 图表页</label>
   <label><input type="checkbox" checked={includeAudio} onChange={...} /> 音频页</label>
   ```
4. `submit` 函数 body 加上两个字段。
5. CSS `.v3-toggles` 改 `grid-template-columns: 1fr 1fr` → `repeat(2, 1fr)` （已是；2x2 网格自然撑开 4 项）。

**边界**：只动 page.tsx；不动后端。

---

### 3.3 Thread θ — Injector Hardening

**目标**：保证 `.slide-number` 显示正确、未填 anchor 清空、模板烙印残留 0。

**改动清单**：

1. **`injector/slot-filler.ts`**：把"未填可选 anchor 跳过"改为"未填可选 anchor → 清空文本"：
   ```ts
   if (rawValue === undefined || (anchor.optional && rawValue.trim() === "")) {
     // 强制清空目标元素的文本子节点（避免模板默认文案泄漏）
     const matches = selectAll(anchor.selector, args.section as unknown as AnyNode) as Element[];
     if (matches.length === 1) attachChildren(matches[0]!, []);
     if (rawValue === undefined && !anchor.optional) {
       args.warnings.push(`Slide ${args.content.slideIndex}: required slot '${anchor.slotId}' has no content.`);
     }
     continue;
   }
   ```

2. **新建 `injector/post-stitch-cleaner.ts`**：在所有 slide 注入完成后跑一次：
   ```ts
   export function applyPostStitchClean(args: {
     deckRoot: AnyNode;             // 整个拼接好的 <main> 子树
     totalSlides: number;
     warnings: string[];
   }) {
     const slides = selectAll("section.slide", args.deckRoot) as Element[];
     slides.forEach((sec, idx) => {
       const slideIndex = idx + 1;
       sec.attribs["data-slide-index"] = String(slideIndex);
       sec.attribs["data-slide-total"] = String(args.totalSlides);

       // 1) 重写所有 .slide-number / [data-current] / [data-total]
       const slideNums = selectAll(".slide-number, [data-current], [data-total]", sec) as Element[];
       slideNums.forEach((el) => {
         el.attribs["data-current"] = String(slideIndex);
         el.attribs["data-total"] = String(args.totalSlides);
         // 如果元素本身有静态文本（如 "05 / 20"），按规则重写
         const flat = textOf(el).trim();
         if (/^\d{1,3}\s*\/\s*\d{1,3}$/.test(flat)) {
           const padded = `${pad(slideIndex)} / ${pad(args.totalSlides)}`;
           attachChildren(el, [{ type: "text", data: padded } as any]);
         }
       });

       // 2) 残留扫描：列出所有非空叶子文本节点的内容，匹配 known residue patterns 警告
       const RESIDUE = /^[A-Z][A-Z0-9_]{4,}\s*\/\/\s*\d{4}$|EDIT_ME|TPL_/;
       const leafTexts = collectLeafTextNodes(sec);
       leafTexts.forEach((node) => {
         const t = node.data?.trim() ?? "";
         if (RESIDUE.test(t)) {
           // 自动清空：替换为空字符串
           node.data = "";
           args.warnings.push(`Slide ${slideIndex}: residue cleared '${t}'.`);
         }
       });
     });
   }
   ```

3. **`injector/stage3-injector.ts`**（或 stitcher facade 处）：在所有 slot-fill 完成 + chart-inject + image-resolve 之后调用 `applyPostStitchClean({ deckRoot, totalSlides: plan.slides.length, warnings })`。

4. **`tests/verify-stage3-injector.ts`** 加 case：fixture 中 fragment 故意保留 `<span class="slide-number" data-current="9" data-total="20"></span>` 与 `<span>FOO_BAR // 2026</span>` → 注入后断言：`data-current="<新 idx>"`、`data-total="<新总数>"`、`FOO_BAR // 2026` 已清空。

**边界**：不改 schema、不改 prompts、不改 frontend、不改 fragment 文件本身（让 ι 处理）。

---

### 3.4 Thread ι — Fragment Regeneration

**目标**：从源头清掉 fragment 的硬编码文案，让 injector 工作量最小。

**改动清单**：

1. **新建 `manifest/clear-fragments.ts` CLI 工具**：
   - 遍历 `.agents/skills/html-ppt/templates/full-decks/gemini/<id>/fragments/*.html`
   - 用 cheerio 加载每个 fragment
   - 对每个 leaf 文本元素（无 element children 的 `<h1>` `<h2>` `<h3>` `<p>` `<span>` `<strong>`）：
     - 清空文本（`$(el).text("")`）
     - 例外：保留 `<canvas>`、`<img>`、`<video>`、`<audio>`
   - 重置 `[data-current]` `[data-total]` 为占位 `0`（让 θ 的 post-clean 会覆盖）
   - 保留 `<canvas data-chart-slot>`、`<img data-image-slot>`、`<video data-video-slot>` 等结构属性
   - 输出回原文件
   - npm script：`npm run html-ppt-v3:clear-fragments`

2. 跑该工具，回写 20 模板的 fragment

3. 检查每个模板的 manifest，如果 anchor selector 因为某些 `<span>` 被清空导致 `:nth-of-type` 失效（例如原模板有 3 个 `<span>` 现在被认为是空的 1 个），需要重新校验 selector。建议：跑 `verify-template-fragments.ts`，失败即手动修。

4. **不要清** `<style>` `<script>` 内的内容；只清 inline 文本。

5. **特殊处理 chart**：fragment 内 `<canvas>` 不能清；但 chart fragment 可能包含图例文字 `<span>` —— 这些也应清，由 stage 3 chart-injector 渲染图例。

**边界**：只动 fragment HTML 与 manifest/clear-fragments.ts；不动 manifest-v2.json（除非 anchor 失效需要补 selector）；不动后端。

---

### 3.5 Thread κ — QA 收口

**目标**：防回归 + 矩阵复跑。

**改动清单**：

1. **新建 `tests/verify-no-residue.ts`**：
   - 跑一次完整生成（fake LLM）
   - 用 cheerio 加载产物 `index.html`
   - 断言：
     - 所有 `[data-total]` 值 == 实际 slide 数
     - 所有 `[data-current]` 值 == 自身所在 section 的 idx
     - 所有 `.slide-number` 文本格式 `\d{2} / \d{2}`
     - 全文 0 处匹配 `/[A-Z][A-Z0-9_]{4,}\s*\/\/\s*\d{4}/`
     - 全文 0 处出现 `EDIT_ME` `{{` `<!--SLIDES-->`（占位符未被替换）

2. **复跑 `verify-matrix.ts`**：240 用例不能下降。

3. 如果发现 ι 改 fragment 后 slot-filler 失败率上升（anchor 选不到了），开 issue 转 ι 修。

**边界**：只新建 tests/，不改业务实现。

---

## 4. 启动 prompt（人类复制即用）

### 4.1 Thread ζ
```
你是 html-ppt-v3 项目 Wave 3 的 Thread ζ（Schema Gating）。

必读：docs/00、docs/02、docs/06-WAVE_3_PLAN.md §1、§3.1
任务：按 docs/06 §3.1 完整实现 6 项改动；新增 includeChart / includeAudio 字段；不改 injector / frontend / 模板。
完成验收：cd apps/backend && npx tsx src/modules/ppt-chat/html-ppt-v3/tests/verify-stage1-planner.ts 全过；npm run typecheck --workspace @codex/backend 0 error。
完成后更新 THREAD_STATUS.md Wave 3 ζ 行为 ✅，里程碑日志追加一行。
```

### 4.2 Thread η
```
你是 html-ppt-v3 项目 Wave 3 的 Thread η（前端 Toggles）。

必读：docs/06-WAVE_3_PLAN.md §3.2
任务：在 apps/frontend/app/tools/html-ppt-v3/page.tsx 增加 2 个 checkbox（图表页 / 音频页），DEFAULT_REQUEST 与 submit body 同步。
完成验收：npm run typecheck --workspace @codex/frontend 0 error；浏览器打开页面能看到 4 个 checkbox。
完成后更新 THREAD_STATUS.md。
```

### 4.3 Thread θ
```
你是 html-ppt-v3 项目 Wave 3 的 Thread θ（Injector 硬化）。

必读：docs/06-WAVE_3_PLAN.md §3.3
任务：实现 slot-filler 强清未填 anchor + 新建 post-stitch-cleaner.ts + 在 stage3-injector facade 中调用；为 verify-stage3-injector.ts 增 page-number 与 residue case。
完成验收：cd apps/backend && npx tsx src/modules/ppt-chat/html-ppt-v3/tests/verify-stage3-injector.ts 全过；新增 case 通过。
不要改 fragment 文件（ι 处理）。
完成后更新 THREAD_STATUS.md。
```

### 4.4 Thread ι
```
你是 html-ppt-v3 项目 Wave 3 的 Thread ι（Fragment 重生）。

必读：docs/06-WAVE_3_PLAN.md §3.4
任务：写 manifest/clear-fragments.ts CLI；跑一次清空全 20 模板 fragment 的硬编码文本；如清空后 manifest anchor selector 失效，手动修正。
完成验收：cd apps/backend && npx tsx src/modules/ppt-chat/html-ppt-v3/tests/verify-template-fragments.ts 全过；手 grep 任一 fragment：grep -rE '[A-Z]{4,}_[A-Z]{2,}.*//.*20[0-9]{2}' templates/.../fragments → 0 匹配。
不要碰 backend / frontend 代码。
完成后更新 THREAD_STATUS.md。
```

### 4.5 Thread κ（最后启动）
```
你是 html-ppt-v3 项目 Wave 3 的 Thread κ（QA 收口）。

启动条件：ζ / η / θ / ι 全部 ✅。

必读：docs/06-WAVE_3_PLAN.md §3.5
任务：新建 tests/verify-no-residue.ts；复跑 verify-matrix.ts；记录 Wave 3 前后 warning-free 比例变化。
完成验收：verify-no-residue.ts 全过；matrix 成功率 ≥ 240/240，warning-free ≥ 235/240（Wave 2 是 229/240，期望提升）。
不要改业务实现，发现 bug 转回相应 thread。
完成后更新 THREAD_STATUS.md，整个 Wave 3 标 🟢，ship 决策给人类用户。
```

---

## 5. DoD（Wave 3 完成标志）

- [ ] ζ：4 toggles 在 schema/builder/validator/prompt/normalize 五处一致生效
- [ ] η：UI 4 个 checkbox 可点；提交后 SSE 不报 schema 错
- [ ] θ：测试用例覆盖页码重写 + residue 清理
- [ ] ι：20 模板 grep 无 `XXX // 2026` 模式
- [ ] κ：no-residue 测试 + matrix 复跑全绿
- [ ] **人类手测**：浏览器关掉图表 + 音频，生成的 deck 不含图表 / 音频 slide；任何 slide 的页码与实际位置匹配；不再有 ECO_HARMONY 等烙印

---

## 6. Risk

- **R1**：ι 清空 fragment 后，某些 manifest anchor 可能 `:nth-of-type(1)` 失效（因为子元素结构变了）。缓解：先在 1 个模板试，跑 verify-template-fragments，全过再批量。
- **R2**：θ 的 RESIDUE 正则可能误伤合法文本（如 `AI / 2026`、`5G / 2026`）。缓解：只匹配 `[A-Z]{4,}_[A-Z0-9_]{2,}` 模式（必须含下划线），避免误伤短词。
- **R3**：includeChart 默认 true 是为了向后兼容旧 client，但 prompt 仍可能让模型规划 chart——这是 by-design。如果用户取消勾选，schema 立即过滤，pool 中无 chart pageType，模型物理上选不到。
