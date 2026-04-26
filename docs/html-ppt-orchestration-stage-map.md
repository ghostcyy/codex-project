# HTML PPT Orchestration Pipeline (Current Implementation)

This document describes the **current orchestration flow** for HTML-PPT generation in the backend, including:
- Which code path runs each stage
- What each stage executes
- What functional outcome each stage delivers

## 1) Runtime Entry and Mode Selection

### Primary entry (queue + job runner)
- File: `apps/backend/src/modules/ppt-chat/ppt-chat.service.ts`
- Methods:
  - `createQueuedDeckOrchestration(...)`
  - `runDeckGenerationJob(...)`
  - `orchestrateDeckGeneration(...)`

### Mode switch
- In `orchestrateDeckGeneration(...)`, the default branch is:
  - `process.env.PPT_USE_LEGACY_RENDERER !== "1"` -> use `HtmlPptAgentService.generateDeck(...)` (current main pipeline)
- Legacy branch:
  - `process.env.PPT_USE_LEGACY_RENDERER === "1"` -> run old DeckSpec renderer pipeline (kept as fallback)

---

## 2) Current Main Pipeline (HtmlPptAgentService)

### Core orchestrator
- File: `apps/backend/src/modules/ppt-chat/html-ppt-agent.service.ts`
- Method: `generateDeck(...)`
- Stage IDs:
  - `01-read-skill`
  - `02-research`
  - `03-content-plan`
  - `04-visual-plan`
  - `05-generate-index`
  - `06-generate-style`
  - `07-publish`
  - `08-qa`
  - `completed`

### Stage 00 (Queue / Resume queue)
- Code:
  - `ppt-chat.service.ts` -> `createQueuedDeckOrchestration(...)`
- Operation:
  - Creates a running orchestration step before model generation starts.
  - Also used when resuming a failed/stale job.
- Function:
  - Gives immediate user-visible progress state and allows background continuation.

### Stage 01: Read skill and template catalog
- Code:
  - `html-ppt-agent.service.ts` -> `readSkillPack(...)`
  - `skill-asset-indexer.ts` -> `indexSkillAssets(...)`
- Operation:
  - Loads `SKILL.md`, layout references, full-deck references.
  - Reads template names, layout names, theme names.
  - Builds/loads typed asset manifest (`themes`, `layouts`, `fullDecks`, `animations`, `fxEffects`) with cache in `.local-runtime/skill-manifests`.
- Function:
  - Creates a structured local capability map so later prompt stages use real local assets instead of guessing.

### Stage 02: Topic research pack
- Code:
  - `html-ppt-agent.service.ts` -> `generateDeck(...)` stage block + `modelStructured(...)`
  - `prompt-builder.ts` -> `buildPrompt("research", ...)`
  - `html-ppt-agent.schemas.ts` -> `researchSchema`
- Operation:
  - Sends research prompt to model, requires strict JSON, validates with Zod schema.
  - If model fails, fallback research pack is generated locally.
- Function:
  - Produces normalized topic context (`topicSummary`, facts, angles, section suggestions, verification flags).

### Stage 03: Content planning
- Code:
  - `html-ppt-agent.service.ts` -> `normalizePlan(...)`, stage `03-content-plan`
  - `prompt-builder.ts` -> `buildPrompt("content-plan", ...)`
  - `html-ppt-agent.schemas.ts` -> `planSchema`
- Operation:
  - Calls model for structured slide plan with allowed `layoutId` constraints.
  - Normalizes/repairs output against local layout catalog.
- Function:
  - Produces executable slide plan: title, objective, audience, slide list, per-slide layout and key points.

### Stage 04: Visual planning
- Code:
  - `html-ppt-agent.service.ts` -> `normalizeVisual(...)`, `enrichVisualPlan(...)`
  - `prompt-builder.ts` -> `buildPrompt("visual-plan", ...)`
  - `html-ppt-agent.schemas.ts` -> `visualSchema`
- Operation:
  - Calls model for theme + per-slide visual instructions.
  - Constrains output to local theme/template catalogs from manifest.
- Function:
  - Produces visual contract: `primaryTheme`, backup themes, deck class, visual language, and per-slide composition/animation/fx.

### Stage 05: Generate `index.html` (batched sections)
- Code:
  - `html-ppt-agent.service.ts`
  - Main methods:
    - `generateIndexHtml(...)`
    - `buildSectionBatches(...)`
    - `processSectionBatch(...)`
    - `validateSectionBatch(...)`
    - `truncateBatchSectionsToDensityBudget(...)`
    - `repairSingleSlideFromSkeleton(...)`
- Prompt source:
  - `prompt-builder.ts` -> `buildPrompt("section-batch", ...)`
- Operation:
  - Splits slides into dynamic batches by layout density budget.
  - Runs batches with controlled concurrency.
  - Applies local sanitation before validation (notes removal, unsafe fx stripping, empty placeholder cleanup, `data-title` fix).
  - Performs hard/soft QA:
    - Hard issues -> model repair path
    - Soft issues -> local truncation first
  - Supports resume from failed batch snapshots/checkpoints.
- Function:
  - Produces valid section fragments and composes final `index.html` with runtime-required structure.

### Stage 06: Generate `style.css` with safety guard
- Code:
  - `html-ppt-agent.service.ts`
  - Main methods:
    - `generateStyleCss(...)`
    - `sanitizeGeneratedCss(...)`
    - `stripUnsupportedCssAtRules(...)`
    - `appendRuntimeCssGuard(...)`
    - `fallbackStyleCss(...)`
    - `readThemePalettePrompt(...)`
- Prompt source:
  - `prompt-builder.ts` -> `buildPrompt("css", ...)`
- Operation:
  - Calls model for CSS only.
  - Sanitizes disallowed CSS (`@media`, `@supports`, unsafe `.slide` rules, `.progress-bar`, etc.).
  - Appends hard runtime guard to preserve slide navigation contract.
  - Falls back to stable local CSS if model output is invalid/unavailable.
- Function:
  - Produces presentation style layer without breaking runtime navigation behavior.

### Stage 07: Publish static deck bundle
- Code:
  - Caller: `html-ppt-agent.service.ts` -> stage `07-publish`
  - Publisher: `apps/backend/src/modules/html-ppt-renderer/html-ppt-renderer.service.ts` -> `publishStaticDeck(...)`
- Operation:
  - Copies assets into output directory.
  - Inlines/scopes theme registry (`inlinePortableThemes(...)`), removes `assets/themes` directory for portability.
  - Writes `index.html`, `preview.html`, `standalone.html`, `style.css`, `manifest.json`.
  - Creates export zip (`html-ppt-deck.zip`).
- Function:
  - Produces portable output package with preview and downloadable archive.

### Stage 08: Local HTML QA + limited self-healing
- Code:
  - `html-ppt-agent.service.ts`
  - Main methods:
    - `qaPublishedDeck(...)`
    - `evaluatePublishedDeckQa(...)`
    - `repairPublishedDeckFit(...)`
    - `truncatePublishedDeckFit(...)`
    - `writeQaReportToManifest(...)`
- Operation:
  - Runs multi-signal QA:
    - Structure
    - Assets
    - Runtime contract
    - 16:9 fit estimation
    - Theme contrast
    - Portability/zip integrity
  - Attempts limited self-healing:
    - structural normalization
    - slide-level fit repair (bounded)
    - local truncation fallback
  - Persists `qaReport` into `manifest.json`.
- Function:
  - Enforces release gate quality and keeps published deck operational, portable, and visually fit.

---

## 3) Prompt and Schema Infrastructure

### Prompt assembly
- File: `apps/backend/src/modules/ppt-chat/prompt-builder.ts`
- API: `buildPrompt(stage, ctx)`
- Stages covered:
  - `research`
  - `content-plan`
  - `visual-plan`
  - `section-batch`
  - `css`
- Purpose:
  - Centralizes stage prompts and shared base constraints from skill rules.
  - Injects manifest catalogs (layouts/themes/full-decks) when available.

### Structured output validation
- File: `apps/backend/src/modules/ppt-chat/html-ppt-agent.schemas.ts`
- Schemas:
  - `researchSchema`
  - `planSchema`
  - `visualSchema`
- Purpose:
  - Strict JSON contract for model stages 02/03/04.
  - Supports model auto-repair call when first structured output is invalid.

---

## 4) Checkpointing and Resume Behavior

### Checkpoint model
- File: `apps/backend/src/modules/ppt-chat/html-ppt-agent.types.ts`
- Type: `HtmlPptAgentCheckpoint`
- Includes:
  - `nextStage`
  - stage artifacts (`research`, `plan`, `visual`, `indexResult`, `styleCss`, `deckRender`)
  - `failedIndexState`
  - `failureHistory`

### Resume controls
- Code:
  - `html-ppt-agent.service.ts` -> `normalizeAgentResumeStage(...)`
  - `ppt-chat.service.ts` -> `resumeMessageGeneration(...)`
- Behavior:
  - Resume continues from failed stage, not from stage 01.
  - If output directory is missing after publish, checkpoint rolls back to `07-publish`.
  - "Adopt" mode can mark checkpoint as completed and skip QA re-run.

---

## 5) Legacy Fallback Pipeline (Disabled by Default)

When `PPT_USE_LEGACY_RENDERER=1`, orchestration runs in `ppt-chat.service.ts` with these step meanings:
- `01` planning
- `02` initial DeckSpec generation
- `03` local structural QA
- `04` AI style planning
- `05` AI review
- `06` iterative revision (loop)
- `07` local re-check (loop)
- `08` AI re-review (loop)
- `09` render and export

This path still works as fallback, but current production behavior is the HtmlPptAgent 01-08 pipeline above.
