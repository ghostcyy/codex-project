import { createReadStream, existsSync } from "node:fs";
import { access, cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, normalize, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { Injectable, NotFoundException, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type {
  PptDeckBlock,
  PptDeckCreativeSlideStyle,
  PptDeckLayout,
  PptDeckSlide,
  PptDeckSpec
} from "../ppt-chat/ppt-chat.types";
import type { HtmlPptRenderResult, HtmlPptStaticDeckInput } from "./html-ppt-renderer.types";

const WORKSPACE_ROOT = findWorkspaceRoot(process.cwd());
const DECK_OUTPUT_ROOT = resolve(WORKSPACE_ROOT, ".local-runtime", "html-ppt-decks");
const SKILL_ROOT = resolve(WORKSPACE_ROOT, ".agents", "skills", "html-ppt");
const DEFAULT_THEMES = [
  "retro-tv",
  "academic-paper",
  "corporate-clean",
  "tokyo-night",
  "blueprint",
  "pitch-deck-vc"
];
const THEME_CATALOG: Record<string, string> = {
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
  "engineering-whiteprint": "工程白图，适合 API 和系统文档。"
};
const PAGE_STYLE_CATALOG: Record<string, string> = {
  "cover": "封面，kicker、大标题、导语和 pill row。",
  "toc": "目录网格，2x3 编号卡片。",
  "section-divider": "章节分隔页，大编号和主题过渡。",
  "bullets": "卡片化要点列表。",
  "two-column": "左右双栏概念与例子。",
  "three-column": "三栏支柱式信息。",
  "big-quote": "大引语页。",
  "stat-highlight": "单个超大数字重点页。",
  "kpi-grid": "多指标 KPI 网格。",
  "table": "表格数据页。",
  "chart-bar": "柱状图页。",
  "chart-line": "折线图页。",
  "chart-pie": "环形图页。",
  "chart-radar": "雷达对比页。",
  "code": "代码展示页。",
  "diff": "代码差异页。",
  "terminal": "终端窗口页。",
  "flow-diagram": "流程图页。",
  "arch-diagram": "三层架构图页。",
  "process-steps": "流程步骤卡片页。",
  "mindmap": "径向脑图页。",
  "timeline": "横向时间轴页。",
  "roadmap": "路线图页。",
  "gantt": "甘特图页。",
  "comparison": "前后或左右对比页。",
  "pros-cons": "优缺点双卡页。",
  "todo-checklist": "清单页。",
  "image-hero": "全幅图片英雄页。",
  "image-grid": "图片 bento 网格页。",
  "cta": "行动号召页。",
  "thanks": "感谢页。"
};
const CSS_ANIMATION_CATALOG: Record<string, string> = {
  "fade-up": "默认上浮淡入。",
  "fade-down": "下落淡入。",
  "fade-left": "从左侧进入。",
  "fade-right": "从右侧进入。",
  "rise-in": "标题级上升清晰化。",
  "drop-in": "横幅下落进入。",
  "zoom-pop": "按钮或数字弹出。",
  "blur-in": "模糊到清晰。",
  "glitch-in": "故障风进入。",
  typewriter: "打字机文本。",
  "neon-glow": "霓虹发光。",
  "shimmer-sweep": "高光扫过。",
  "gradient-flow": "渐变流动。",
  "stagger-list": "子元素依次出现。",
  "counter-up": "数字递增。",
  "path-draw": "路径绘制。",
  "morph-shape": "形状变形。",
  "parallax-tilt": "3D 视差倾斜。",
  "card-flip-3d": "卡片 3D 翻转。",
  "cube-rotate-3d": "立方体旋入。",
  "page-turn-3d": "翻页进入。",
  "perspective-zoom": "透视推进。",
  "marquee-scroll": "横向滚动。",
  kenburns: "图片慢推拉。",
  "confetti-burst": "彩带爆发。",
  spotlight: "聚光揭示。",
  "ripple-reveal": "涟漪揭示。"
};
const FX_CATALOG: Record<string, string> = {
  "particle-burst": "粒子爆发。",
  "confetti-cannon": "彩纸礼炮。",
  firework: "烟花。",
  starfield: "3D 星空。",
  "matrix-rain": "矩阵雨。",
  "knowledge-graph": "知识图谱力导向。",
  "neural-net": "神经网络脉冲。",
  constellation: "星座连线。",
  "orbit-ring": "轨道环。",
  "galaxy-swirl": "星系旋涡。",
  "word-cascade": "词语瀑布。",
  "letter-explode": "字母爆炸。",
  "chain-react": "链式反应。",
  "magnetic-field": "磁场轨迹。",
  "data-stream": "数据流。",
  "gradient-blob": "渐变光斑。",
  "sparkle-trail": "闪光轨迹。",
  shockwave: "冲击波。",
  "typewriter-multi": "多行打字机。",
  "counter-explosion": "数字爆炸。"
};
const DECK_STYLE_CATALOG: Record<string, string> = {
  editorial: "大标题、衬线气质和杂志留白。",
  product: "产品发布会，光斑、玻璃卡和重点 CTA。",
  technical: "工程技术，网格、终端感和结构图。",
  investor: "融资路演，强指标和极简大留白。",
  broadcast: "资讯播报，标题条和硬朗信息密度。",
  cinematic: "电影感叙事，深背景和大视觉层。",
  playful: "年轻活泼，几何形和高饱和点缀。"
};
const COMPONENT_STYLE_CATALOG: Record<string, string> = {
  "glass-panels": "半透明毛玻璃卡片。",
  "ink-outline": "细线框和纸面感。",
  "hard-shadow": "粗描边硬阴影。",
  "soft-depth": "柔和阴影层级。",
  "neon-edge": "霓虹边缘和发光。",
  "blueprint-lines": "工程线框和坐标感。",
  "magazine-cuts": "杂志切片和强标题。",
  "terminal-blocks": "终端块和等宽标签。"
};
const TEXTURE_CATALOG: Record<string, string> = {
  none: "不额外添加纹理。",
  "blueprint-grid": "蓝图网格。",
  "paper-grain": "纸张颗粒。",
  "scanlines": "CRT 扫描线。",
  "dot-matrix": "点阵。",
  "aurora-haze": "极光雾化。",
  "diagonal-rules": "斜向线条。",
  "radial-burst": "径向爆发。"
};
const SHAPE_CATALOG: Record<string, string> = {
  none: "不添加额外形状。",
  "orbit-rings": "轨道环形。",
  "floating-blobs": "漂浮渐变团。",
  "corner-frames": "四角框线。",
  "diagonal-panels": "斜切面板。",
  "data-nodes": "数据节点。",
  "bauhaus-circles": "包豪斯圆形。",
  "ribbon-lines": "丝带线条。",
  "signal-waves": "信号波纹。"
};
const COMPOSITION_PRESET_CATALOG: Record<string, string> = {
  "hero-split-diagonal": "封面/章节强视觉：左侧大标题，右侧主视觉，斜切装饰面板，适合开场和观点页。",
  "editorial-poster-stack": "杂志海报堆叠：标题居中偏上，卡片纵向压叠，适合叙事、观点和结尾页。",
  "bento-dashboard": "Bento 仪表盘：标题顶部，卡片 2-4 栏混排，指标和模块信息密度高。",
  "timeline-map": "时间地图：标题左上，时间轴横向展开，节点错落，适合历史、路线和阶段演进。",
  "comparison-arena": "对比竞技场：标题居中，左右卡片强对峙，中间视觉焦点，适合方案比较。",
  "radial-orbit": "径向轨道：标题靠左，内容围绕轨道和圆形主视觉分布，适合生态、系统和关系网络。",
  "blueprint-lab": "蓝图实验室：标题左上，网格背景，线框卡片，适合工程、架构和流程拆解。",
  "cinematic-spotlight": "电影聚光：标题大幅居中，强暗角和光束，卡片少而大，适合概念和结论页。",
  "magazine-collage": "杂志拼贴：标题大字号错位，卡片和标签不规则组合，适合趋势、人物和专题页。",
  "data-command-center": "数据指挥中心：标题顶部紧凑，指标卡优先，四宫格/多宫格高密度。",
  "process-river": "流程河流：标题左上，步骤沿曲线/横向流动，适合流程、方法和执行路径。",
  "minimal-focus": "极简聚焦：大留白，单列内容，弱装饰，适合严肃总结和解释页。"
};
const CRC32_TABLE = createCrc32Table();

function findWorkspaceRoot(start: string) {
  let current = resolve(start);

  for (let depth = 0; depth < 6; depth++) {
    const marker = resolve(current, ".agents", "skills", "html-ppt", "assets");
    if (existsSync(marker)) {
      return current;
    }

    const parent = resolve(current, "..");
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return resolve(start);
}

@Injectable()
export class HtmlPptRendererService implements OnModuleInit, OnModuleDestroy {
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly retentionHours = this.parsePositiveNumber(process.env.HTML_PPT_OUTPUT_RETENTION_HOURS, 168);
  private readonly cleanupIntervalMinutes = this.parsePositiveNumber(process.env.HTML_PPT_CLEANUP_INTERVAL_MINUTES, 60);

  onModuleInit() {
    void mkdir(DECK_OUTPUT_ROOT, { recursive: true });
    void this.cleanupExpiredDecks();

    if (this.cleanupIntervalMinutes > 0) {
      this.cleanupTimer = setInterval(() => void this.cleanupExpiredDecks(), this.cleanupIntervalMinutes * 60 * 1000);
      this.cleanupTimer.unref?.();
    }
  }

  onModuleDestroy() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  getCreativeStyleCatalog() {
    return {
      themes: THEME_CATALOG,
      pageStyles: PAGE_STYLE_CATALOG,
      deckStyles: DECK_STYLE_CATALOG,
      componentStyles: COMPONENT_STYLE_CATALOG,
      compositionPresets: COMPOSITION_PRESET_CATALOG,
      textures: TEXTURE_CATALOG,
      shapes: SHAPE_CATALOG,
      animations: CSS_ANIMATION_CATALOG,
      effects: FX_CATALOG
    };
  }

  async renderDeck(deckSpec: PptDeckSpec): Promise<HtmlPptRenderResult> {
    const deckId = randomUUID();
    const createdAt = new Date();
    const outputDir = join(DECK_OUTPUT_ROOT, deckId);
    const assetsSource = join(SKILL_ROOT, "assets");
    const assetsTarget = join(outputDir, "assets");

    await mkdir(outputDir, { recursive: true });
    await cp(assetsSource, assetsTarget, { recursive: true });

    const style = this.renderStyle(deckSpec);
    const index = this.renderIndex(deckSpec, "export");
    const preview = this.renderIndex(deckSpec, "preview");
    const standalone = await this.renderStandalone(deckSpec, style);
    const manifest = {
      deckId,
      title: deckSpec.title,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.retentionHours * 60 * 60 * 1000).toISOString(),
      exportFormat: "html-ppt-directory-zip"
    };

    await writeFile(join(outputDir, "style.css"), style, "utf8");
    await writeFile(join(outputDir, "index.html"), index, "utf8");
    await writeFile(join(outputDir, "preview.html"), preview, "utf8");
    await writeFile(join(outputDir, "standalone.html"), standalone, "utf8");
    await writeFile(join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    await this.createExportZip(outputDir, join(outputDir, "html-ppt-deck.zip"));

    return {
      deckId,
      title: deckSpec.title,
      previewUrl: `/api/ppt/decks/${deckId}/preview.html`,
      downloadUrl: `/api/ppt/decks/${deckId}/download.zip`,
      outputDir,
      createdAt: createdAt.toISOString()
    };
  }

  async publishStaticDeck(input: HtmlPptStaticDeckInput): Promise<HtmlPptRenderResult> {
    const deckId = randomUUID();
    const createdAt = new Date();
    const outputDir = join(DECK_OUTPUT_ROOT, deckId);
    const skillRoot = input.skillRoot ? resolve(input.skillRoot) : SKILL_ROOT;
    const assetsSource = join(skillRoot, "assets");
    const assetsTarget = join(outputDir, "assets");

    await mkdir(outputDir, { recursive: true });
    await cp(assetsSource, assetsTarget, { recursive: true });

    const index = this.sanitizeStaticDeckHtml(await this.inlinePortableThemes(input.indexHtml, outputDir));
    const preview = this.toPreviewHtml(index);
    const manifest = {
      deckId,
      title: input.title,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.retentionHours * 60 * 60 * 1000).toISOString(),
      exportFormat: "html-ppt-agent-directory-zip",
      ...(input.manifest ?? {})
    };

    await writeFile(join(outputDir, "style.css"), this.sanitizeStaticDeckCss(input.styleCss), "utf8");
    await writeFile(join(outputDir, "index.html"), index, "utf8");
    await writeFile(join(outputDir, "preview.html"), preview, "utf8");
    await writeFile(join(outputDir, "standalone.html"), index, "utf8");
    await writeFile(join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    await this.createExportZip(outputDir, join(outputDir, "html-ppt-deck.zip"));

    return {
      deckId,
      title: input.title,
      previewUrl: `/api/ppt/decks/${deckId}/preview.html`,
      downloadUrl: `/api/ppt/decks/${deckId}/download.zip`,
      outputDir,
      createdAt: createdAt.toISOString()
    };
  }

  getIndexStream(deckId: string) {
    return this.getDeckFileStream(deckId, "index.html");
  }

  getPreviewStream(deckId: string) {
    return this.getDeckFileStream(deckId, "preview.html");
  }

  getStandaloneStream(deckId: string) {
    return this.getDeckFileStream(deckId, "standalone.html");
  }

  getZipStream(deckId: string) {
    return this.getDeckFileStream(deckId, "html-ppt-deck.zip");
  }

  getAssetStream(deckId: string, assetPath: string) {
    const outputDir = this.getDeckDirectory(deckId);
    const assetsDir = join(outputDir, "assets");
    const fullPath = this.resolveInside(assetsDir, assetPath);
    return {
      stream: createReadStream(fullPath),
      contentType: this.contentTypeFor(fullPath),
      fileName: basename(fullPath)
    };
  }

  getStyleStream(deckId: string) {
    return this.getDeckFileStream(deckId, "style.css");
  }

  private getDeckFileStream(
    deckId: string,
    fileName: "index.html" | "preview.html" | "standalone.html" | "style.css" | "html-ppt-deck.zip"
  ) {
    const outputDir = this.getDeckDirectory(deckId);
    const fullPath = join(outputDir, fileName);
    return {
      stream: createReadStream(fullPath),
      contentType: this.contentTypeFor(fullPath),
      fileName
    };
  }

  private getDeckDirectory(deckId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(deckId)) {
      throw new NotFoundException("HTML-PPT deck 不存在。");
    }

    return join(DECK_OUTPUT_ROOT, deckId);
  }

  private resolveInside(root: string, inputPath: string) {
    const normalizedInput = normalize(inputPath).replace(/^(\.\.[/\\])+/, "");
    const resolved = resolve(root, normalizedInput);
    const resolvedRoot = resolve(root);

    if (!resolved.startsWith(resolvedRoot)) {
      throw new NotFoundException("HTML-PPT asset 不存在。");
    }

    return resolved;
  }

  private contentTypeFor(filePath: string) {
    const extension = extname(filePath).toLowerCase();
    const mapping: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "application/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".zip": "application/zip",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".woff": "font/woff",
      ".woff2": "font/woff2"
    };

    return mapping[extension] ?? "application/octet-stream";
  }

  private renderIndex(deckSpec: PptDeckSpec, mode: "preview" | "export") {
    const themes = this.themeList(deckSpec);
    const slides = deckSpec.slides.map((slide, index) => this.renderSlide(deckSpec, slide, index, deckSpec.slides.length)).join("\n\n");
    const asset = (path: string) => mode === "export" ? `./assets/${path}` : `./asset?path=${encodeURIComponent(path)}`;
    const themeBase = mode === "export" ? "./assets/themes/" : "./asset?path=themes/";
    const includeFxRuntime = this.shouldIncludeFxRuntime(deckSpec);

    return [
      "<!DOCTYPE html>",
      `<html lang="${this.escapeAttr(deckSpec.language || "zh-CN")}" data-themes="${this.escapeAttr(themes.join(","))}" data-theme="${this.escapeAttr(deckSpec.theme)}">`,
      "<head>",
      "<meta charset=\"utf-8\">",
      "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
      `<title>${this.escapeHtml(deckSpec.title)}</title>`,
      "<link rel=\"icon\" href=\"data:,\">",
      `<link rel="stylesheet" href="${this.escapeAttr(asset("fonts.css"))}">`,
      `<link rel="stylesheet" href="${this.escapeAttr(asset("base.css"))}">`,
      `<link rel="stylesheet" id="theme-link" href="${this.escapeAttr(asset(`themes/${deckSpec.theme}.css`))}">`,
      `<link rel="stylesheet" href="${this.escapeAttr(asset("animations/animations.css"))}">`,
      "<link rel=\"stylesheet\" href=\"./style.css\">",
      "</head>",
      `<body class="${this.escapeAttr([this.templateClass(deckSpec.template), this.deckCreativeClass(deckSpec)].filter(Boolean).join(" "))}" data-theme-base="${this.escapeAttr(themeBase)}">`,
      "<div class=\"deck\">",
      slides,
      "</div>",
      `<script src="${this.escapeAttr(asset("runtime.js"))}"></script>`,
      `<script src="${this.escapeAttr(asset("edit-mode.js"))}"></script>`,
      includeFxRuntime ? `<script src="${this.escapeAttr(asset("animations/fx-runtime.js"))}"></script>` : "",
      "</body>",
      "</html>"
    ].filter((line) => line !== "").join("\n");
  }

  private async renderStandalone(deckSpec: PptDeckSpec, style: string) {
    const baseCss = await this.readSkillAsset("base.css");
    const fontsCss = await this.readSkillAsset("fonts.css");
    const animationsCss = await this.readSkillAsset(join("animations", "animations.css"));
    const themeCss = await this.readSkillAsset(join("themes", `${deckSpec.theme}.css`)).catch(() => "");
    const runtimeJs = await this.readSkillAsset("runtime.js");
    const editModeJs = await this.readSkillAsset("edit-mode.js");
    const includeFxRuntime = this.shouldIncludeFxRuntime(deckSpec);
    const fxRuntimeJs = includeFxRuntime
      ? await this.readSkillAsset(join("animations", "fx-runtime.js")).catch(() => "")
      : "";
    const themes = this.themeList(deckSpec);
    const slides = deckSpec.slides.map((slide, index) => this.renderSlide(deckSpec, slide, index, deckSpec.slides.length)).join("\n\n");

    return [
      "<!DOCTYPE html>",
      `<html lang="${this.escapeAttr(deckSpec.language || "zh-CN")}" data-themes="${this.escapeAttr(themes.join(","))}" data-theme="${this.escapeAttr(deckSpec.theme)}">`,
      "<head>",
      "<meta charset=\"utf-8\">",
      "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
      `<title>${this.escapeHtml(deckSpec.title)}</title>`,
      "<style>",
      fontsCss,
      baseCss,
      animationsCss,
      themeCss,
      style,
      "</style>",
      "</head>",
      `<body class="${this.escapeAttr([this.templateClass(deckSpec.template), this.deckCreativeClass(deckSpec)].filter(Boolean).join(" "))}">`,
      "<div class=\"deck\">",
      slides,
      "</div>",
      "<script>",
      runtimeJs,
      "</script>",
      "<script>",
      editModeJs,
      "</script>",
      includeFxRuntime && fxRuntimeJs
        ? ["<script>", fxRuntimeJs, "</script>"].join("\n")
        : "",
      "</body>",
      "</html>"
    ].filter((line) => line !== "").join("\n");
  }

  private async readSkillAsset(assetPath: string) {
    const fullPath = this.resolveInside(join(SKILL_ROOT, "assets"), assetPath);
    await access(fullPath);
    return readFile(fullPath, "utf8");
  }

  private async inlinePortableThemes(indexHtml: string, outputDir: string) {
    const themesDir = join(outputDir, "assets", "themes");
    const themeFiles = await readdir(themesDir).catch(() => []);
    const themeNames = themeFiles
      .filter((file) => file.toLowerCase().endsWith(".css"))
      .map((file) => basename(file, ".css"))
      .sort();
    const activeTheme = this.extractHtmlAttr(indexHtml, "data-theme") ?? themeNames[0] ?? "minimal-white";
    const orderedThemes = Array.from(new Set([activeTheme, ...themeNames]));
    const registryParts = await Promise.all(orderedThemes.map(async (theme) => {
      const cssPath = join(themesDir, `${theme}.css`);
      const raw = await readFile(cssPath, "utf8").catch(() => "");
      if (!raw.trim()) return "";

      // Scope each theme so themes don't collide in the cascade.
      // Bare :root{} and body{} blocks all have the same specificity and source-
      // order wins, meaning the last inlined theme's variables override all others.
      // By replacing :root with html[data-theme="name"] and body{} with
      // html[data-theme="name"] body{}, runtime.js's data-theme attribute
      // switching correctly activates the right theme at any time.
      const scoped = raw.trim()
        // :root { ... } → html[data-theme="name"] { ... }
        .replace(/^(\s*):root(\s*\{)/gm, `$1html[data-theme="${theme}"]$2`)
        // bare `body { ... }` → html[data-theme="name"] body { ... }
        .replace(/^(\s*)body(\s*\{)/gm, `$1html[data-theme="${theme}"] body$2`)
        // class selectors like `.card { ... }` → `html[data-theme="name"] .card { ... }`
        .replace(/^(\s*)(\.[\w-]+(?:,\s*\.[\w-]+)*\s*\{)/gm, `$1html[data-theme="${theme}"] $2`)
        // element+class selectors like `h1.title, ... { ... }` → `html[data-theme="name"] h1.title, ... { ... }`
        .replace(/^(\s*)([a-z][a-z0-9]*\.[^{]+\{)/gm, `$1html[data-theme="${theme}"] $2`);

      return `/* inline theme: ${theme} */\n${scoped}`;
    }));
    const registry = [
      "<style id=\"inline-theme-registry\" data-inline-theme-registry=\"1\">",
      registryParts.filter(Boolean).join("\n\n"),
      "</style>"
    ].join("\n");

    let nextHtml = indexHtml
      .replace(/<link\b[^>]*(?:href|src)=["'][^"']*assets\/themes\/[^"']+["'][^>]*>\s*/gi, "")
      .replace(/\sdata-theme-mode=["'][^"']*["']/i, "");

    if (/<html\b/i.test(nextHtml)) {
      nextHtml = nextHtml.replace(/<html\b([^>]*)>/i, (match, attrs: string) => {
        let nextAttrs = attrs as string;
        if (/\sdata-theme=["'][^"']*["']/i.test(nextAttrs)) {
          nextAttrs = nextAttrs.replace(/\sdata-theme=["'][^"']*["']/i, ` data-theme="${this.escapeAttr(activeTheme)}"`);
        } else {
          nextAttrs += ` data-theme="${this.escapeAttr(activeTheme)}"`;
        }

        if (/\sdata-themes=["'][^"']*["']/i.test(nextAttrs)) {
          nextAttrs = nextAttrs.replace(/\sdata-themes=["'][^"']*["']/i, ` data-themes="${this.escapeAttr(orderedThemes.join(","))}"`);
        } else {
          nextAttrs += ` data-themes="${this.escapeAttr(orderedThemes.join(","))}"`;
        }

        nextAttrs += " data-theme-mode=\"inline\"";
        return `<html${nextAttrs}>`;
      });
    }

    nextHtml = /<\/head>/i.test(nextHtml)
      ? nextHtml.replace(/<\/head>/i, `${registry}\n</head>`)
      : `${registry}\n${nextHtml}`;

    await rm(themesDir, { recursive: true, force: true });
    return nextHtml;
  }

  private toPreviewHtml(indexHtml: string) {
    return indexHtml.replace(/(href|src)=["']\.\/assets\/([^"']+)["']/gi, (_match, attr: string, assetPath: string) => {
      return `${attr}="./asset?path=${encodeURIComponent(assetPath)}"`;
    });
  }

  private sanitizeStaticDeckHtml(html: string) {
    return this.ensureRuntimeProgressBar(
      this.normalizeMetricCountPlaceholders(
        this.normalizeInitialActiveSlide(this.stripUnsafeMetricFx(this.stripNotesBlocks(html)))
      )
    );
  }

  private normalizeMetricCountPlaceholders(html: string) {
    return html.replace(
      /<([a-z0-9-]+)\b([^>]*\sdata-count=(["'])([^"']+)\3[^>]*)>([\s\S]*?)<\/\1>/gi,
      (match, tag: string, attrs: string, _quote: string, rawCount: string, inner: string) => {
        if (!/\bclass=["'][^"']*\bmetric-(?:large|number|sm)\b[^"']*["']/i.test(attrs)) return match;
        if (/<[a-z][^>]*>/i.test(inner)) return match;

        const text = inner.replace(/\s+/g, " ").trim();
        const count = rawCount.trim();
        if (!count) return match;
        if (text && !/^0(?:[.,]0+)?$/.test(text)) return match;
        if (/^0(?:[.,]0+)?$/.test(count)) return match;

        const nextAttrs = attrs.replace(/\sdata-count=(["'])[^"']+\1/i, "");
        return `<${tag}${nextAttrs}>${count}</${tag}>`;
      }
    );
  }

  private sanitizeStaticDeckCss(css: string) {
    return css.replace(/([^{}]+)\{([^{}]*)\}/g, (match, selector: string, body: string) => {
      if (!this.selectorListTargetsSlideSelf(selector)) return match;
      const sanitized = body.replace(/\bposition\s*:\s*(relative|static|fixed)\s*(!important)?\s*;?/gi, "/* position: $1 removed by runtime guard */");
      return `${selector}{${sanitized}}`;
    });
  }

  private selectorListTargetsSlideSelf(selectorList: string) {
    return selectorList
      .split(",")
      .map((selector) => selector.trim())
      .some((selector) => this.selectorTargetsSlideSelf(selector));
  }

  private selectorTargetsSlideSelf(selector: string) {
    const normalized = selector.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    const slideMatch = /\.slide\b/gi;
    let match: RegExpExecArray | null;
    let lastIndex = -1;
    while ((match = slideMatch.exec(normalized))) {
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < 0) return false;

    const afterSlide = normalized.slice(lastIndex).trim();
    if (!afterSlide) return true;
    if (/^(?:::(?:before|after|marker|selection|backdrop|first-line|first-letter)|:(?:before|after|marker|selection|backdrop|first-line|first-letter)\b)/i.test(afterSlide)) {
      return false;
    }

    return /^(?:\.[\w-]+|\[[^\]]+\]|:[\w-]+(?:\([^)]*\))?)*$/.test(afterSlide);
  }

  private stripNotesBlocks(html: string) {
    return html
      .replace(/<(?:div|aside)\b[^>]*class=["'][^"']*\bnotes\b[^"']*["'][^>]*>[\s\S]*?<\/(?:div|aside)>/gi, "")
      .replace(/<!--\s*notes?[\s\S]*?-->/gi, "");
  }

  private stripUnsafeMetricFx(html: string) {
    return html.replace(
      /<([a-z0-9-]+)\b([^>]*class=["'][^"']*\bmetric-(?:large|number|sm)\b[^"']*["'][^>]*)>/gi,
      (_match, tag: string, attrs: string) => {
        const safeAttrs = attrs
          .replace(/\sdata-fx=["'][^"']+["']/gi, "")
          .replace(/\sdata-fx-to=["'][^"']+["']/gi, "");
        return `<${tag}${safeAttrs}>`;
      }
    );
  }

  private normalizeInitialActiveSlide(html: string) {
    let firstSlide = true;
    return html.replace(
      /<section\b([^>]*?)class=(["'])([^"']*\bslide\b[^"']*)\2([^>]*)>/gi,
      (_match, before: string, quote: string, className: string, after: string) => {
        const classes = className
          .split(/\s+/)
          .filter(Boolean)
          .filter((name) => name !== "is-active" && name !== "is-prev" && name !== "is-next");
        if (firstSlide) {
          classes.push("is-active");
          firstSlide = false;
        }

        return `<section${before}class=${quote}${Array.from(new Set(classes)).join(" ")}${quote}${after}>`;
      }
    );
  }

  private ensureRuntimeProgressBar(html: string) {
    const bodyMatch = /<body\b[^>]*>/i.exec(html);
    const deckMatch = /<div\b[^>]*class=(["'])[^"']*\bdeck\b[^"']*\1[^>]*>/i.exec(html);
    if (!bodyMatch || !deckMatch || bodyMatch.index === undefined || deckMatch.index === undefined) {
      return html;
    }

    const bodyEnd = bodyMatch.index + bodyMatch[0].length;
    const bodyPrefix = html.slice(bodyEnd, deckMatch.index);
    if (/^\s*<div\b[^>]*class=(["'])[^"']*\bprogress-bar\b[^"']*\1[^>]*>\s*<span\b[^>]*>\s*<\/span>\s*<\/div>/i.test(bodyPrefix)) {
      return html;
    }

    return `${html.slice(0, bodyEnd)}\n  <div class="progress-bar"><span></span></div>${html.slice(bodyEnd)}`;
  }

  private extractHtmlAttr(html: string, attr: string) {
    const match = html.match(new RegExp(`\\s${attr}=["']([^"']+)["']`, "i"));
    return match?.[1]?.trim() || null;
  }

  private async cleanupExpiredDecks() {
    if (this.retentionHours <= 0) {
      return;
    }

    const cutoff = Date.now() - this.retentionHours * 60 * 60 * 1000;
    const entries = await readdir(DECK_OUTPUT_ROOT, { withFileTypes: true }).catch(() => []);

    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory()) {
        return;
      }

      const deckDir = join(DECK_OUTPUT_ROOT, entry.name);
      const createdAt = await this.readDeckCreatedAt(deckDir);
      if (createdAt < cutoff) {
        await rm(deckDir, { recursive: true, force: true });
      }
    }));
  }

  private async readDeckCreatedAt(deckDir: string) {
    const manifestPath = join(deckDir, "manifest.json");
    const manifest = await readFile(manifestPath, "utf8")
      .then((content) => JSON.parse(content) as { createdAt?: string })
      .catch(() => null);
    const createdAt = manifest?.createdAt ? Date.parse(manifest.createdAt) : Number.NaN;

    if (Number.isFinite(createdAt)) {
      return createdAt;
    }

    return stat(deckDir).then((info) => info.mtimeMs).catch(() => Date.now());
  }

  private async createExportZip(outputDir: string, zipPath: string) {
    const files = await this.listExportFiles(outputDir);
    const fileChunks: Buffer[] = [];
    const centralChunks: Buffer[] = [];
    let offset = 0;

    for (const filePath of files) {
      const entryName = relative(outputDir, filePath).split(sep).join("/");
      const nameBuffer = Buffer.from(entryName, "utf8");
      const data = await readFile(filePath);
      const crc = crc32(data);
      const { dosDate, dosTime } = toDosDateTime(new Date());

      const localHeader = Buffer.alloc(30 + nameBuffer.length);
      localHeader.writeUInt32LE(0x04034b50, 0);
      localHeader.writeUInt16LE(20, 4);
      localHeader.writeUInt16LE(0x0800, 6);
      localHeader.writeUInt16LE(0, 8);
      localHeader.writeUInt16LE(dosTime, 10);
      localHeader.writeUInt16LE(dosDate, 12);
      localHeader.writeUInt32LE(crc, 14);
      localHeader.writeUInt32LE(data.length, 18);
      localHeader.writeUInt32LE(data.length, 22);
      localHeader.writeUInt16LE(nameBuffer.length, 26);
      localHeader.writeUInt16LE(0, 28);
      nameBuffer.copy(localHeader, 30);

      const centralHeader = Buffer.alloc(46 + nameBuffer.length);
      centralHeader.writeUInt32LE(0x02014b50, 0);
      centralHeader.writeUInt16LE(20, 4);
      centralHeader.writeUInt16LE(20, 6);
      centralHeader.writeUInt16LE(0x0800, 8);
      centralHeader.writeUInt16LE(0, 10);
      centralHeader.writeUInt16LE(dosTime, 12);
      centralHeader.writeUInt16LE(dosDate, 14);
      centralHeader.writeUInt32LE(crc, 16);
      centralHeader.writeUInt32LE(data.length, 20);
      centralHeader.writeUInt32LE(data.length, 24);
      centralHeader.writeUInt16LE(nameBuffer.length, 28);
      centralHeader.writeUInt16LE(0, 30);
      centralHeader.writeUInt16LE(0, 32);
      centralHeader.writeUInt16LE(0, 34);
      centralHeader.writeUInt16LE(0, 36);
      centralHeader.writeUInt32LE(0, 38);
      centralHeader.writeUInt32LE(offset, 42);
      nameBuffer.copy(centralHeader, 46);

      fileChunks.push(localHeader, data);
      centralChunks.push(centralHeader);
      offset += localHeader.length + data.length;
    }

    const centralDirectoryOffset = offset;
    const centralDirectorySize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const endRecord = Buffer.alloc(22);
    endRecord.writeUInt32LE(0x06054b50, 0);
    endRecord.writeUInt16LE(0, 4);
    endRecord.writeUInt16LE(0, 6);
    endRecord.writeUInt16LE(files.length, 8);
    endRecord.writeUInt16LE(files.length, 10);
    endRecord.writeUInt32LE(centralDirectorySize, 12);
    endRecord.writeUInt32LE(centralDirectoryOffset, 16);
    endRecord.writeUInt16LE(0, 20);

    await writeFile(zipPath, Buffer.concat([...fileChunks, ...centralChunks, endRecord]));
  }

  private async listExportFiles(outputDir: string) {
    const files = [join(outputDir, "index.html"), join(outputDir, "style.css")];
    const assetsDir = join(outputDir, "assets");

    const walk = async (dir: string) => {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          files.push(fullPath);
        }
      }
    };

    await walk(assetsDir);
    return files;
  }

  private parsePositiveNumber(value: string | undefined, fallback: number) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }

  private renderSlide(deckSpec: PptDeckSpec, slide: PptDeckSlide, index: number, total: number) {
    const active = index === 0 ? " is-active" : "";
    const layout = this.slideLayout(slide);
    const density = slide.animation?.intensity ?? "standard";
    const creativeStyle = this.slideCreativeStyle(deckSpec, slide, index);
    const creativeClasses = this.slideCreativeClasses(creativeStyle);
    const body = this.renderSlideBody(slide);
    const notes = slide.notes ? `<aside class="notes"><p>${this.escapeHtml(slide.notes)}</p></aside>` : "";
    const fxLayer = slide.animation?.fx
      ? `<div class="v2-fx-layer" data-fx="${this.escapeAttr(slide.animation.fx)}" aria-hidden="true"></div>`
      : "";
    const textureLayer = this.renderTextureLayer(creativeStyle);
    const shapeLayer = this.renderShapeLayer(creativeStyle);

    return [
      `<section class="slide slide-${this.escapeAttr(slide.type)} slide-layout-${this.escapeAttr(layout)} ${this.escapeAttr(creativeClasses)}${active}" data-title="${this.escapeAttr(slide.title)}" data-visual-density="${this.escapeAttr(density)}" data-page-style="${this.escapeAttr(creativeStyle?.pageStyle ?? "")}">`,
      fxLayer,
      textureLayer,
      shapeLayer,
      "<div class=\"deck-header\">",
      `<span>${this.escapeHtml(slide.kicker ?? slide.type)}</span>`,
      `<span>${this.escapeHtml(String(index + 1).padStart(2, "0"))}</span>`,
      "</div>",
      body,
      "<div class=\"deck-footer\">",
      `<span>${this.escapeHtml(slide.visualPrompt ?? "HTML-PPT")}</span>`,
      `<span class="slide-number" data-current="${index + 1}" data-total="${total}"></span>`,
      "</div>",
      notes,
      "</section>"
    ].join("\n");
  }

  private renderSlideBody(slide: PptDeckSlide) {
    if (slide.layout || (slide.blocks?.length ?? 0) > 0) {
      return this.renderV2SlideBody(slide);
    }

    if (slide.type === "cover") {
      return [
        "<div class=\"content-narrow\">",
        slide.kicker ? `<p class="kicker">${this.escapeHtml(slide.kicker)}</p>` : "",
        `<h1 class="h1" data-anim="fade-up">${this.escapeHtml(slide.title)}</h1>`,
        slide.subtitle ? `<p class="lede">${this.escapeHtml(slide.subtitle)}</p>` : "",
        slide.quote ? `<div class="quote-panel">${this.escapeHtml(slide.quote)}</div>` : "",
        "</div>"
      ].join("\n");
    }

    if (slide.type === "agenda") {
      return [
        "<div class=\"content-wide\">",
        `<h2 class="h2">${this.escapeHtml(slide.title)}</h2>`,
        "<div class=\"agenda-list\">",
        ...slide.body.map((item, index) => `<div class="agenda-row"><span>${String(index + 1).padStart(2, "0")}</span><b>${this.escapeHtml(item)}</b></div>`),
        "</div>",
        "</div>"
      ].join("\n");
    }

    if (slide.type === "quote") {
      return [
        "<div class=\"content-narrow center-copy\">",
        `<blockquote>${this.escapeHtml(slide.quote ?? slide.title)}</blockquote>`,
        slide.subtitle ? `<p class="lede">${this.escapeHtml(slide.subtitle)}</p>` : "",
        "</div>"
      ].join("\n");
    }

    if (slide.type === "timeline") {
      return [
        "<div class=\"content-wide\">",
        `<h2 class="h2">${this.escapeHtml(slide.title)}</h2>`,
        "<div class=\"timeline-list\">",
        ...slide.body.map((item, index) => `<div class="timeline-item"><span>${String(index + 1).padStart(2, "0")}</span><p>${this.escapeHtml(item)}</p></div>`),
        "</div>",
        "</div>"
      ].join("\n");
    }

    const cards = slide.body.length > 2;
    return [
      "<div class=\"content-wide\">",
      slide.kicker ? `<p class="kicker">${this.escapeHtml(slide.kicker)}</p>` : "",
      `<h2 class="h2">${this.escapeHtml(slide.title)}</h2>`,
      slide.subtitle ? `<p class="lede">${this.escapeHtml(slide.subtitle)}</p>` : "",
      cards ? "<div class=\"card-grid\">" : "<ul class=\"point-list\">",
      ...slide.body.map((item) => cards ? `<div class="card"><p>${this.escapeHtml(item)}</p></div>` : `<li>${this.escapeHtml(item)}</li>`),
      cards ? "</div>" : "</ul>",
      slide.quote ? `<div class="quote-panel">${this.escapeHtml(slide.quote)}</div>` : "",
      "</div>"
    ].join("\n");
  }

  private renderV2SlideBody(slide: PptDeckSlide) {
    const layout = this.slideLayout(slide);

    if (layout === "cover-hero") {
      return this.renderCoverHero(slide);
    }

    if (layout === "toc-grid") {
      return this.renderTocGrid(slide);
    }

    if (layout === "comparison-board") {
      return this.renderComparisonBoard(slide);
    }

    if (layout === "kpi-grid") {
      return this.renderKpiGrid(slide);
    }

    if (layout === "timeline-ribbon") {
      return this.renderTimelineRibbon(slide);
    }

    if (layout === "roadmap") {
      return this.renderRoadmap(slide);
    }

    if (layout === "flow-diagram") {
      return this.renderFlowDiagram(slide);
    }

    if (layout === "closing-cta") {
      return this.renderClosingCta(slide);
    }

    return this.renderContentCards(slide);
  }

  private renderCoverHero(slide: PptDeckSlide) {
    return [
      "<div class=\"v2-cover-glow v2-cover-glow-a\"></div>",
      "<div class=\"v2-cover-glow v2-cover-glow-b\"></div>",
      "<div class=\"v2-cover-grid\" aria-hidden=\"true\">",
      ...Array.from({ length: 18 }, (_, index) => `<span style="--i:${index}"></span>`),
      "</div>",
      "<div class=\"content-wide v2-cover-layout\">",
      "<div class=\"v2-cover-copy\">",
      slide.kicker ? `<p class="kicker">${this.escapeHtml(slide.kicker)}</p>` : "",
      `<h1 class="h1"${this.animAttr(slide, "rise-in")}>${this.escapeHtml(slide.title)}</h1>`,
      slide.subtitle ? `<p class="lede">${this.escapeHtml(slide.subtitle)}</p>` : "",
      this.renderPillRow(slide, slide.body.slice(0, 4)),
      "</div>",
      "<div class=\"v2-cover-orbit\" aria-hidden=\"true\">",
      "<span></span><span></span><span></span>",
      "</div>",
      "</div>"
    ].join("\n");
  }

  private renderTocGrid(slide: PptDeckSlide) {
    const blocks = this.blocksOrBody(slide, "card");
    return [
      "<div class=\"content-wide\">",
      this.renderSlideIntro(slide),
      `<div class="v2-toc-grid"${this.groupAnimAttr(slide, "stagger-list")}>`,
      ...blocks.map((block, index) => [
        "<article class=\"v2-toc-card\">",
        `<span>${String(index + 1).padStart(2, "0")}</span>`,
        `<h3>${this.escapeHtml(block.title ?? block.label ?? `章节 ${index + 1}`)}</h3>`,
        block.body ? `<p>${this.escapeHtml(block.body)}</p>` : "",
        "</article>"
      ].join("\n")),
      "</div>",
      "</div>"
    ].join("\n");
  }

  private renderContentCards(slide: PptDeckSlide) {
    const blocks = this.blocksOrBody(slide, "card");
    return [
      "<div class=\"content-wide\">",
      this.renderSlideIntro(slide),
      `<div class="v2-card-grid"${this.groupAnimAttr(slide, "stagger-list")}>`,
      ...blocks.map((block, index) => this.renderRichCard(block, index)),
      "</div>",
      "</div>"
    ].join("\n");
  }

  private renderComparisonBoard(slide: PptDeckSlide) {
    const panels = (slide.blocks ?? []).filter((block) => block.type === "comparison-panel");
    const fallbackPanels = panels.length >= 2 ? panels.slice(0, 2) : this.bodyAsBlocks(slide.body, "comparison-panel").slice(0, 2);
    const normalizedPanels = fallbackPanels.length >= 2
      ? fallbackPanels
      : [
        { type: "comparison-panel" as const, title: "方案 A", body: slide.body[0] ?? "待补充", items: slide.body.slice(0, 3) },
        { type: "comparison-panel" as const, title: "方案 B", body: slide.body[1] ?? "待补充", items: slide.body.slice(3, 6) }
      ];

    return [
      "<div class=\"content-wide\">",
      this.renderSlideIntro(slide),
      `<div class="v2-comparison-board"${this.groupAnimAttr(slide, "fade-up")}>`,
      normalizedPanels.slice(0, 2).map((panel, index) => [
        `<article class="v2-comparison-panel v2-panel-${index + 1}">`,
        `<p class="v2-panel-label">${this.escapeHtml(panel.label ?? `维度 ${index + 1}`)}</p>`,
        `<h3>${this.escapeHtml(panel.title ?? `对比 ${index + 1}`)}</h3>`,
        panel.body ? `<p>${this.escapeHtml(panel.body)}</p>` : "",
        this.renderBlockItems(panel.items),
        "</article>"
      ].join("\n")).join("\n"),
      "<div class=\"v2-vs-line\"><span>VS</span></div>",
      "</div>",
      "</div>"
    ].join("\n");
  }

  private renderKpiGrid(slide: PptDeckSlide) {
    const metricBlocks = (slide.blocks ?? []).filter((block) => block.type === "metric" || block.type === "bar-progress");
    const blocks = metricBlocks.length > 0 ? metricBlocks : this.bodyAsBlocks(slide.body, "metric");

    return [
      "<div class=\"content-wide\">",
      this.renderSlideIntro(slide),
      `<div class="v2-kpi-grid"${this.groupAnimAttr(slide, "stagger-list")}>`,
      ...blocks.slice(0, 8).map((block, index) => this.renderMetricBlock(block, index)),
      "</div>",
      "</div>"
    ].join("\n");
  }

  private renderTimelineRibbon(slide: PptDeckSlide) {
    const nodes = this.blocksByTypeOrBody(slide, "timeline-node");

    return [
      "<div class=\"content-wide\">",
      this.renderSlideIntro(slide),
      `<div class="v2-timeline-ribbon"${this.groupAnimAttr(slide, "fade-up")}>`,
      ...nodes.slice(0, 6).map((block, index) => [
        "<article class=\"v2-timeline-node\">",
        `<span>${this.escapeHtml(block.label ?? String(index + 1).padStart(2, "0"))}</span>`,
        `<h3>${this.escapeHtml(block.title ?? `阶段 ${index + 1}`)}</h3>`,
        block.body ? `<p>${this.escapeHtml(block.body)}</p>` : "",
        this.renderBlockItems(block.items),
        "</article>"
      ].join("\n")),
      "</div>",
      "</div>"
    ].join("\n");
  }

  private renderRoadmap(slide: PptDeckSlide) {
    const columns = this.blocksByTypeOrBody(slide, "roadmap-column");

    return [
      "<div class=\"content-wide\">",
      this.renderSlideIntro(slide),
      `<div class="v2-roadmap"${this.groupAnimAttr(slide, "stagger-list")}>`,
      ...columns.slice(0, 4).map((block, index) => [
        "<article class=\"v2-roadmap-column\">",
        `<span>${this.escapeHtml(block.label ?? `P${index + 1}`)}</span>`,
        `<h3>${this.escapeHtml(block.title ?? `阶段 ${index + 1}`)}</h3>`,
        block.body ? `<p>${this.escapeHtml(block.body)}</p>` : "",
        this.renderBlockItems(block.items),
        "</article>"
      ].join("\n")),
      "</div>",
      "</div>"
    ].join("\n");
  }

  private renderFlowDiagram(slide: PptDeckSlide) {
    const nodes = this.blocksByTypeOrBody(slide, "flow-node");

    return [
      "<div class=\"content-wide\">",
      this.renderSlideIntro(slide),
      `<div class="v2-flow-diagram"${this.groupAnimAttr(slide, "fade-up")}>`,
      ...nodes.slice(0, 5).map((block, index) => [
        "<article class=\"v2-flow-node\">",
        `<span>${String(index + 1).padStart(2, "0")}</span>`,
        `<h3>${this.escapeHtml(block.title ?? `节点 ${index + 1}`)}</h3>`,
        block.body ? `<p>${this.escapeHtml(block.body)}</p>` : "",
        "</article>",
        index < Math.min(nodes.length, 5) - 1 ? "<b class=\"v2-flow-arrow\">-&gt;</b>" : ""
      ].join("\n")),
      "</div>",
      "</div>"
    ].join("\n");
  }

  private renderClosingCta(slide: PptDeckSlide) {
    const ctas = (slide.blocks ?? []).filter((block) => block.type === "cta" || block.type === "quote");
    const fallback = ctas.length > 0 ? ctas : this.bodyAsBlocks(slide.body, "cta").slice(0, 3);

    return [
      "<div class=\"content-narrow center-copy v2-closing\">",
      slide.kicker ? `<p class="kicker">${this.escapeHtml(slide.kicker)}</p>` : "",
      `<h2 class="h2"${this.animAttr(slide, "rise-in")}>${this.escapeHtml(slide.title)}</h2>`,
      slide.subtitle ? `<p class="lede">${this.escapeHtml(slide.subtitle)}</p>` : "",
      slide.quote ? `<blockquote>${this.escapeHtml(slide.quote)}</blockquote>` : "",
      `<div class="v2-cta-row"${this.groupAnimAttr(slide, "stagger-list")}>`,
      ...fallback.map((block) => `<span>${this.escapeHtml(block.title ?? block.body ?? block.label ?? "行动项")}</span>`),
      "</div>",
      "</div>"
    ].join("\n");
  }

  private renderSlideIntro(slide: PptDeckSlide) {
    return [
      slide.kicker ? `<p class="kicker">${this.escapeHtml(slide.kicker)}</p>` : "",
      `<h2 class="h2"${this.animAttr(slide, "fade-up")}>${this.escapeHtml(slide.title)}</h2>`,
      slide.subtitle ? `<p class="lede">${this.escapeHtml(slide.subtitle)}</p>` : ""
    ].filter(Boolean).join("\n");
  }

  private renderPillRow(slide: PptDeckSlide, fallbackItems: string[]) {
    const pillItems = (slide.blocks ?? [])
      .filter((block) => block.type === "pill-row")
      .flatMap((block) => block.items?.length ? block.items : [block.title, block.body, block.label])
      .filter((item): item is string => Boolean(item));
    const items = (pillItems.length > 0 ? pillItems : fallbackItems).slice(0, 5);

    if (items.length === 0) {
      return "";
    }

    return [
      `<div class="v2-pill-row"${this.groupAnimAttr(slide, "stagger-list")}>`,
      ...items.map((item) => `<span class="v2-pill">${this.escapeHtml(item)}</span>`),
      "</div>"
    ].join("\n");
  }

  private renderRichCard(block: PptDeckBlock, index: number) {
    return [
      "<article class=\"v2-rich-card\">",
      `<span>${this.escapeHtml(block.label ?? String(index + 1).padStart(2, "0"))}</span>`,
      `<h3>${this.escapeHtml(block.title ?? block.body ?? `模块 ${index + 1}`)}</h3>`,
      block.subtitle ? `<small>${this.escapeHtml(block.subtitle)}</small>` : "",
      block.body && block.title ? `<p>${this.escapeHtml(block.body)}</p>` : "",
      this.renderBlockItems(block.items),
      "</article>"
    ].join("\n");
  }

  private renderMetricBlock(block: PptDeckBlock, index: number) {
    const percent = this.blockPercent(block, index);
    return [
      "<article class=\"v2-metric-card\">",
      `<p>${this.escapeHtml(block.label ?? block.title ?? `指标 ${index + 1}`)}</p>`,
      `<strong>${this.escapeHtml(block.value ?? block.body ?? "示例值")}</strong>`,
      block.subtitle ? `<small>${this.escapeHtml(block.subtitle)}</small>` : "",
      `<div class="v2-progress"><i style="width:${percent}%"></i></div>`,
      "</article>"
    ].join("\n");
  }

  private renderBlockItems(items?: string[]) {
    if (!items || items.length === 0) {
      return "";
    }

    return [
      "<ul class=\"v2-block-items\">",
      ...items.slice(0, 6).map((item) => `<li>${this.escapeHtml(item)}</li>`),
      "</ul>"
    ].join("\n");
  }

  private blocksOrBody(slide: PptDeckSlide, type: PptDeckBlock["type"]) {
    const blocks = (slide.blocks ?? []).filter((block) => block.type !== "pill-row");
    return blocks.length > 0 ? blocks : this.bodyAsBlocks(slide.body, type);
  }

  private blocksByTypeOrBody(slide: PptDeckSlide, type: PptDeckBlock["type"]) {
    const blocks = (slide.blocks ?? []).filter((block) => block.type === type);
    return blocks.length > 0 ? blocks : this.bodyAsBlocks(slide.body, type);
  }

  private bodyAsBlocks(body: string[], type: PptDeckBlock["type"]): PptDeckBlock[] {
    return body.length > 0
      ? body.map((item, index) => ({
        type,
        title: item.length > 34 ? `要点 ${index + 1}` : item,
        body: item.length > 34 ? item : undefined,
        label: String(index + 1).padStart(2, "0"),
        items: []
      }))
      : [{ type, title: "待补充", body: "请在对话中补充该页内容。", label: "01", items: [] }];
  }

  private blockPercent(block: PptDeckBlock, index: number) {
    const raw = block.meta?.percent;
    const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (Number.isFinite(parsed)) {
      return Math.max(4, Math.min(100, Math.round(parsed)));
    }

    return [86, 72, 64, 58, 48, 40, 34, 28][index] ?? 52;
  }

  private animAttr(slide: PptDeckSlide, fallback: string) {
    const preset = slide.animation?.preset ?? fallback;
    return preset ? ` data-anim="${this.escapeAttr(preset)}"` : "";
  }

  private groupAnimAttr(slide: PptDeckSlide, fallback: string) {
    const preset = slide.animation?.stagger ? "stagger-list" : (slide.animation?.preset ?? fallback);
    return preset ? ` data-anim="${this.escapeAttr(preset)}"` : "";
  }

  private slideLayout(slide: PptDeckSlide): PptDeckLayout {
    if (slide.layout) {
      return slide.layout;
    }

    const mapping: Record<PptDeckSlide["type"], PptDeckLayout> = {
      cover: "cover-hero",
      agenda: "toc-grid",
      section: "content-cards",
      content: "content-cards",
      quote: "closing-cta",
      timeline: "timeline-ribbon",
      comparison: "comparison-board",
      data: "kpi-grid",
      summary: "roadmap",
      closing: "closing-cta"
    };

    return mapping[slide.type] ?? "content-cards";
  }

  private shouldIncludeFxRuntime(deckSpec: PptDeckSpec) {
    return deckSpec.slides.some((slide) => Boolean(slide.animation?.fx));
  }

  private deckCreativeClass(deckSpec: PptDeckSpec) {
    const deckStyle = deckSpec.creativeStyle?.deckStyle;
    return deckStyle && DECK_STYLE_CATALOG[deckStyle] ? `deck-style-${this.cssKey(deckStyle)}` : "";
  }

  private slideCreativeStyle(deckSpec: PptDeckSpec, slide: PptDeckSlide, index: number): PptDeckCreativeSlideStyle | undefined {
    const styles = deckSpec.creativeStyle?.slides ?? [];
    return styles.find((item) => item.slideId === slide.id) ?? styles[index];
  }

  private slideCreativeClasses(style?: PptDeckCreativeSlideStyle) {
    if (!style) {
      return "";
    }

    return [
      style.pageStyle && PAGE_STYLE_CATALOG[style.pageStyle] ? `page-style-${this.cssKey(style.pageStyle)}` : "",
      style.composition && COMPOSITION_PRESET_CATALOG[style.composition] ? `composition-${this.cssKey(style.composition)}` : "",
      style.componentStyle && COMPONENT_STYLE_CATALOG[style.componentStyle] ? `component-style-${this.cssKey(style.componentStyle)}` : "",
      style.shape && SHAPE_CATALOG[style.shape] ? `shape-style-${this.cssKey(style.shape)}` : "",
      style.texture && TEXTURE_CATALOG[style.texture] ? `texture-style-${this.cssKey(style.texture)}` : ""
    ].filter(Boolean).join(" ");
  }

  private renderTextureLayer(style?: PptDeckCreativeSlideStyle) {
    const texture = style?.texture;
    if (!texture || texture === "none" || !TEXTURE_CATALOG[texture]) {
      return "";
    }

    return `<div class="v2-texture-layer v2-texture-${this.escapeAttr(this.cssKey(texture))}" aria-hidden="true"></div>`;
  }

  private renderShapeLayer(style?: PptDeckCreativeSlideStyle) {
    const shape = style?.shape;
    if (!shape || shape === "none" || !SHAPE_CATALOG[shape]) {
      return "";
    }

    return [
      `<div class="v2-shape-layer v2-shape-${this.escapeAttr(this.cssKey(shape))}" aria-hidden="true">`,
      "<span></span><span></span><span></span>",
      "</div>"
    ].join("");
  }

  private renderStyle(deckSpec: PptDeckSpec) {
    return `
.${this.templateClass(deckSpec.template)} .slide {
  padding: 70px 92px;
}

.content-narrow {
  max-width: 980px;
}

.content-wide {
  width: min(1180px, 100%);
}

.center-copy {
  text-align: center;
  margin: 0 auto;
}

.quote-panel,
blockquote {
  margin-top: 28px;
  padding: 22px 26px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface) 86%, transparent);
  box-shadow: var(--shadow);
  font-size: 24px;
  line-height: 1.55;
  color: var(--accent);
}

.point-list {
  margin: 30px 0 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 16px;
  max-width: 900px;
}

.point-list li {
  padding: 18px 20px;
  border-left: 4px solid var(--accent);
  background: color-mix(in srgb, var(--surface) 82%, transparent);
  border-radius: var(--radius-sm);
  color: var(--text-2);
  font-size: 24px;
}

.card-grid {
  margin-top: 30px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 20px;
}

.card-grid .card p {
  margin: 0;
  font-size: 21px;
  line-height: 1.55;
  color: var(--text-2);
}

.agenda-list,
.timeline-list {
  margin-top: 32px;
  display: grid;
  gap: 16px;
}

.agenda-row,
.timeline-item {
  display: grid;
  grid-template-columns: 72px 1fr;
  gap: 18px;
  align-items: start;
  padding: 18px 20px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface) 80%, transparent);
}

.agenda-row span,
.timeline-item span {
  font-family: var(--font-mono);
  color: var(--accent);
  font-weight: 800;
}

.agenda-row b,
.timeline-item p {
  margin: 0;
  font-size: 22px;
  color: var(--text-1);
}

.slide {
  isolation: isolate;
}

.slide > *:not(.v2-fx-layer) {
  position: relative;
  z-index: 1;
}

.v2-fx-layer {
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  opacity: .46;
  mix-blend-mode: screen;
}

.v2-cover-glow {
  position: absolute;
  border-radius: 999px;
  filter: blur(22px);
  opacity: .58;
  pointer-events: none;
}

.v2-cover-glow-a {
  width: 360px;
  height: 360px;
  right: 9%;
  top: 12%;
  background: color-mix(in srgb, var(--accent) 38%, transparent);
}

.v2-cover-glow-b {
  width: 280px;
  height: 280px;
  left: 11%;
  bottom: 14%;
  background: color-mix(in srgb, var(--accent-2, var(--accent)) 28%, transparent);
}

.v2-cover-layout {
  min-height: 640px;
  display: grid;
  grid-template-columns: minmax(0, 1.1fr) minmax(300px, .9fr);
  align-items: center;
  gap: 56px;
}

.v2-cover-copy {
  max-width: 780px;
}

.v2-cover-grid {
  position: absolute;
  right: 80px;
  top: 108px;
  width: 470px;
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 10px;
  transform: rotate(-7deg);
  opacity: .42;
}

.v2-cover-grid span {
  height: 54px;
  border-radius: 16px;
  border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--border));
  background: color-mix(in srgb, var(--surface) 72%, transparent);
  box-shadow: 0 18px 48px rgba(15, 23, 42, .08);
}

.v2-cover-grid span:nth-child(3n) {
  background: color-mix(in srgb, var(--accent) 18%, var(--surface));
}

.v2-cover-orbit {
  position: relative;
  min-height: 430px;
  border-radius: 46px;
  border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--border));
  background:
    radial-gradient(circle at 50% 46%, color-mix(in srgb, var(--accent) 24%, transparent), transparent 34%),
    color-mix(in srgb, var(--surface) 72%, transparent);
  box-shadow: 0 28px 90px rgba(15, 23, 42, .18);
  overflow: hidden;
}

.v2-cover-orbit span {
  position: absolute;
  inset: 14%;
  border: 1px solid color-mix(in srgb, var(--accent) 36%, transparent);
  border-radius: 999px;
  transform: rotate(calc(var(--n, 1) * 24deg));
}

.v2-cover-orbit span:nth-child(1) { --n: 1; }
.v2-cover-orbit span:nth-child(2) { --n: 3; inset: 23%; }
.v2-cover-orbit span:nth-child(3) { --n: 5; inset: 33%; background: color-mix(in srgb, var(--accent) 24%, transparent); }

.v2-pill-row,
.v2-cta-row {
  margin-top: 28px;
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.v2-pill,
.v2-cta-row span {
  display: inline-flex;
  align-items: center;
  min-height: 40px;
  padding: 9px 14px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--border));
  background: color-mix(in srgb, var(--surface) 72%, transparent);
  color: var(--text-1);
  font-size: 16px;
  font-weight: 800;
}

.v2-toc-grid,
.v2-card-grid {
  margin-top: 34px;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
}

.v2-toc-card,
.v2-rich-card,
.v2-comparison-panel,
.v2-metric-card,
.v2-timeline-node,
.v2-roadmap-column,
.v2-flow-node {
  border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border));
  background:
    linear-gradient(145deg, color-mix(in srgb, var(--surface) 88%, transparent), color-mix(in srgb, var(--surface) 62%, transparent)),
    color-mix(in srgb, var(--bg) 42%, transparent);
  box-shadow: 0 22px 60px rgba(15, 23, 42, .11);
}

.v2-toc-card,
.v2-rich-card {
  min-height: 178px;
  padding: 22px;
  border-radius: 24px;
}

.v2-toc-card span,
.v2-rich-card span,
.v2-timeline-node span,
.v2-roadmap-column span,
.v2-flow-node span,
.v2-panel-label {
  display: inline-flex;
  margin-bottom: 16px;
  font-family: var(--font-mono);
  color: var(--accent);
  font-size: 14px;
  font-weight: 900;
  letter-spacing: .08em;
  text-transform: uppercase;
}

.v2-toc-card h3,
.v2-rich-card h3,
.v2-comparison-panel h3,
.v2-timeline-node h3,
.v2-roadmap-column h3,
.v2-flow-node h3 {
  margin: 0;
  color: var(--text-1);
  font-size: 25px;
  line-height: 1.18;
}

.v2-toc-card p,
.v2-rich-card p,
.v2-comparison-panel p,
.v2-timeline-node p,
.v2-roadmap-column p,
.v2-flow-node p,
.v2-rich-card small,
.v2-metric-card small {
  display: block;
  margin-top: 12px;
  color: var(--text-2);
  font-size: 17px;
  line-height: 1.55;
}

.v2-block-items {
  margin: 16px 0 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 9px;
}

.v2-block-items li {
  position: relative;
  padding-left: 17px;
  color: var(--text-2);
  font-size: 16px;
  line-height: 1.45;
}

.v2-block-items li::before {
  content: "";
  position: absolute;
  left: 0;
  top: .7em;
  width: 7px;
  height: 7px;
  border-radius: 99px;
  background: var(--accent);
}

.v2-comparison-board {
  position: relative;
  margin-top: 36px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 26px;
}

.v2-comparison-panel {
  min-height: 380px;
  padding: 30px;
  border-radius: 30px;
}

.v2-panel-2 {
  transform: translateY(34px);
}

.v2-vs-line {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  width: 84px;
  height: 84px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--accent) 44%, var(--border));
  background: color-mix(in srgb, var(--surface) 90%, transparent);
  box-shadow: 0 18px 52px rgba(15, 23, 42, .18);
  color: var(--accent);
  font-family: var(--font-mono);
  font-weight: 900;
}

.v2-kpi-grid {
  margin-top: 34px;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
}

.v2-metric-card {
  min-height: 178px;
  padding: 20px;
  border-radius: 24px;
}

.v2-metric-card p {
  margin: 0;
  color: var(--text-2);
  font-size: 15px;
  font-weight: 800;
}

.v2-metric-card strong {
  display: block;
  margin-top: 14px;
  color: var(--text-1);
  font-size: clamp(30px, 4vw, 50px);
  line-height: 1;
}

.v2-progress {
  margin-top: 20px;
  height: 8px;
  overflow: hidden;
  border-radius: 99px;
  background: color-mix(in srgb, var(--border) 55%, transparent);
}

.v2-progress i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--accent), var(--accent-2, var(--accent)));
}

.v2-timeline-ribbon {
  position: relative;
  margin-top: 52px;
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 14px;
}

.v2-timeline-ribbon::before {
  content: "";
  position: absolute;
  left: 4%;
  right: 4%;
  top: 36px;
  height: 2px;
  background: color-mix(in srgb, var(--accent) 38%, var(--border));
}

.v2-timeline-node {
  min-height: 260px;
  padding: 18px;
  border-radius: 24px;
}

.v2-roadmap {
  margin-top: 34px;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 18px;
}

.v2-roadmap-column {
  min-height: 360px;
  padding: 24px;
  border-radius: 26px;
}

.v2-flow-diagram {
  margin-top: 42px;
  display: flex;
  align-items: stretch;
  gap: 14px;
}

.v2-flow-node {
  flex: 1;
  min-height: 280px;
  padding: 22px;
  border-radius: 28px;
}

.v2-flow-arrow {
  align-self: center;
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 24px;
}

.v2-closing blockquote {
  margin-left: auto;
  margin-right: auto;
}

${this.renderCreativeStyleCss()}

${this.renderTemplateStyle(deckSpec.template)}

@media (max-width: 900px) {
  .${this.templateClass(deckSpec.template)} .slide {
    padding: 54px 34px;
  }

  .card-grid {
    grid-template-columns: 1fr;
  }

  .v2-cover-layout,
  .v2-comparison-board,
  .v2-roadmap {
    grid-template-columns: 1fr;
  }

  .v2-cover-orbit,
  .v2-cover-grid {
    display: none;
  }

  .v2-toc-grid,
  .v2-card-grid,
  .v2-kpi-grid {
    grid-template-columns: 1fr;
  }

  .v2-timeline-ribbon {
    grid-template-columns: 1fr;
  }

  .v2-flow-diagram {
    flex-direction: column;
  }

  .v2-panel-2 {
    transform: none;
  }

  .v2-vs-line {
    display: none;
  }

  h1.title,.h1 {
    font-size: 52px;
  }

  h2.title,.h2 {
    font-size: 40px;
  }
}
`.trim();
  }

  private renderTemplateStyle(template: string) {
    const className = this.templateClass(template);
    const normalized = template.toLowerCase();

    if (normalized.includes("pitch")) {
      return `
.${className} .slide {
  background:
    radial-gradient(circle at 12% 18%, color-mix(in srgb, var(--accent) 18%, transparent), transparent 34%),
    linear-gradient(135deg, color-mix(in srgb, var(--surface) 88%, white), var(--bg));
}

.${className} .h1,
.${className} .h2 {
  letter-spacing: -0.055em;
}

.${className} .card-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.${className} .card {
  min-height: 178px;
  border-radius: 28px;
  border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--border));
  background: color-mix(in srgb, var(--surface) 78%, transparent);
  box-shadow: 0 24px 70px rgba(15, 23, 42, 0.12);
}
`.trim();
    }

    if (normalized.includes("tech") || normalized.includes("blueprint") || normalized.includes("terminal")) {
      return `
.${className} .slide {
  background:
    linear-gradient(color-mix(in srgb, var(--border) 35%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--border) 35%, transparent) 1px, transparent 1px),
    var(--bg);
  background-size: 42px 42px;
}

.${className} .deck-header,
.${className} .deck-footer,
.${className} .kicker,
.${className} .agenda-row span,
.${className} .timeline-item span {
  font-family: var(--font-mono);
}

.${className} .card,
.${className} .agenda-row,
.${className} .timeline-item,
.${className} .quote-panel {
  border-style: dashed;
}
`.trim();
    }

    if (normalized.includes("weekly") || normalized.includes("report")) {
      return `
.${className} .slide {
  background:
    radial-gradient(circle at 80% 16%, color-mix(in srgb, var(--accent) 14%, transparent), transparent 32%),
    var(--bg);
}

.${className} .card-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.${className} .card {
  border-radius: 22px;
  border: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface) 88%, transparent);
}

.${className} .point-list {
  max-width: 1080px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
`.trim();
    }

    if (normalized.includes("presenter")) {
      return `
.${className} .notes {
  position: absolute;
  left: 92px;
  right: 92px;
  bottom: 72px;
  padding: 16px 18px;
  border-radius: 18px;
  border: 1px solid color-mix(in srgb, var(--accent) 26%, var(--border));
  background: color-mix(in srgb, var(--surface) 84%, transparent);
  color: var(--text-2);
}

.${className} .deck-footer {
  display: none;
}
`.trim();
    }

    if (normalized.includes("xhs")) {
      return `
.${className} .slide {
  padding: 78px 130px;
}

.${className} .content-wide,
.${className} .content-narrow {
  max-width: 820px;
  margin: 0 auto;
}

.${className} .h1,
.${className} .h2 {
  text-align: center;
}

.${className} .card-grid,
.${className} .point-list {
  grid-template-columns: 1fr;
}
`.trim();
    }

    return "";
  }

  private renderCreativeStyleCss() {
    return `
.deck-style-editorial .h1,
.deck-style-editorial .h2 {
  font-family: var(--font-display);
  letter-spacing: -0.06em;
}

.deck-style-product .slide {
  background:
    radial-gradient(circle at 86% 12%, color-mix(in srgb, var(--accent-2) 18%, transparent), transparent 32%),
    radial-gradient(circle at 8% 86%, color-mix(in srgb, var(--accent) 14%, transparent), transparent 28%),
    var(--bg);
}

.deck-style-technical .deck-header,
.deck-style-technical .deck-footer,
.deck-style-technical .kicker {
  font-family: var(--font-mono);
}

.deck-style-investor .v2-metric-card strong {
  font-size: clamp(46px, 8vw, 104px);
}

.deck-style-broadcast .slide {
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--accent) 18%, transparent) 0 8px, transparent 8px),
    var(--bg);
}

.deck-style-cinematic .slide {
  background:
    radial-gradient(circle at 50% -10%, color-mix(in srgb, var(--accent) 24%, transparent), transparent 36%),
    linear-gradient(180deg, color-mix(in srgb, var(--bg) 72%, black), var(--bg));
}

.deck-style-playful .slide {
  background:
    radial-gradient(circle at 16% 20%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 24%),
    radial-gradient(circle at 88% 78%, color-mix(in srgb, var(--accent-2) 22%, transparent), transparent 26%),
    var(--bg);
}

.composition-hero-split-diagonal .v2-cover-layout,
.composition-hero-split-diagonal .content-wide {
  display: grid;
  grid-template-columns: minmax(0, 1.08fr) minmax(320px, .72fr);
  align-items: center;
  gap: 64px;
}

.composition-hero-split-diagonal .h1,
.composition-hero-split-diagonal .h2 {
  max-width: 860px;
  text-align: left;
}

.composition-hero-split-diagonal::before {
  content: "";
  position: absolute;
  right: -12%;
  top: 0;
  width: 54%;
  height: 100%;
  transform: skewX(-14deg);
  background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 24%, transparent), color-mix(in srgb, var(--accent-2) 16%, transparent));
  opacity: .76;
  pointer-events: none;
}

.composition-editorial-poster-stack .content-wide,
.composition-editorial-poster-stack .content-narrow {
  max-width: 980px;
  margin: 0 auto;
}

.composition-editorial-poster-stack .kicker,
.composition-editorial-poster-stack .h1,
.composition-editorial-poster-stack .h2,
.composition-editorial-poster-stack .lede {
  text-align: center;
}

.composition-editorial-poster-stack .v2-card-grid,
.composition-editorial-poster-stack .v2-toc-grid {
  grid-template-columns: 1fr;
  max-width: 760px;
  margin-left: auto;
  margin-right: auto;
}

.composition-editorial-poster-stack .v2-rich-card,
.composition-editorial-poster-stack .v2-toc-card {
  min-height: 118px;
  transform: rotate(calc((var(--i, 0) - 1) * .35deg));
}

.composition-bento-dashboard .v2-card-grid,
.composition-bento-dashboard .v2-toc-grid,
.composition-bento-dashboard .v2-kpi-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  grid-auto-flow: dense;
  gap: 14px;
}

.composition-bento-dashboard .v2-rich-card:nth-child(1),
.composition-bento-dashboard .v2-toc-card:nth-child(1) {
  grid-column: span 2;
  grid-row: span 2;
}

.composition-bento-dashboard .v2-rich-card,
.composition-bento-dashboard .v2-toc-card,
.composition-bento-dashboard .v2-metric-card {
  min-height: 154px;
  padding: 20px;
}

.composition-timeline-map .h2,
.composition-timeline-map .lede,
.composition-timeline-map .kicker {
  max-width: 760px;
}

.composition-timeline-map .v2-timeline-ribbon {
  grid-template-columns: repeat(6, minmax(150px, 1fr));
  align-items: start;
  gap: 12px;
}

.composition-timeline-map .v2-timeline-node:nth-child(even) {
  margin-top: 72px;
}

.composition-timeline-map .v2-timeline-ribbon::before {
  top: 76px;
  height: 3px;
  background: linear-gradient(90deg, transparent, var(--accent), var(--accent-2, var(--accent)), transparent);
}

.composition-comparison-arena .h2,
.composition-comparison-arena .lede,
.composition-comparison-arena .kicker {
  text-align: center;
}

.composition-comparison-arena .v2-comparison-board {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 54px;
}

.composition-comparison-arena .v2-comparison-panel {
  min-height: 430px;
}

.composition-comparison-arena .v2-panel-1 {
  transform: translateY(18px) rotate(-1.1deg);
}

.composition-comparison-arena .v2-panel-2 {
  transform: translateY(18px) rotate(1.1deg);
}

.composition-radial-orbit .content-wide {
  position: relative;
}

.composition-radial-orbit .v2-card-grid,
.composition-radial-orbit .v2-toc-grid,
.composition-radial-orbit .v2-kpi-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 20px;
  padding-right: 120px;
}

.composition-radial-orbit::after {
  content: "";
  position: absolute;
  right: 9%;
  top: 23%;
  width: 360px;
  height: 360px;
  border-radius: 50%;
  border: 1px solid color-mix(in srgb, var(--accent) 44%, transparent);
  box-shadow:
    0 0 0 72px color-mix(in srgb, var(--accent) 7%, transparent),
    0 0 0 138px color-mix(in srgb, var(--accent-2) 6%, transparent);
  pointer-events: none;
}

.composition-blueprint-lab .slide,
.composition-blueprint-lab {
  background:
    linear-gradient(color-mix(in srgb, var(--border) 42%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--border) 42%, transparent) 1px, transparent 1px),
    radial-gradient(circle at 82% 18%, color-mix(in srgb, var(--accent) 16%, transparent), transparent 32%),
    var(--bg);
  background-size: 36px 36px, 36px 36px, auto, auto;
}

.composition-blueprint-lab .h2,
.composition-blueprint-lab .kicker,
.composition-blueprint-lab .deck-header,
.composition-blueprint-lab .deck-footer,
.composition-blueprint-lab .v2-flow-node,
.composition-blueprint-lab .v2-rich-card {
  font-family: var(--font-mono);
}

.composition-blueprint-lab .v2-card-grid,
.composition-blueprint-lab .v2-flow-diagram {
  gap: 16px;
}

.composition-cinematic-spotlight {
  background:
    radial-gradient(circle at 50% 38%, color-mix(in srgb, var(--accent) 22%, transparent), transparent 34%),
    radial-gradient(circle at 50% 120%, color-mix(in srgb, black 38%, transparent), transparent 44%),
    var(--bg);
}

.composition-cinematic-spotlight .content-wide,
.composition-cinematic-spotlight .content-narrow {
  max-width: 940px;
  margin: 0 auto;
}

.composition-cinematic-spotlight .kicker,
.composition-cinematic-spotlight .h1,
.composition-cinematic-spotlight .h2,
.composition-cinematic-spotlight .lede,
.composition-cinematic-spotlight blockquote {
  text-align: center;
}

.composition-cinematic-spotlight .v2-card-grid,
.composition-cinematic-spotlight .v2-cta-row {
  justify-content: center;
}

.composition-magazine-collage .h1,
.composition-magazine-collage .h2 {
  max-width: 900px;
  letter-spacing: -0.08em;
  transform: rotate(-.6deg);
}

.composition-magazine-collage .v2-card-grid,
.composition-magazine-collage .v2-toc-grid {
  grid-template-columns: 1.25fr .85fr 1fr;
  align-items: stretch;
  gap: 18px;
}

.composition-magazine-collage .v2-rich-card:nth-child(2n),
.composition-magazine-collage .v2-toc-card:nth-child(2n) {
  transform: translateY(28px) rotate(1.2deg);
}

.composition-magazine-collage .v2-rich-card:nth-child(3n),
.composition-magazine-collage .v2-toc-card:nth-child(3n) {
  transform: rotate(-1.2deg);
}

.composition-data-command-center .h2,
.composition-data-command-center .lede,
.composition-data-command-center .kicker {
  max-width: 860px;
}

.composition-data-command-center .v2-kpi-grid,
.composition-data-command-center .v2-card-grid,
.composition-data-command-center .v2-toc-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

.composition-data-command-center .v2-metric-card {
  min-height: 168px;
  padding: 18px;
}

.composition-data-command-center .v2-metric-card strong {
  font-size: clamp(34px, 4.6vw, 64px);
}

.composition-process-river .v2-flow-diagram {
  align-items: center;
  gap: 6px;
}

.composition-process-river .v2-flow-node {
  min-height: 230px;
  border-radius: 40px;
}

.composition-process-river .v2-flow-node:nth-of-type(even) {
  transform: translateY(42px);
}

.composition-process-river .v2-flow-arrow {
  width: 46px;
  text-align: center;
  opacity: .72;
}

.composition-minimal-focus .slide,
.composition-minimal-focus {
  background: var(--bg);
}

.composition-minimal-focus .content-wide,
.composition-minimal-focus .content-narrow {
  max-width: 860px;
  margin: 0 auto;
}

.composition-minimal-focus .v2-card-grid,
.composition-minimal-focus .v2-toc-grid,
.composition-minimal-focus .v2-kpi-grid {
  grid-template-columns: 1fr;
  max-width: 760px;
  margin-left: auto;
  margin-right: auto;
}

.composition-minimal-focus .v2-rich-card,
.composition-minimal-focus .v2-toc-card,
.composition-minimal-focus .v2-metric-card {
  min-height: 108px;
  box-shadow: none;
}

.component-style-glass-panels .v2-rich-card,
.component-style-glass-panels .v2-metric-card,
.component-style-glass-panels .v2-comparison-panel,
.component-style-glass-panels .v2-roadmap-column,
.component-style-glass-panels .v2-flow-node,
.component-style-glass-panels .quote-panel,
.component-style-glass-panels blockquote {
  background: color-mix(in srgb, var(--surface) 62%, transparent);
  backdrop-filter: blur(18px) saturate(1.25);
  box-shadow: 0 26px 90px color-mix(in srgb, var(--accent) 16%, transparent);
}

.component-style-ink-outline .v2-rich-card,
.component-style-ink-outline .v2-metric-card,
.component-style-ink-outline .v2-comparison-panel,
.component-style-ink-outline .v2-roadmap-column,
.component-style-ink-outline .v2-flow-node {
  border: 1.5px solid color-mix(in srgb, var(--text-1) 30%, var(--border));
  box-shadow: none;
}

.component-style-hard-shadow .v2-rich-card,
.component-style-hard-shadow .v2-metric-card,
.component-style-hard-shadow .v2-comparison-panel,
.component-style-hard-shadow .v2-roadmap-column,
.component-style-hard-shadow .v2-flow-node {
  border: 2px solid var(--text-1);
  box-shadow: 10px 10px 0 color-mix(in srgb, var(--accent) 72%, black);
}

.component-style-soft-depth .v2-rich-card,
.component-style-soft-depth .v2-metric-card,
.component-style-soft-depth .v2-comparison-panel,
.component-style-soft-depth .v2-roadmap-column,
.component-style-soft-depth .v2-flow-node {
  box-shadow: 0 28px 80px rgba(15, 23, 42, 0.14), inset 0 1px 0 rgba(255,255,255,0.35);
}

.component-style-neon-edge .v2-rich-card,
.component-style-neon-edge .v2-metric-card,
.component-style-neon-edge .v2-comparison-panel,
.component-style-neon-edge .v2-roadmap-column,
.component-style-neon-edge .v2-flow-node {
  border-color: color-mix(in srgb, var(--accent) 56%, var(--border));
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 20%, transparent), 0 0 44px color-mix(in srgb, var(--accent) 26%, transparent);
}

.component-style-blueprint-lines .v2-rich-card,
.component-style-blueprint-lines .v2-metric-card,
.component-style-blueprint-lines .v2-comparison-panel,
.component-style-blueprint-lines .v2-roadmap-column,
.component-style-blueprint-lines .v2-flow-node {
  background:
    linear-gradient(color-mix(in srgb, var(--border) 45%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--border) 45%, transparent) 1px, transparent 1px),
    color-mix(in srgb, var(--surface) 84%, transparent);
  background-size: 18px 18px;
}

.component-style-magazine-cuts .v2-rich-card,
.component-style-magazine-cuts .v2-metric-card {
  border-radius: 8px 40px 12px 28px;
  transform: rotate(-0.4deg);
}

.component-style-terminal-blocks .v2-rich-card,
.component-style-terminal-blocks .v2-metric-card,
.component-style-terminal-blocks .v2-flow-node {
  border-radius: 10px;
  font-family: var(--font-mono);
}

.v2-texture-layer,
.v2-shape-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
  border-radius: inherit;
}

.v2-texture-layer {
  z-index: 0;
  opacity: .52;
  mix-blend-mode: multiply;
}

.v2-shape-layer {
  z-index: 1;
}

.deck-header,
.deck-footer,
.content-wide,
.content-narrow,
.center-copy {
  position: relative;
  z-index: 2;
}

.v2-fx-layer {
  z-index: 0;
}

.v2-texture-blueprint-grid {
  background:
    linear-gradient(color-mix(in srgb, var(--accent) 18%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--accent) 18%, transparent) 1px, transparent 1px);
  background-size: 34px 34px;
}

.v2-texture-paper-grain {
  background-image:
    radial-gradient(circle at 20% 30%, rgba(255,255,255,.28) 0 1px, transparent 1px),
    radial-gradient(circle at 70% 60%, rgba(0,0,0,.08) 0 1px, transparent 1px);
  background-size: 18px 18px, 23px 23px;
}

.v2-texture-scanlines {
  background: repeating-linear-gradient(180deg, rgba(255,255,255,.06) 0 1px, transparent 1px 5px);
}

.v2-texture-dot-matrix {
  background-image: radial-gradient(color-mix(in srgb, var(--accent) 26%, transparent) 1px, transparent 1.4px);
  background-size: 18px 18px;
}

.v2-texture-aurora-haze {
  background:
    radial-gradient(circle at 24% 28%, color-mix(in srgb, var(--accent) 18%, transparent), transparent 34%),
    radial-gradient(circle at 76% 72%, color-mix(in srgb, var(--accent-2) 18%, transparent), transparent 34%);
  filter: blur(8px);
}

.v2-texture-diagonal-rules {
  background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--border) 42%, transparent) 0 1px, transparent 1px 18px);
}

.v2-texture-radial-burst {
  background: repeating-radial-gradient(circle at 50% 45%, color-mix(in srgb, var(--accent) 16%, transparent) 0 1px, transparent 1px 18px);
}

.v2-shape-layer span {
  position: absolute;
  display: block;
}

.v2-shape-orbit-rings span {
  width: 260px;
  height: 260px;
  right: 8%;
  top: 18%;
  border: 1px solid color-mix(in srgb, var(--accent) 34%, transparent);
  border-radius: 999px;
}

.v2-shape-orbit-rings span:nth-child(2) { width: 390px; height: 390px; right: 3%; top: 8%; }
.v2-shape-orbit-rings span:nth-child(3) { width: 520px; height: 520px; right: -5%; top: -2%; }

.v2-shape-floating-blobs span {
  width: 280px;
  height: 280px;
  border-radius: 46% 54% 70% 30% / 30% 44% 56% 70%;
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  filter: blur(18px);
}

.v2-shape-floating-blobs span:nth-child(1) { left: 6%; top: 10%; }
.v2-shape-floating-blobs span:nth-child(2) { right: 10%; bottom: 12%; background: color-mix(in srgb, var(--accent-2) 18%, transparent); }
.v2-shape-floating-blobs span:nth-child(3) { left: 46%; top: 64%; width: 190px; height: 190px; }

.v2-shape-corner-frames span {
  width: 150px;
  height: 150px;
  border: 2px solid color-mix(in srgb, var(--accent) 52%, transparent);
}

.v2-shape-corner-frames span:nth-child(1) { left: 42px; top: 42px; border-right: 0; border-bottom: 0; }
.v2-shape-corner-frames span:nth-child(2) { right: 42px; top: 42px; border-left: 0; border-bottom: 0; }
.v2-shape-corner-frames span:nth-child(3) { right: 42px; bottom: 42px; border-left: 0; border-top: 0; }

.v2-shape-diagonal-panels span {
  inset: auto -10% 8% auto;
  width: 52%;
  height: 34%;
  transform: skewX(-18deg);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

.v2-shape-diagonal-panels span:nth-child(2) { top: 9%; left: -12%; right: auto; bottom: auto; background: color-mix(in srgb, var(--accent-2) 10%, transparent); }
.v2-shape-diagonal-panels span:nth-child(3) { display: none; }

.v2-shape-data-nodes span {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 10px color-mix(in srgb, var(--accent) 13%, transparent), 120px 80px 0 -2px var(--accent-2), 260px 30px 0 -3px var(--accent);
}

.v2-shape-data-nodes span:nth-child(1) { left: 10%; top: 22%; }
.v2-shape-data-nodes span:nth-child(2) { right: 28%; top: 20%; }
.v2-shape-data-nodes span:nth-child(3) { left: 36%; bottom: 18%; }

.v2-shape-bauhaus-circles span {
  border-radius: 50%;
  border: 22px solid color-mix(in srgb, var(--accent) 62%, transparent);
}

.v2-shape-bauhaus-circles span:nth-child(1) { width: 180px; height: 180px; right: 11%; top: 16%; }
.v2-shape-bauhaus-circles span:nth-child(2) { width: 90px; height: 90px; left: 12%; bottom: 20%; border-color: color-mix(in srgb, var(--accent-2) 62%, transparent); }
.v2-shape-bauhaus-circles span:nth-child(3) { width: 130px; height: 130px; right: 38%; bottom: 10%; border-width: 14px; }

.v2-shape-ribbon-lines span {
  height: 2px;
  width: 46%;
  background: linear-gradient(90deg, transparent, var(--accent), transparent);
  transform: rotate(-10deg);
}

.v2-shape-ribbon-lines span:nth-child(1) { left: -8%; top: 24%; }
.v2-shape-ribbon-lines span:nth-child(2) { right: -6%; top: 58%; transform: rotate(12deg); }
.v2-shape-ribbon-lines span:nth-child(3) { left: 28%; bottom: 12%; transform: rotate(4deg); opacity: .55; }

.v2-shape-signal-waves span {
  width: 320px;
  height: 320px;
  right: 10%;
  bottom: 12%;
  border: 2px solid color-mix(in srgb, var(--accent) 24%, transparent);
  border-radius: 50%;
}

.v2-shape-signal-waves span:nth-child(2) { width: 450px; height: 450px; right: 5%; bottom: 4%; }
.v2-shape-signal-waves span:nth-child(3) { width: 590px; height: 590px; right: 0; bottom: -6%; }
`.trim();
  }

  private themeList(deckSpec: PptDeckSpec) {
    return Array.from(new Set([
      deckSpec.theme,
      ...(deckSpec.creativeStyle?.backupThemes ?? []),
      ...(deckSpec.visualSystem?.backupThemes ?? []),
      ...DEFAULT_THEMES
    ]));
  }

  private templateClass(template: string) {
    return `tpl-${template.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`;
  }

  private cssKey(value: string) {
    return value.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  }

  private escapeHtml(input: string) {
    return input
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  private escapeAttr(input: string) {
    return this.escapeHtml(input);
  }
}

function createCrc32Table() {
  const table = new Uint32Array(256);

  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }

  return table;
}

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc = (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function toDosDateTime(date: Date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();

  return { dosDate, dosTime };
}
