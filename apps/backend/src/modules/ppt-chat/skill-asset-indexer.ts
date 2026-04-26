import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ThemePalette = {
  bg: string;
  surface: string;
  border: string;
  text1: string;
  text2: string;
  accent: string;
  accent2: string;
  accent3: string;
  good: string;
  warn: string;
  bad: string;
  radius: string;
  isDark: boolean;
};

export type ThemeAsset = {
  id: string;
  palette: ThemePalette;
  mood: string;
  tags: string[];
};

export type LayoutRole = "cover" | "divider" | "content" | "chart" | "image" | "closer";

export type LayoutDensityBudget = {
  maxTitleChars: number;
  maxBodyCharsTotal: number;
  maxItems: number;
  maxCardCount: number;
};

export type LayoutAsset = {
  id: string;
  role: LayoutRole;
  slots: string[];
  densityBudget: LayoutDensityBudget;
  canvasRequired: boolean;
  tags: string[];
};

export type FullDeckAsset = {
  id: string;
  slideCount: number;
  deckClass: string;
  themesReferenced: string[];
  animationsUsed: string[];
  indexSnippet: string;
  styleSnippet: string;
  previewSlides: string[];
  previewCss: string;
  tags: string[];
};

export type AnimationAsset = {
  id: string;
  cssClass: string;
  kind: "enter" | "loop" | "fx";
  perfClass: "cheap" | "medium" | "heavy";
};

export type FxEffectAsset = {
  id: string;
  kind: "canvas";
  perfClass: "medium" | "heavy";
};

export type SkillAssetManifest = {
  hash: string;
  generatedAt: string;
  skillRoot: string;
  themes: ThemeAsset[];
  layouts: LayoutAsset[];
  fullDecks: FullDeckAsset[];
  animations: AnimationAsset[];
  fxEffects: FxEffectAsset[];
};

// ── Constants ─────────────────────────────────────────────────────────────────

const LAYOUT_ROLES: Record<string, LayoutRole> = {
  cover: "cover",
  toc: "divider",
  "section-divider": "divider",
  "chart-bar": "chart",
  "chart-line": "chart",
  "chart-pie": "chart",
  "chart-radar": "chart",
  "image-hero": "image",
  "image-grid": "image",
  cta: "closer",
  thanks: "closer",
};

// CSS class names that represent meaningful content slots in layout templates
const KNOWN_SLOTS = [
  "kicker", "eyebrow", "h1", "h2", "h3", "lede", "card", "grid",
  "timeline", "comparison-panel", "counter", "pill", "metric-large",
  "flow-node", "roadmap-column", "gantt-row", "mindmap", "table",
  "code-block", "diff-block", "terminal-window",
];

// Animation IDs that loop indefinitely (medium perf, not enter-once)
const LOOP_ANIM_IDS = new Set([
  "neon-glow", "shimmer-sweep", "gradient-flow",
  "parallax-tilt", "path-draw", "morph-shape",
]);

// Animation IDs that use 3D transforms or heavy filters
const HEAVY_ANIM_IDS = new Set([
  "card-flip-3d", "cube-rotate-3d", "page-turn-3d",
  "perspective-zoom", "glitch-in", "blur-in",
]);

// Canvas FX effects that require complex per-frame computation
const HEAVY_FX_IDS = new Set([
  "neural-net", "knowledge-graph", "galaxy-swirl",
  "starfield", "constellation", "magnetic-field", "matrix-rain",
]);

// Mood/purpose descriptions keyed by theme ID, for model context
const THEME_MOOD: Record<string, string> = {
  "minimal-white": "极简白，克制高级，适合严肃内容。",
  "editorial-serif": "杂志衬线，适合文字叙事和品牌故事。",
  "soft-pastel": "柔和马卡龙，适合消费产品和轻松主题。",
  "sharp-mono": "黑白硬朗，适合宣言和强观点。",
  "arctic-cool": "清冷蓝灰，适合理性分析。",
  "sunset-warm": "暖橘渐变，适合积极情绪和生活方式。",
  "catppuccin-latte": "浅色开发者友好主题。",
  "catppuccin-mocha": "深色开发者友好主题。",
  dracula: "经典深色紫红，适合代码和技术分享。",
  "tokyo-night": "蓝夜深色，适合基础设施和工程主题。",
  nord: "北欧冷色，适合云产品和架构。",
  "solarized-light": "低眩光浅色，适合教学和长时间观看。",
  "gruvbox-dark": "复古暖深色，适合终端和开源社区。",
  "rose-pine": "柔和暗色，适合审美向技术。",
  "neo-brutalism": "粗描边硬阴影，适合创业和冲击表达。",
  glassmorphism: "毛玻璃和光斑，适合产品发布。",
  bauhaus: "红黄蓝几何，适合设计和艺术主题。",
  "swiss-grid": "瑞士网格，适合严肃排版和设计行业。",
  "terminal-green": "绿屏终端，适合 CLI、安全和复古技术。",
  "xiaohongshu-white": "小红书白底暖红，适合生活美学。",
  "rainbow-gradient": "彩虹渐变，适合欢乐和节庆。",
  aurora: "极光渐变，适合封面和结尾。",
  blueprint: "蓝图工程网格，适合架构和系统设计。",
  "memphis-pop": "孟菲斯波普，适合年轻潮流主题。",
  "cyberpunk-neon": "赛博霓虹，适合黑客和未来科技。",
  "y2k-chrome": "银铬千禧，适合 Gen-Z 和时尚。",
  "retro-tv": "CRT 怀旧，适合复古叙事。",
  "japanese-minimal": "日式极简，适合品牌和禅意叙事。",
  vaporwave: "蒸汽波，适合潮流和音乐。",
  midcentury: "中世纪复古几何，适合设计史。",
  "corporate-clean": "专业白底海军蓝，适合 B2B 和董事会。",
  "academic-paper": "论文白衬线，适合学术研究。",
  "news-broadcast": "新闻播报风，适合发布通稿。",
  "pitch-deck-vc": "VC 路演风，适合融资。",
  "magazine-bold": "大胆杂志封面，适合专题故事。",
  "engineering-whiteprint": "工程白图，适合 API 和系统文档。",
};

// ── Public entry point ────────────────────────────────────────────────────────

/**
 * Builds (or loads from cache) a SkillAssetManifest describing every theme,
 * layout template, full-deck template, CSS animation, and canvas FX effect
 * available in the given skill root.
 *
 * The manifest is filesystem-derived: dropping new assets into the skill
 * directory automatically extends it on the next call without code changes.
 *
 * Cache lives in workspace .local-runtime/skill-manifests keyed by a content hash
 * of the asset directories, so it invalidates whenever files are added or removed.
 */
export async function indexSkillAssets(skillRoot: string): Promise<SkillAssetManifest> {
  const hash = await computeSkillHash(skillRoot);
  const cached = await readCache(hash);
  if (cached) return cached;

  const [themes, layouts, fullDecks, animResult] = await Promise.all([
    indexThemes(skillRoot),
    indexLayouts(skillRoot),
    indexFullDecks(skillRoot),
    indexAnimations(skillRoot),
  ]);

  // Calibrate layout density budgets against the full-deck templates' actual
  // body sections so academic / editorial / dense decks no longer fail the
  // post-publish fit check on content that the skill itself ships.
  const calibratedLayouts = calibrateLayoutBudgetsAgainstFullDecks(layouts, fullDecks);

  const manifest: SkillAssetManifest = {
    hash,
    generatedAt: new Date().toISOString(),
    skillRoot,
    themes,
    layouts: calibratedLayouts,
    fullDecks,
    animations: animResult.animations,
    fxEffects: animResult.fxEffects,
  };

  await writeCache(hash, manifest);
  return manifest;
}

// ── Hash & cache ──────────────────────────────────────────────────────────────

async function computeSkillHash(skillRoot: string): Promise<string> {
  const paths = [
    join(skillRoot, "SKILL.md"),
    join(skillRoot, "assets", "themes"),
    join(skillRoot, "templates", "single-page"),
    join(skillRoot, "templates", "full-decks"),
    join(skillRoot, "assets", "animations"),
  ];

  const parts = await Promise.all(
    paths.map(async (p) => {
      const s = await stat(p).catch(() => null);
      if (!s) return `${p}:missing`;
      if (!s.isDirectory()) return `${p}:${s.mtimeMs}`;
      // Include sorted file list so adding/removing a file invalidates the hash
      const files = await readdir(p).catch((): string[] => []);
      return `${p}:${s.mtimeMs}:${files.sort().join(",")}`;
    })
  );

  const INDEXER_VERSION = "v3"; // bumped: per-role density multipliers + full-deck calibration
  return createHash("sha256").update(parts.join("|") + "|" + INDEXER_VERSION).digest("hex").slice(0, 16);
}

function cacheDir(): string {
  return join(findWorkspaceRoot(), ".local-runtime", "skill-manifests");
}

export function findWorkspaceRoot(): string {
  let current = resolve(process.cwd());
  for (let depth = 0; depth < 6; depth++) {
    if (existsSync(join(current, ".agents", "skills", "html-ppt", "assets"))) {
      return current;
    }
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return resolve(process.cwd());
}

async function readCache(hash: string): Promise<SkillAssetManifest | null> {
  const file = join(cacheDir(), `${hash}.json`);
  if (!existsSync(file)) return null;
  const raw = await readFile(file, "utf8").catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SkillAssetManifest;
  } catch {
    return null;
  }
}

async function writeCache(hash: string, manifest: SkillAssetManifest): Promise<void> {
  const dir = cacheDir();
  await mkdir(dir, { recursive: true }).catch(() => undefined);
  await writeFile(join(dir, `${hash}.json`), JSON.stringify(manifest), "utf8").catch(() => undefined);
}

// ── Themes ────────────────────────────────────────────────────────────────────

async function indexThemes(skillRoot: string): Promise<ThemeAsset[]> {
  const themesDir = join(skillRoot, "assets", "themes");
  const files = await readdir(themesDir).catch((): string[] => []);
  return Promise.all(
    files
      .filter((f) => f.endsWith(".css"))
      .sort()
      .map(async (file) => {
        const id = basename(file, ".css");
        const css = await readFile(join(themesDir, file), "utf8").catch(() => "");
        const palette = parseThemePalette(css);
        return {
          id,
          palette,
          mood: THEME_MOOD[id] ?? id,
          tags: deriveThemeTags(id, palette),
        };
      })
  );
}

function parseThemePalette(css: string): ThemePalette {
  const vars = extractCssVars(css);
  const bg = vars["--bg"] ?? "#ffffff";
  return {
    bg,
    surface: vars["--surface"] ?? "#ffffff",
    border: vars["--border"] ?? "rgba(0,0,0,.08)",
    text1: vars["--text-1"] ?? "#111216",
    text2: vars["--text-2"] ?? "#55596a",
    accent: vars["--accent"] ?? "#3b6cff",
    accent2: vars["--accent-2"] ?? "",
    accent3: vars["--accent-3"] ?? "",
    good: vars["--good"] ?? "#1aaf6c",
    warn: vars["--warn"] ?? "#c98500",
    bad: vars["--bad"] ?? "#c13a3a",
    radius: vars["--radius"] ?? "14px",
    isDark: isPerceivedDark(bg),
  };
}

function extractCssVars(css: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of css.matchAll(/(--[\w-]+)\s*:\s*([^;}\n]+)/g)) {
    const key = match[1];
    const value = match[2];
    if (key && value) result[key] = value.trim();
  }
  return result;
}

function isPerceivedDark(color: string): boolean {
  const hex = color.replace(/^#/, "");
  if (hex.length !== 3 && hex.length !== 6) return false;
  const full = hex.length === 3 ? hex.split("").map((c) => c + c).join("") : hex;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}

function deriveThemeTags(id: string, palette: ThemePalette): string[] {
  const tags: string[] = [palette.isDark ? "dark" : "light"];
  if (id.includes("minimal") || id.includes("clean") || id.includes("editorial") || id.includes("white")) tags.push("minimal");
  if (id.includes("neon") || id.includes("cyber") || id.includes("terminal") || id.includes("matrix")) tags.push("dramatic", "technical");
  if (id.includes("pastel") || id.includes("soft") || id.includes("rose") || id.includes("sunset") || id.includes("warm")) tags.push("warm", "friendly");
  if (id.includes("mono") || id.includes("blueprint") || id.includes("engineering") || id.includes("whiteprint")) tags.push("technical", "minimal");
  if (id.includes("vaporwave") || id.includes("y2k") || id.includes("memphis") || id.includes("retro")) tags.push("retro", "playful");
  if (id.includes("pitch") || id.includes("corporate") || id.includes("academic") || id.includes("news")) tags.push("professional");
  if (id.includes("japanese") || id.includes("xiaohongshu")) tags.push("elegant");
  if (id.includes("rainbow") || id.includes("aurora") || id.includes("gradient")) tags.push("colorful");
  return Array.from(new Set(tags));
}

// ── Layouts ───────────────────────────────────────────────────────────────────

async function indexLayouts(skillRoot: string): Promise<LayoutAsset[]> {
  const layoutsDir = join(skillRoot, "templates", "single-page");
  const files = await readdir(layoutsDir).catch((): string[] => []);
  return Promise.all(
    files
      .filter((f) => f.endsWith(".html"))
      .sort()
      .map(async (file) => {
        const id = basename(file, ".html");
        const html = await readFile(join(layoutsDir, file), "utf8").catch(() => "");
        return indexLayout(id, html);
      })
  );
}

function indexLayout(id: string, html: string): LayoutAsset {
  const section = html.match(/<section\b[\s\S]*?<\/section>/i)?.[0] ?? html;
  const role = LAYOUT_ROLES[id] ?? "content";
  const canvasRequired = /<canvas\b/i.test(section);
  return {
    id,
    role,
    slots: extractSlots(section, canvasRequired),
    densityBudget: deriveDensityBudget(id, section, role),
    canvasRequired,
    tags: deriveLayoutTags(id, role, canvasRequired),
  };
}

function extractSlots(html: string, hasCanvas: boolean): string[] {
  const found = new Set<string>();
  for (const cls of KNOWN_SLOTS) {
    // Match class="... <cls> ..." or class="<cls>"
    if (new RegExp(`class="[^"]*\\b${cls}\\b`).test(html)) found.add(cls);
  }
  if (hasCanvas) found.add("canvas");
  return Array.from(found);
}

/**
 * Per-role density multipliers applied on top of each layout's measured
 * template content. Body / content / divider layouts get more headroom
 * because real-world decks (academic, editorial, dense product slides)
 * legitimately push past the demo template's content. Cover / closer / chart
 * stay tight because their visual contract is "minimal text."
 */
const ROLE_BODY_MULTIPLIER: Record<LayoutRole, number> = {
  cover: 1.0,
  closer: 1.0,
  divider: 1.2,
  chart: 1.0,
  image: 1.0,
  content: 2.0
};

const ROLE_FLOOR_BODY_CHARS: Record<LayoutRole, number> = {
  cover: 160,
  closer: 160,
  divider: 240,
  chart: 200,
  image: 200,
  content: 360
};

function deriveDensityBudget(id: string, sectionHtml: string, role: LayoutRole): LayoutDensityBudget {
  const visibleText = extractVisibleText(sectionHtml);
  const cardCount = (sectionHtml.match(/class="[^"]*\bcard\b[^"]*"/g) ?? []).length;
  const liCount = (sectionHtml.match(/<li\b/gi) ?? []).length;

  const titleRaw = (sectionHtml.match(/<(?:h1|h2)[^>]*>([\s\S]*?)<\/(?:h1|h2)>/i)?.[1] ?? "").replace(/<[^>]+>/g, "").trim();
  const maxTitleChars = Math.max(60, titleRaw.length * 2);

  // Chart/image slides carry almost no body text — canvas or image is the content
  if (role === "chart" || role === "image") {
    return { maxTitleChars, maxBodyCharsTotal: 200, maxItems: Math.max(1, cardCount, liCount), maxCardCount: cardCount };
  }

  const multiplier = ROLE_BODY_MULTIPLIER[role] ?? 1.5;
  const floor = ROLE_FLOOR_BODY_CHARS[role] ?? 200;
  return {
    maxTitleChars,
    maxBodyCharsTotal: Math.max(floor, Math.round(visibleText.length * multiplier)),
    maxItems: Math.max(4, cardCount, liCount),
    maxCardCount: cardCount,
  };
}

/**
 * Calibrate per-layout density budgets against the actual full-deck templates
 * the skill ships. The full-decks are the highest-fidelity ground truth for
 * publishable density; if their typical body section runs 600 visible chars,
 * a content layout's 200-char ceiling is too tight regardless of how sparse
 * the demo single-page template happens to be.
 *
 * Strategy:
 *   1. Walk every full-deck section that exists.
 *   2. Compute visible-text char count per section, then take the median and
 *      P90 across all "body" sections (sections that are not the deck's first
 *      or last slide and not pure-canvas).
 *   3. For content layouts, raise `maxBodyCharsTotal` to at least the median
 *      and cap it at the P90 so a single dense outlier cannot blow up the
 *      ceiling for every layout.
 *   4. Cover / divider / closer / chart / image layouts keep their existing
 *      role-derived budgets (calibration is body-density-specific).
 */
function calibrateLayoutBudgetsAgainstFullDecks(
  layouts: LayoutAsset[],
  fullDecks: FullDeckAsset[]
): LayoutAsset[] {
  const bodyCharLengths: number[] = [];
  for (const deck of fullDecks) {
    const slides = deck.previewSlides ?? [];
    if (slides.length === 0) continue;
    // Drop the first and last preview slide to avoid cover/closer skewing the
    // body density downward.
    const candidates = slides.length >= 3 ? slides.slice(1, -1) : slides;
    for (const section of candidates) {
      if (/<canvas\b/i.test(section)) continue;
      const visibleLength = extractVisibleText(section).length;
      if (visibleLength >= 80) bodyCharLengths.push(visibleLength);
    }
  }

  if (bodyCharLengths.length === 0) return layouts;

  bodyCharLengths.sort((a, b) => a - b);
  const median = bodyCharLengths[Math.floor(bodyCharLengths.length / 2)] ?? 0;
  const p90Index = Math.min(bodyCharLengths.length - 1, Math.floor(bodyCharLengths.length * 0.9));
  const p90 = bodyCharLengths[p90Index] ?? median;
  if (median <= 0) return layouts;

  return layouts.map((layout) => {
    if (layout.role !== "content") return layout;
    const current = layout.densityBudget.maxBodyCharsTotal;
    const calibrated = Math.min(p90, Math.max(current, median));
    if (calibrated <= current) return layout;
    return {
      ...layout,
      densityBudget: {
        ...layout.densityBudget,
        maxBodyCharsTotal: calibrated
      }
    };
  });
}

function extractVisibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function deriveLayoutTags(id: string, role: LayoutRole, canvasRequired: boolean): string[] {
  const tags: string[] = [role];
  if (canvasRequired) tags.push("chart", "data");
  if (id.includes("timeline") || id.includes("gantt") || id.includes("roadmap")) tags.push("planning", "time");
  if (id.includes("kpi") || id.includes("stat")) tags.push("data", "metrics");
  if (id.includes("code") || id.includes("terminal") || id.includes("diff")) tags.push("technical", "code");
  if (id.includes("flow") || id.includes("arch") || id.includes("mindmap") || id.includes("process")) tags.push("diagram");
  if (id.includes("comparison") || id.includes("pros-cons")) tags.push("analysis");
  if (id.includes("two-column") || id.includes("three-column")) tags.push("multi-column");
  if (id.includes("big-quote")) tags.push("narrative");
  if (id.includes("image")) tags.push("visual", "media");
  return Array.from(new Set(tags));
}

// ── Full decks ────────────────────────────────────────────────────────────────

async function indexFullDecks(skillRoot: string): Promise<FullDeckAsset[]> {
  const decksDir = join(skillRoot, "templates", "full-decks");
  const entries = await readdir(decksDir, { withFileTypes: true }).catch(() => [] as import("node:fs").Dirent[]);
  return Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => indexFullDeck(join(decksDir, e.name), e.name))
  );
}

async function indexFullDeck(dir: string, id: string): Promise<FullDeckAsset> {
  const [indexHtml, styleCss] = await Promise.all([
    readFile(join(dir, "index.html"), "utf8").catch(() => ""),
    readFile(join(dir, "style.css"), "utf8").catch(() => ""),
  ]);

  const slideCount = (indexHtml.match(/<section\b[^>]*class="[^"]*\bslide\b/g) ?? []).length;

  // Extract first 5 slides
  const previewSlides: string[] = [];
  const slideRegex = /<section\b[\s\S]*?<\/section>/gi;
  let match: RegExpExecArray | null;
  while ((match = slideRegex.exec(indexHtml)) !== null && previewSlides.length < 5) {
    previewSlides.push(match[0]);
  }

  // Pull the first extra class on the .deck div that starts with "tpl-"
  const deckDivAttrs = indexHtml.match(/<div[^>]+class="([^"]*deck[^"]*)"[^>]*>/)?.[1] ?? "";
  const deckClass = deckDivAttrs.split(/\s+/).find((c) => c.startsWith("tpl-")) ?? `tpl-${id}`;

  // Collect all theme references from data-theme / data-themes / theme CSS links
  const themeMatches = [
    ...Array.from(indexHtml.matchAll(/data-themes?="([^"]+)"/g)),
    ...Array.from(indexHtml.matchAll(/themes\/([a-z0-9_-]+)\.css/g)),
  ];
  const themesReferenced = Array.from(
    new Set(
      themeMatches
        .flatMap((m) => (m[1] ?? "").split(",").map((t) => t.trim()))
        .filter(Boolean)
    )
  );

  // Collect animation class names used in the deck
  const animRaw = [...(indexHtml.match(/(?:class|data-anim)="[^"]*\banim-[\w-]+\b/g) ?? [])];
  const animationsUsed = Array.from(
    new Set(
      animRaw
        .flatMap((s) => Array.from(s.matchAll(/\banim-([\w-]+)/g)).map((m) => m[1] ?? ""))
        .filter(Boolean)
    )
  );

  return {
    id,
    slideCount,
    deckClass,
    themesReferenced,
    animationsUsed,
    indexSnippet: indexHtml.slice(0, 2000),
    styleSnippet: styleCss.slice(0, 2000),
    previewSlides,
    previewCss: styleCss,
    tags: inferFullDeckTags(id),
  };
}

function inferFullDeckTags(id: string): string[] {
  const tags: string[] = [];
  if (id.includes("pitch") || id.includes("investor") || id.includes("vc")) tags.push("pitch", "business");
  if (id.includes("product") || id.includes("launch")) tags.push("product", "marketing");
  if (id.includes("tech") || id.includes("hermes") || id.includes("cyber") || id.includes("graphify")) tags.push("technical");
  if (id.includes("knowledge") || id.includes("course")) tags.push("educational");
  if (id.includes("weekly") || id.includes("report")) tags.push("report", "business");
  if (id.includes("xhs") || id.includes("pastel") || id.includes("editorial")) tags.push("lifestyle", "visual");
  if (id.includes("dark") || id.includes("obsidian") || id.includes("night") || id.includes("neon")) tags.push("dark");
  if (id.includes("minimal") || id.includes("nav") || id.includes("dir")) tags.push("minimal");
  if (id.includes("presenter") || id.includes("reveal")) tags.push("presenter");
  if (id.includes("blueprint") || id.includes("arch") || id.includes("terminal") || id.includes("hermes")) tags.push("technical");
  return Array.from(new Set(tags));
}

// ── Animations & FX ──────────────────────────────────────────────────────────

async function indexAnimations(
  skillRoot: string
): Promise<{ animations: AnimationAsset[]; fxEffects: FxEffectAsset[] }> {
  const animDir = join(skillRoot, "assets", "animations");
  const [animCss, fxFiles] = await Promise.all([
    readFile(join(animDir, "animations.css"), "utf8").catch(() => ""),
    readdir(join(animDir, "fx")).catch((): string[] => []),
  ]);

  return {
    animations: parseAnimationClasses(animCss),
    fxEffects: fxFiles
      .filter((f) => f.endsWith(".js") && !f.startsWith("_"))
      .sort()
      .map((f) => {
        const id = basename(f, ".js");
        return { id, kind: "canvas" as const, perfClass: HEAVY_FX_IDS.has(id) ? "heavy" : "medium" };
      }),
  };
}

function parseAnimationClasses(css: string): AnimationAsset[] {
  const seen = new Set<string>();
  const result: AnimationAsset[] = [];

  for (const match of css.matchAll(/\.anim-([\w-]+)\s*[{,]/g)) {
    const id = match[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      cssClass: `anim-${id}`,
      kind: classifyAnimKind(id, css),
      perfClass: classifyAnimPerf(id),
    });
  }

  return result;
}

function classifyAnimKind(id: string, css: string): "enter" | "loop" | "fx" {
  if (LOOP_ANIM_IDS.has(id)) return "loop";
  if (id === "stagger-list" || id === "counter-up") return "fx";
  // Check whether the class body uses `infinite` iteration
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(`\\.anim-${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
  return block.includes("infinite") ? "loop" : "enter";
}

function classifyAnimPerf(id: string): "cheap" | "medium" | "heavy" {
  if (HEAVY_ANIM_IDS.has(id)) return "heavy";
  if (LOOP_ANIM_IDS.has(id)) return "medium";
  if (id.includes("blur") || id.includes("glitch") || id.includes("filter")) return "heavy";
  if (id.includes("3d") || id.includes("perspective") || id.includes("cube") || id.includes("flip") || id.includes("page-turn")) return "heavy";
  return "cheap";
}
