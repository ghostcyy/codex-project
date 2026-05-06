import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { Injectable } from "@nestjs/common";
import { z } from "zod";
import {
  ANIMATION_IDS,
  DONOR_IDS,
  FX_IDS,
  LAYOUT_IDS,
  RENDERABLE_LAYOUT_IDS,
  THEME_IDS,
  type DensityBudgetId,
  type DonorId,
  type FxId,
  type LayoutId,
  type RenderableLayoutId,
  type SlideRoleId,
  type ThemeId
} from "../ir/enums";
import {
  type DonorCatalogItem,
  donorContractSchema,
  layoutSanitySchema,
  type LayoutCatalogItem,
  type LayoutPrimitiveExpectation,
  type LayoutSanity,
  type LayoutSlotGroupContract,
  type RenderableLayoutContract,
  type SkillRegistry,
  templatePackageSchema,
  type ThemeCatalogItem,
  skillRegistrySchema
} from "./registry.schemas";

type RawLayoutSanityFile = {
  schemaVersion?: string;
  layouts?: Record<string, LayoutSanity>;
};

type RegistryCacheEntry = {
  sourceSignature: string;
  registry?: SkillRegistry;
  pending?: Promise<SkillRegistry>;
};

const LEGACY_TO_V2_LAYOUT: Record<string, LayoutId> = {
  bullets: "bullet-list",
  "big-quote": "quote",
  "process-steps": "process",
  "chart-bar": "chart",
  "chart-line": "chart",
  "chart-pie": "chart",
  "chart-radar": "chart",
  thanks: "cta"
};

const LEGACY_TO_V2_THEME: Record<string, ThemeId> = {
  "engineering-whiteprint": "engineering-whiteprint",
  "editorial-serif": "editorial-serif",
  "magazine-bold": "magazine-bold",
  "japanese-minimal": "japanese-minimal",
  "tokyo-night": "graphify-dark",
  "graphify-dark": "graphify-dark",
  blueprint: "knowledge-blueprint",
  aurora: "obsidian-gradient",
  glassmorphism: "obsidian-gradient",
  "obsidian-gradient": "obsidian-gradient",
  "terminal-green": "terminal-cyber",
  "cyberpunk-neon": "terminal-cyber",
  "soft-pastel": "xhs-pastel",
  "xhs-pastel": "xhs-pastel",
  "xhs-pastel-card": "xhs-pastel",
  "minimal-white": "minimal-nav",
  "dir-key-nav-minimal": "minimal-nav",
  "news-broadcast": "safety-alert",
  "testing-safety-alert": "safety-alert",
  "sunset-warm": "sunset-warm"
};

const ANIMATION_CLASS_RE = /\.anim-([a-z0-9-]+)\b/gi;

const NAMED_CSS_COLORS: Record<string, [number, number, number, number?]> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  transparent: [0, 0, 0, 0],
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  orange: [255, 165, 0],
  purple: [128, 0, 128],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  silver: [192, 192, 192],
  navy: [0, 0, 128],
  teal: [0, 128, 128],
  cyan: [0, 255, 255],
  magenta: [255, 0, 255]
};

const FX_SOURCE_BY_ID: Record<FxId, string | undefined> = {
  "soft-glow": "gradient-blob.js",
  "grid-lines": "data-stream.js",
  "particles-subtle": "particle-burst.js",
  spotlight: "orbit-ring.js",
  none: undefined
};

type LayoutContractSpec = {
  roleFit: SlideRoleId[];
  density: {
    preferred: DensityBudgetId;
    supported: DensityBudgetId[];
    maxNarrativeChars?: number;
  };
  axis?: RenderableLayoutContract["axis"];
  columns?: number;
  requiredSlots: LayoutSlotGroupContract[];
  optionalSlots?: LayoutSlotGroupContract[];
  primitives: LayoutPrimitiveExpectation[];
  fallbackLayouts: RenderableLayoutId[];
  notes?: string;
};

const requiredSlot = (
  id: string,
  type: LayoutSlotGroupContract["type"],
  range?: { minItems?: number; maxItems?: number }
): LayoutSlotGroupContract => ({ id, type, required: true, ...range });

const optionalSlot = (
  id: string,
  type: LayoutSlotGroupContract["type"],
  range?: { minItems?: number; maxItems?: number }
): LayoutSlotGroupContract => ({ id, type, required: false, ...range });

const RENDERABLE_LAYOUT_CONTRACT_SPECS: Record<RenderableLayoutId, LayoutContractSpec> = {
  cover: {
    roleFit: ["cover", "hook"],
    density: { preferred: "sparse", supported: ["sparse"], maxNarrativeChars: 1200 },
    axis: "single",
    columns: 1,
    requiredSlots: [requiredSlot("title", "title")],
    optionalSlots: [optionalSlot("kicker", "kicker"), optionalSlot("subtitle", "subtitle"), optionalSlot("meta", "meta", { maxItems: 4 })],
    primitives: ["cover-hero"],
    fallbackLayouts: ["image-hero", "quote", "two-column"],
    notes: "Hero opener with minimal body content."
  },
  toc: {
    roleFit: ["toc"],
    density: { preferred: "balanced", supported: ["sparse", "balanced"] },
    axis: "horizontal",
    columns: 2,
    requiredSlots: [requiredSlot("title", "title"), requiredSlot("items", "items", { minItems: 3, maxItems: 12 })],
    optionalSlots: [optionalSlot("kicker", "kicker"), optionalSlot("footer", "footer")],
    primitives: ["agenda-list"],
    fallbackLayouts: ["two-column"],
    notes: "Agenda or table-of-contents list."
  },
  "two-column": {
    roleFit: ["context", "analysis", "synthesis"],
    density: { preferred: "balanced", supported: ["sparse", "balanced", "dense"] },
    axis: "horizontal",
    columns: 2,
    requiredSlots: [requiredSlot("title", "title"), requiredSlot("body", "body", { minItems: 2, maxItems: 2 })],
    optionalSlots: [optionalSlot("bullets", "bullets", { maxItems: 8 }), optionalSlot("citations", "citations", { maxItems: 12 })],
    primitives: ["split-columns"],
    fallbackLayouts: ["three-column", "bullet-list"]
  },
  "three-column": {
    roleFit: ["context", "analysis", "synthesis"],
    density: { preferred: "dense", supported: ["balanced", "dense"] },
    axis: "horizontal",
    columns: 3,
    requiredSlots: [requiredSlot("title", "title"), requiredSlot("cards", "cards", { minItems: 3, maxItems: 3 })],
    optionalSlots: [optionalSlot("kicker", "kicker"), optionalSlot("citations", "citations", { maxItems: 12 })],
    primitives: ["card-columns"],
    fallbackLayouts: ["two-column", "bullet-list"]
  },
  "kpi-grid": {
    roleFit: ["data-highlight", "evidence"],
    density: { preferred: "balanced", supported: ["balanced", "dense"] },
    axis: "horizontal",
    columns: 4,
    requiredSlots: [requiredSlot("title", "title"), requiredSlot("metrics", "metrics", { minItems: 3, maxItems: 6 })],
    optionalSlots: [optionalSlot("summary", "summary"), optionalSlot("citations", "citations", { maxItems: 12 })],
    primitives: ["metric-grid"],
    fallbackLayouts: ["stat-highlight", "chart", "three-column"]
  },
  timeline: {
    roleFit: ["process", "case-study"],
    density: { preferred: "balanced", supported: ["balanced", "dense"] },
    axis: "horizontal",
    columns: 3,
    requiredSlots: [requiredSlot("title", "title"), requiredSlot("events", "events", { minItems: 4, maxItems: 8 })],
    optionalSlots: [optionalSlot("kicker", "kicker"), optionalSlot("citations", "citations", { maxItems: 12 })],
    primitives: ["timeline-rail"],
    fallbackLayouts: ["process", "three-column"]
  },
  comparison: {
    roleFit: ["comparison", "analysis"],
    density: { preferred: "balanced", supported: ["balanced", "dense"] },
    axis: "horizontal",
    columns: 2,
    requiredSlots: [requiredSlot("title", "title"), requiredSlot("sides", "comparison-sides", { minItems: 2, maxItems: 2 })],
    optionalSlots: [optionalSlot("verdict", "verdict"), optionalSlot("citations", "citations", { maxItems: 12 })],
    primitives: ["comparison-panels"],
    fallbackLayouts: ["two-column", "three-column"]
  },
  "bullet-list": {
    roleFit: ["context", "evidence", "analysis"],
    density: { preferred: "dense", supported: ["balanced", "dense"] },
    axis: "vertical",
    columns: 1,
    requiredSlots: [requiredSlot("title", "title"), requiredSlot("groups", "groups", { minItems: 2, maxItems: 4 })],
    optionalSlots: [optionalSlot("lede", "lede"), optionalSlot("footer", "footer"), optionalSlot("citations", "citations", { maxItems: 12 })],
    primitives: ["grouped-bullets"],
    fallbackLayouts: ["three-column", "two-column", "comparison"],
    notes: "Use for many low-complexity bullets without metric-driven evidence."
  },
  process: {
    roleFit: ["process", "case-study"],
    density: { preferred: "balanced", supported: ["balanced", "dense"] },
    axis: "horizontal",
    columns: 3,
    requiredSlots: [requiredSlot("title", "title"), requiredSlot("steps", "steps", { minItems: 3, maxItems: 6 })],
    optionalSlots: [optionalSlot("lede", "lede"), optionalSlot("footer", "footer"), optionalSlot("citations", "citations", { maxItems: 12 })],
    primitives: ["step-flow"],
    fallbackLayouts: ["timeline", "three-column", "quote"],
    notes: "Step-by-step process, phase flow, or rollout sequence."
  },
  "stat-highlight": {
    roleFit: ["data-highlight", "evidence"],
    density: { preferred: "sparse", supported: ["sparse", "balanced"], maxNarrativeChars: 1200 },
    axis: "horizontal",
    columns: 2,
    requiredSlots: [requiredSlot("title", "title"), requiredSlot("value", "value"), requiredSlot("label", "label"), requiredSlot("explanation", "explanation")],
    optionalSlots: [optionalSlot("cards", "cards", { minItems: 2, maxItems: 3 }), optionalSlot("citations", "citations", { maxItems: 12 })],
    primitives: ["stat-callout"],
    fallbackLayouts: ["kpi-grid", "chart", "three-column"]
  },
  "section-divider": {
    roleFit: ["transition-divider"],
    density: { preferred: "sparse", supported: ["sparse"], maxNarrativeChars: 1200 },
    axis: "single",
    columns: 1,
    requiredSlots: [requiredSlot("title", "title"), requiredSlot("marker", "marker")],
    optionalSlots: [optionalSlot("kicker", "kicker"), optionalSlot("progress", "progress-text"), optionalSlot("supporting", "supporting-text")],
    primitives: ["section-break"],
    fallbackLayouts: ["quote", "two-column"]
  },
  quote: {
    roleFit: ["hook", "context", "case-study", "transition-divider", "synthesis"],
    density: { preferred: "sparse", supported: ["sparse", "balanced"], maxNarrativeChars: 1200 },
    axis: "single",
    columns: 1,
    requiredSlots: [requiredSlot("title", "title"), requiredSlot("quote", "quote")],
    optionalSlots: [optionalSlot("kicker", "kicker"), optionalSlot("attribution", "attribution"), optionalSlot("supporting", "supporting-text"), optionalSlot("citations", "citations", { maxItems: 12 })],
    primitives: ["quote-block"],
    fallbackLayouts: ["two-column", "section-divider"]
  },
  chart: {
    roleFit: ["data-highlight", "evidence"],
    density: { preferred: "balanced", supported: ["balanced", "dense"] },
    axis: "horizontal",
    columns: 2,
    requiredSlots: [requiredSlot("title", "title"), requiredSlot("chart", "chart"), requiredSlot("insight", "body")],
    optionalSlots: [optionalSlot("citations", "citations", { maxItems: 12 })],
    primitives: ["chart-canvas"],
    fallbackLayouts: ["kpi-grid", "stat-highlight", "three-column"]
  },
  "image-hero": {
    roleFit: ["hook", "context", "case-study"],
    density: { preferred: "sparse", supported: ["sparse", "balanced"], maxNarrativeChars: 1200 },
    axis: "horizontal",
    columns: 2,
    requiredSlots: [requiredSlot("title", "title"), requiredSlot("body", "body")],
    optionalSlots: [optionalSlot("lede", "lede"), optionalSlot("image", "image"), optionalSlot("chips", "chips", { maxItems: 5 }), optionalSlot("citations", "citations", { maxItems: 12 })],
    primitives: ["visual-hero"],
    fallbackLayouts: ["quote", "two-column", "process"]
  },
  cta: {
    roleFit: ["cta", "thanks"],
    density: { preferred: "sparse", supported: ["sparse"], maxNarrativeChars: 1200 },
    axis: "single",
    columns: 1,
    requiredSlots: [requiredSlot("title", "title"), requiredSlot("headline", "headline"), requiredSlot("action", "action")],
    optionalSlots: [optionalSlot("supporting", "supporting-text"), optionalSlot("footer", "footer")],
    primitives: ["call-to-action"],
    fallbackLayouts: ["quote", "two-column"]
  }
};

@Injectable()
export class SkillRegistryService {
  private static readonly cache = new Map<string, RegistryCacheEntry>();

  async hydrate(skillRoot = resolve(process.cwd(), "..", "..", ".agents", "skills", "html-ppt")): Promise<SkillRegistry> {
    const root = resolve(skillRoot);
    await this.assertSkillRoot(root);
    const sourceSignature = await this.computeSourceSignature(root);
    const cached = SkillRegistryService.cache.get(root);
    if (cached?.sourceSignature === sourceSignature) {
      if (cached.registry) {
        return cached.registry;
      }
      if (cached.pending) {
        return cached.pending;
      }
    }

    const pending = this.hydrateFresh(root, sourceSignature);
    SkillRegistryService.cache.set(root, { sourceSignature, pending });
    try {
      const registry = await pending;
      SkillRegistryService.cache.set(root, { sourceSignature, registry });
      return registry;
    } catch (error) {
      const latest = SkillRegistryService.cache.get(root);
      if (latest?.pending === pending) {
        SkillRegistryService.cache.delete(root);
      }
      throw error;
    }
  }

  clearCache() {
    SkillRegistryService.cache.clear();
  }

  cacheStats() {
    return {
      entries: SkillRegistryService.cache.size,
      roots: [...SkillRegistryService.cache.keys()]
    };
  }

  private async hydrateFresh(root: string, sourceSignature: string): Promise<SkillRegistry> {

    const [layouts, themes, donors, templatePackages, animations, fx] = await Promise.all([
      this.loadLayouts(root),
      this.loadThemes(root),
      this.loadDonors(root),
      this.loadTemplatePackages(root),
      this.loadAnimations(root),
      this.loadFx(root)
    ]);

    const hash = this.hashJson({
      root,
      layouts: layouts.map((item) => [item.id, item.sourceId, item.file, item.contract]),
      themes: themes.map((item) => [item.id, item.sourceId, item.file, item.tokens]),
      donors: donors.map((item) => [item.id, item.sourceId, item.dir, item.contract]),
      templatePackages: templatePackages.map((item) => [item.id, item.donorTemplateId, item.themeId, item.layoutPolicy]),
      animations: animations.map((item) => item.id),
      fx: fx.map((item) => item.id),
      source: sourceSignature.slice(0, 12)
    });

    const registry = {
      version: "html-ppt-v2-registry-v1",
      skillRoot: root,
      hash,
      generatedAt: new Date().toISOString(),
      layouts,
      themes,
      donors,
      templatePackages,
      animations,
      fx
    } satisfies SkillRegistry;

    return skillRegistrySchema.parse(registry);
  }

  private async assertSkillRoot(root: string) {
    const required = [
      "SKILL.md",
      join("assets", "themes"),
      join("assets", "animations", "animations.css"),
      join("assets", "animations", "fx"),
      join("templates", "single-page"),
      join("templates", "full-decks")
    ];
    for (const entry of required) {
      const target = join(root, entry);
      if (!existsSync(target)) {
        throw new Error(`HTML-PPT skill root is missing required asset: ${target}`);
      }
    }
  }

  private async computeSourceSignature(root: string): Promise<string> {
    const files = await this.collectSourceFiles(root);
    const signatures = await Promise.all(files.map(async (file) => {
      const fileStat = await stat(file);
      return `${file}:${fileStat.size}:${fileStat.mtimeMs}`;
    }));
    return createHash("sha256").update(signatures.sort().join("\n")).digest("hex");
  }

  private async collectSourceFiles(root: string): Promise<string[]> {
    const files = [
      join(root, "SKILL.md"),
      join(root, "assets", "animations", "animations.css"),
      join(root, "templates", "single-page", "layout-sanity.json")
    ];
    files.push(...await this.listFiles(join(root, "assets", "themes"), (name) => name.endsWith(".css")));
    files.push(...await this.listFiles(join(root, "assets", "animations", "fx"), (name) => name.endsWith(".js")));
    files.push(...await this.listFiles(join(root, "templates", "single-page"), (name) => name.endsWith(".html") || name.endsWith(".json")));
    for (const donorId of DONOR_IDS) {
      const dir = join(root, "templates", "full-decks", donorId);
      files.push(
        join(dir, "index.html"),
        join(dir, "style.css"),
        join(dir, "donor-contract.json"),
        join(dir, "template-package.json"),
        join(dir, "thumbnail.svg"),
        join(dir, "thumbnail.png")
      );
    }
    return [...new Set(files.map((file) => resolve(file)))].filter((file) => existsSync(file));
  }

  private async listFiles(dir: string, accept: (name: string) => boolean): Promise<string[]> {
    const names = await readdir(dir);
    return names.filter(accept).map((name) => join(dir, name));
  }

  private async loadLayouts(root: string): Promise<LayoutCatalogItem[]> {
    const dir = join(root, "templates", "single-page");
    const sanity = await this.loadLayoutSanity(dir);
    const files = (await readdir(dir)).filter((name) => name.endsWith(".html")).sort();
    const seen = new Set<LayoutId>();
    const layouts: LayoutCatalogItem[] = [];

    for (const file of files) {
      const sourceId = basename(file, ".html");
      const mapped = this.mapLayoutId(sourceId);
      if (!mapped || seen.has(mapped)) continue;

      const htmlTemplate = await readFile(join(dir, file), "utf8");
      const capacity = sanity[sourceId] ?? {};
      const contract = this.buildLayoutContract(mapped, capacity);
      layouts.push({
        id: mapped,
        sourceId,
        file: join(dir, file),
        roleFit: contract.roleFit,
        capacity,
        contract,
        slotKind: mapped,
        htmlTemplate,
        tags: this.inferLayoutTags(mapped, capacity)
      });
      seen.add(mapped);
    }

    for (const required of LAYOUT_IDS) {
      if (!seen.has(required)) {
        throw new Error(`Missing v2 layout mapping for '${required}'.`);
      }
    }

    return layouts;
  }

  private async loadThemes(root: string): Promise<ThemeCatalogItem[]> {
    const dir = join(root, "assets", "themes");
    const files = (await readdir(dir)).filter((name) => name.endsWith(".css")).sort();
    const byId = new Map<ThemeId, ThemeCatalogItem>();

    for (const file of files) {
      const sourceId = basename(file, ".css");
      const id = LEGACY_TO_V2_THEME[sourceId];
      if (!id || byId.has(id)) continue;

      const css = await readFile(join(dir, file), "utf8");
      const tokens = this.extractThemeTokens(css);
      const wcag = this.computeThemeWcag(tokens);
      byId.set(id, {
        id,
        sourceId,
        file: join(dir, file),
        css,
        tokens,
        wcag,
        tags: this.inferThemeTags(id)
      });
    }

    for (const required of THEME_IDS) {
      if (!byId.has(required)) {
        throw new Error(`Missing v2 theme mapping for '${required}'.`);
      }
    }

    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  private async loadDonors(root: string): Promise<DonorCatalogItem[]> {
    const baseDir = join(root, "templates", "full-decks");
    const donors: DonorCatalogItem[] = [];

    for (const id of DONOR_IDS) {
      const dir = join(baseDir, id);
      const css = await readFile(join(dir, "style.css"), "utf8");
      const index = await readFile(join(dir, "index.html"), "utf8").catch(() => "");
      const contractFile = join(dir, "donor-contract.json");
      if (!existsSync(contractFile)) {
        throw new Error(`Donor '${id}' is missing required donor contract: ${contractFile}`);
      }
      const contractRaw = await readFile(contractFile, "utf8");
      const contract = this.parseDonorContract(contractRaw, id, contractFile);
      donors.push({
        id,
        sourceId: id,
        dir,
        deckClass: this.extractDeckClass(index) ?? `tpl-${id}`,
        contract,
        css,
        tags: this.inferDonorTags(id)
      });
    }

    return donors;
  }

  private async loadTemplatePackages(root: string) {
    const baseDir = join(root, "templates", "full-decks");
    const packages = [];
    for (const id of DONOR_IDS) {
      const dir = join(baseDir, id);
      const file = join(dir, "template-package.json");
      if (!existsSync(file)) {
        throw new Error(`Donor '${id}' is missing required template package: ${file}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(file, "utf8"));
      } catch (error) {
        throw new Error(`Template package '${id}' is not valid JSON: ${file}`, { cause: error });
      }
      const result = templatePackageSchema.safeParse(parsed);
      if (!result.success) {
        const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "template"}: ${issue.message}`).join("; ");
        throw new Error(`Template package '${id}' is invalid: ${issues}`);
      }
      const thumbnailPath = resolve(dir, result.data.thumbnailFile);
      const safeDir = resolve(dir);
      const thumbnailRelative = relative(safeDir, thumbnailPath);
      if (thumbnailRelative.startsWith("..") || isAbsolute(thumbnailRelative)) {
        throw new Error(`Template package '${id}' thumbnailFile must stay inside the donor directory: ${result.data.thumbnailFile}`);
      }
      if (!existsSync(thumbnailPath)) {
        throw new Error(`Template package '${id}' thumbnailFile is missing: ${thumbnailPath}`);
      }
      packages.push(result.data);
    }
    return packages.sort((a, b) => a.id.localeCompare(b.id));
  }

  private async loadAnimations(root: string) {
    const file = join(root, "assets", "animations", "animations.css");
    const css = await readFile(file, "utf8");
    const discovered = new Set<string>();
    for (const match of css.matchAll(ANIMATION_CLASS_RE)) {
      if (match[1]) discovered.add(match[1]);
    }
    const required = ANIMATION_IDS.filter((id) => id !== "none");
    const missing = required.filter((id) => !discovered.has(id));
    if (missing.length) {
      throw new Error(`animations.css is missing renderer-supported animation classes: ${missing.map((id) => `.anim-${id}`).join(", ")}`);
    }

    return required.sort().map((id) => ({
      id,
      cssClass: `anim-${id}`,
      kind: id.includes("loop") || id.includes("pulse") || id.includes("shimmer") ? "loop" as const : "enter" as const,
      perfClass: this.inferAnimationPerf(id)
    }));
  }

  private async loadFx(root: string) {
    const dir = join(root, "assets", "animations", "fx");
    const files = (await readdir(dir)).filter((name) => name.endsWith(".js") && !name.startsWith("_")).sort();
    const fileSet = new Set(files);
    const items = FX_IDS.filter((id) => id !== "none").map((id) => {
      const sourceFile = FX_SOURCE_BY_ID[id];
      if (!sourceFile) {
        throw new Error(`FX '${id}' is missing a source file mapping.`);
      }
      if (!fileSet.has(sourceFile)) {
        throw new Error(`FX '${id}' source file is missing: ${join(dir, sourceFile)}`);
      }
      return {
        id,
        file: join(dir, sourceFile),
        perfClass: this.inferFxPerf(id)
      };
    });

    return items.sort((a, b) => a.id.localeCompare(b.id));
  }

  private async loadLayoutSanity(dir: string): Promise<Record<string, LayoutSanity>> {
    const raw = await readFile(join(dir, "layout-sanity.json"), "utf8");
    const parsed = JSON.parse(raw) as RawLayoutSanityFile;
    return z.record(z.string(), layoutSanitySchema).parse(parsed.layouts ?? {});
  }

  private mapLayoutId(sourceId: string): LayoutId | undefined {
    const mapped = LEGACY_TO_V2_LAYOUT[sourceId] ?? sourceId;
    return (LAYOUT_IDS as readonly string[]).includes(mapped) ? mapped as LayoutId : undefined;
  }

  private buildLayoutContract(layoutId: LayoutId, capacity: LayoutSanity): RenderableLayoutContract {
    if (!(RENDERABLE_LAYOUT_IDS as readonly string[]).includes(layoutId)) {
      throw new Error(`Layout '${layoutId}' is not in the renderable layout contract set.`);
    }
    const renderableLayoutId = layoutId as RenderableLayoutId;
    const spec = RENDERABLE_LAYOUT_CONTRACT_SPECS[renderableLayoutId];
    const axis = spec.axis ?? (capacity.horizontal ? "horizontal" : "vertical");
    const columns = spec.columns ?? capacity.columns ?? 1;
    return {
      id: renderableLayoutId,
      roleFit: spec.roleFit,
      density: spec.density,
      axis,
      columns,
      capacity,
      requiredSlots: spec.requiredSlots,
      optionalSlots: spec.optionalSlots ?? [],
      primitives: spec.primitives,
      fallbackLayouts: spec.fallbackLayouts,
      ...(spec.notes ? { notes: spec.notes } : {})
    };
  }

  private inferLayoutTags(layoutId: LayoutId, sanity: LayoutSanity): string[] {
    const tags = new Set<string>([layoutId]);
    if (sanity.horizontal) tags.add("horizontal");
    if ((sanity.columns ?? 1) > 1) tags.add(`${sanity.columns}-columns`);
    if (sanity.requiresCanvas || layoutId === "chart") tags.add("canvas");
    return [...tags];
  }

  private inferThemeTags(themeId: ThemeId): string[] {
    if (themeId.includes("cyber") || themeId.includes("terminal") || themeId.includes("graphify")) return ["technical", "dark"];
    if (themeId.includes("editorial") || themeId.includes("magazine")) return ["editorial", "story"];
    if (themeId.includes("pastel") || themeId.includes("sunset")) return ["warm", "consumer"];
    if (themeId.includes("whiteprint") || themeId.includes("blueprint")) return ["technical", "clean"];
    return ["general"];
  }

  private inferDonorTags(donorId: DonorId): string[] {
    if (donorId.includes("tech") || donorId.includes("cyber") || donorId.includes("graph")) return ["technical"];
    if (donorId.includes("xhs")) return ["social", "editorial"];
    if (donorId.includes("course") || donorId.includes("presenter")) return ["education", "clean"];
    if (donorId.includes("safety")) return ["alert", "technical"];
    if (donorId.includes("pitch") || donorId.includes("product")) return ["business"];
    return ["general"];
  }

  private extractThemeTokens(css: string): ThemeCatalogItem["tokens"] {
    const vars = new Map<string, string>();
    for (const match of css.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
      if (match[1] && match[2]) vars.set(match[1], match[2].trim());
    }

    const read = (key: string, fallback: string) => vars.get(key) ?? fallback;
    return {
      bg: read("bg", "#ffffff"),
      surface: read("surface", "#ffffff"),
      surface2: read("surface-2", read("surface", "#ffffff")),
      accent: read("accent", "#2563eb"),
      accent2: read("accent-2", read("accent", "#2563eb")),
      accent3: read("accent-3", read("accent-2", read("accent", "#2563eb"))),
      text1: read("text-1", "#111827"),
      text2: read("text-2", "#374151"),
      border: read("border", "rgba(0,0,0,.15)")
    };
  }

  private computeThemeWcag(tokens: ThemeCatalogItem["tokens"]) {
    const pairs = [
      ["text1/bg", tokens.text1, tokens.bg, tokens.bg],
      ["text2/bg", tokens.text2, tokens.bg, tokens.bg],
      ["text1/surface", tokens.text1, tokens.surface, tokens.bg],
      ["text2/surface", tokens.text2, tokens.surface, tokens.bg],
      ["text1/surface2", tokens.text1, tokens.surface2, tokens.bg]
    ] as const;
    const ratios = pairs.map(([label, fg, bg, base]) => ({ label, ratio: this.contrastRatio(fg, bg, base) }));
    const min = Math.min(...ratios.map((item) => item.ratio));
    const issues = ratios.filter((item) => item.ratio < 4.5).map((item) => `${item.label} contrast ${item.ratio.toFixed(2)} is below AA.`);
    return {
      passed: issues.length === 0,
      minContrastRatio: Number(min.toFixed(2)),
      issues
    };
  }

  private contrastRatio(foreground: string, background: string, baseBackground: string): number {
    const base = this.parseCssColor(baseBackground);
    const bg = this.parseCssColor(background, base);
    const fg = this.parseCssColor(foreground, bg);
    if (!fg || !bg) return 0;
    const l1 = this.relativeLuminance(fg);
    const l2 = this.relativeLuminance(bg);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  private parseCssColor(value: string, alphaBackground: [number, number, number] = [255, 255, 255]): [number, number, number] | undefined {
    const input = value.trim().toLowerCase();
    const named = NAMED_CSS_COLORS[input];
    if (named) {
      const [r, g, b, alpha = 1] = named;
      return this.blendAlpha([r, g, b], alpha, alphaBackground);
    }

    const hex = input.match(/^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i)?.[1];
    if (hex) {
      const full = hex.length === 3 || hex.length === 4
        ? hex.split("").map((part) => part + part).join("")
        : hex;
      const rgb = [0, 2, 4].map((offset) => Number.parseInt(full.slice(offset, offset + 2), 16)) as [number, number, number];
      if (full.length === 8) {
        return this.blendAlpha(rgb, Number.parseInt(full.slice(6, 8), 16) / 255, alphaBackground);
      }
      return rgb;
    }

    const rgbMatch = input.match(/^rgba?\((.+)\)$/);
    if (rgbMatch?.[1]) {
      const parts = this.splitCssColorArgs(rgbMatch[1]);
      if (parts.length >= 3) {
        const rgb = parts.slice(0, 3).map((part) => this.parseCssChannel(part));
        if (rgb.every((part): part is number => typeof part === "number")) {
          const alpha = parts[3] !== undefined ? this.parseCssAlpha(parts[3]) : 1;
          return this.blendAlpha(rgb as [number, number, number], alpha, alphaBackground);
        }
      }
    }

    const hslMatch = input.match(/^hsla?\((.+)\)$/);
    if (hslMatch?.[1]) {
      const parts = this.splitCssColorArgs(hslMatch[1]);
      if (parts.length >= 3) {
        const hue = Number.parseFloat(parts[0]!);
        const saturation = this.parsePercentage(parts[1]!);
        const lightness = this.parsePercentage(parts[2]!);
        if (Number.isFinite(hue) && saturation !== undefined && lightness !== undefined) {
          const alpha = parts[3] !== undefined ? this.parseCssAlpha(parts[3]) : 1;
          return this.blendAlpha(this.hslToRgb(hue, saturation, lightness), alpha, alphaBackground);
        }
      }
    }

    const oklchMatch = input.match(/^oklch\((.+)\)$/);
    if (oklchMatch?.[1]) {
      const parts = this.splitCssColorArgs(oklchMatch[1]);
      if (parts.length >= 3) {
        const lightness = this.parseOkLightness(parts[0]!);
        const chroma = Number.parseFloat(parts[1]!);
        const hue = Number.parseFloat(parts[2]!);
        if (lightness !== undefined && Number.isFinite(chroma) && Number.isFinite(hue)) {
          const alpha = parts[3] !== undefined ? this.parseCssAlpha(parts[3]) : 1;
          return this.blendAlpha(this.oklabToRgb(lightness, chroma * Math.cos((hue * Math.PI) / 180), chroma * Math.sin((hue * Math.PI) / 180)), alpha, alphaBackground);
        }
      }
    }

    const oklabMatch = input.match(/^oklab\((.+)\)$/);
    if (oklabMatch?.[1]) {
      const parts = this.splitCssColorArgs(oklabMatch[1]);
      if (parts.length >= 3) {
        const lightness = this.parseOkLightness(parts[0]!);
        const a = Number.parseFloat(parts[1]!);
        const b = Number.parseFloat(parts[2]!);
        if (lightness !== undefined && Number.isFinite(a) && Number.isFinite(b)) {
          const alpha = parts[3] !== undefined ? this.parseCssAlpha(parts[3]) : 1;
          return this.blendAlpha(this.oklabToRgb(lightness, a, b), alpha, alphaBackground);
        }
      }
    }

    return undefined;
  }

  private splitCssColorArgs(value: string): string[] {
    return value
      .replace(/\s*\/\s*/g, " ")
      .split(/,\s*|\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
  }

  private parseCssChannel(value: string): number | undefined {
    if (value.endsWith("%")) {
      const percentage = this.parsePercentage(value);
      return percentage === undefined ? undefined : Math.round(percentage * 255);
    }
    const number = Number.parseFloat(value);
    if (!Number.isFinite(number)) return undefined;
    return Math.min(255, Math.max(0, Math.round(number)));
  }

  private parseCssAlpha(value: string): number {
    if (value.endsWith("%")) {
      return this.parsePercentage(value) ?? 1;
    }
    const alpha = Number.parseFloat(value);
    if (!Number.isFinite(alpha)) return 1;
    return Math.min(1, Math.max(0, alpha));
  }

  private parsePercentage(value: string): number | undefined {
    const number = Number.parseFloat(value.replace(/%$/, ""));
    if (!Number.isFinite(number)) return undefined;
    return Math.min(1, Math.max(0, number / 100));
  }

  private parseOkLightness(value: string): number | undefined {
    if (value.endsWith("%")) {
      return this.parsePercentage(value);
    }
    const lightness = Number.parseFloat(value);
    if (!Number.isFinite(lightness)) return undefined;
    return Math.min(1, Math.max(0, lightness));
  }

  private blendAlpha(rgb: [number, number, number], alpha: number, background: [number, number, number]): [number, number, number] {
    if (alpha >= 1) return rgb;
    return rgb.map((channel, index) => Math.round(channel * alpha + background[index]! * (1 - alpha))) as [number, number, number];
  }

  private hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
    const h = ((((hue % 360) + 360) % 360) / 360);
    if (saturation === 0) {
      const gray = Math.round(lightness * 255);
      return [gray, gray, gray];
    }
    const q = lightness < 0.5 ? lightness * (1 + saturation) : lightness + saturation - lightness * saturation;
    const p = 2 * lightness - q;
    const channels = [h + 1 / 3, h, h - 1 / 3].map((t) => {
      let value = t;
      if (value < 0) value += 1;
      if (value > 1) value -= 1;
      if (value < 1 / 6) return p + (q - p) * 6 * value;
      if (value < 1 / 2) return q;
      if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6;
      return p;
    });
    return channels.map((channel) => Math.round(channel * 255)) as [number, number, number];
  }

  private oklabToRgb(lightness: number, a: number, b: number): [number, number, number] {
    const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
    const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
    const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;

    const l = lPrime ** 3;
    const m = mPrime ** 3;
    const s = sPrime ** 3;

    const linear = [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
    ];

    return linear.map((channel) => {
      const clamped = Math.min(1, Math.max(0, channel));
      const srgb = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * (clamped ** (1 / 2.4)) - 0.055;
      return Math.round(srgb * 255);
    }) as [number, number, number];
  }

  private relativeLuminance(rgb: [number, number, number]): number {
    const [r, g, b] = rgb.map((channel) => {
      const normalized = channel / 255;
      return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  }

  private parseDonorContract(raw: string, donorId: string, file: string): DonorCatalogItem["contract"] {
    if (!raw.trim()) {
      throw new Error(`Donor '${donorId}' contract file is empty: ${file}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Donor '${donorId}' contract file is not valid JSON: ${file}`, { cause: error });
    }
    const result = donorContractSchema.safeParse(parsed);
    if (!result.success) {
      const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "contract"}: ${issue.message}`).join("; ");
      throw new Error(`Donor '${donorId}' contract is invalid: ${issues}`);
    }
    return result.data;
  }

  private extractDeckClass(indexHtml: string): string | undefined {
    return indexHtml.match(/\bclass=["'][^"']*\b(tpl-[a-z0-9-]+)\b/i)?.[1];
  }

  private inferAnimationPerf(id: string): "cheap" | "medium" | "heavy" {
    if (id.includes("3d") || id.includes("glitch") || id.includes("blur")) return "heavy";
    if (id.includes("shimmer") || id.includes("draw") || id.includes("morph")) return "medium";
    return "cheap";
  }

  private inferFxPerf(id: FxId): "medium" | "heavy" {
    return id === "particles-subtle" ? "heavy" : "medium";
  }

  private hashJson(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
  }
}

export async function hydrateHtmlPptV2SkillRegistry(skillRoot?: string): Promise<SkillRegistry> {
  return new SkillRegistryService().hydrate(skillRoot);
}
