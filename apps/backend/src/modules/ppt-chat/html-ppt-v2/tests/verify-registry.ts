import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolve } from "node:path";
import { ANIMATION_IDS, FX_IDS, RENDERABLE_LAYOUT_IDS } from "../ir/enums";
import { SkillRegistryService, countDonorContractGuards, hydrateHtmlPptV2SkillRegistry, skillRegistrySchema, type DonorCatalogItem, type LayoutCatalogItem } from "../registry";

async function main() {
  const skillRoot = resolve(process.cwd(), "..", "..", ".agents", "skills", "html-ppt");
  const registryService = new SkillRegistryService();
  registryService.clearCache();
  const registry = await registryService.hydrate(skillRoot);
  const cachedRegistry = await registryService.hydrate(skillRoot);
  if (cachedRegistry !== registry) {
    throw new Error("Skill registry should return the cached registry instance when the source signature is unchanged.");
  }
  const helperRegistry = await hydrateHtmlPptV2SkillRegistry(skillRoot);
  if (helperRegistry !== registry) {
    throw new Error("hydrateHtmlPptV2SkillRegistry should share the process-wide registry cache.");
  }
  if (registryService.cacheStats().entries < 1) {
    throw new Error("Skill registry cache stats should report at least one cached root.");
  }
  const parsed = skillRegistrySchema.parse(registry);
  const expectedAnimationIds = ANIMATION_IDS.filter((id) => id !== "none").sort();
  const actualAnimationIds = parsed.animations.map((item) => item.id).sort();
  if (JSON.stringify(actualAnimationIds) !== JSON.stringify(expectedAnimationIds)) {
    throw new Error(`Registry animations must exactly match renderer-supported ANIMATION_IDS except none. expected=${expectedAnimationIds.join(",")} actual=${actualAnimationIds.join(",")}`);
  }

  const expectedFxIds = FX_IDS.filter((id) => id !== "none").sort();
  const actualFxIds = parsed.fx.map((item) => item.id).sort();
  if (JSON.stringify(actualFxIds) !== JSON.stringify(expectedFxIds)) {
    throw new Error(`Registry FX must exactly match real file-backed FX_IDS except none. expected=${expectedFxIds.join(",")} actual=${actualFxIds.join(",")}`);
  }

  for (const fx of parsed.fx) {
    if (fx.file.startsWith("virtual:")) {
      throw new Error(`Registry FX must never hydrate virtual file paths: ${fx.id}`);
    }
  }

  const requiredLayouts = [...RENDERABLE_LAYOUT_IDS];
  const requiredThemes = ["engineering-whiteprint", "sunset-warm", "editorial-serif"];
  const requiredDonors = ["tech-sharing", "pitch-deck", "product-launch"];

  for (const id of requiredLayouts) {
    if (!parsed.layouts.some((item) => item.id === id)) {
      throw new Error(`Registry missing required layout: ${id}`);
    }
  }
  const layoutContractReport = buildLayoutContractReport(parsed.layouts);
  const weakLayoutContracts = layoutContractReport.filter((item) => item.weakCategories.length);
  if (weakLayoutContracts.length) {
    throw new Error(`Renderable layout contract coverage has weak categories: ${weakLayoutContracts.map((item) => `${item.id}=${item.weakCategories.join("|")}`).join(", ")}`);
  }

  for (const id of requiredThemes) {
    if (!parsed.themes.some((item) => item.id === id)) {
      throw new Error(`Registry missing required theme: ${id}`);
    }
  }

  for (const id of requiredDonors) {
    if (!parsed.donors.some((item) => item.id === id)) {
      throw new Error(`Registry missing required donor: ${id}`);
    }
  }

  for (const donor of parsed.donors) {
    const guardCounts = countDonorContractGuards(donor.contract);
    if (guardCounts.totalGuards === 0) {
      throw new Error(`Donor '${donor.id}' must not hydrate with an empty contract.`);
    }
    if (guardCounts.textGuards === 0 && !guardCounts.textGuardsExempted) {
      throw new Error(`Donor '${donor.id}' must define at least one text guard or reviewed text-guard exemption.`);
    }
    if (guardCounts.classCssGuards === 0 && !guardCounts.classCssGuardsExempted) {
      throw new Error(`Donor '${donor.id}' must define at least one class/CSS guard or reviewed class/CSS exemption.`);
    }
  }
  const donorGuardReport = await buildDonorGuardReport(parsed.donors);
  const weakDonorGuards = donorGuardReport.filter((item) => item.weakCategories.length);
  if (weakDonorGuards.length) {
    throw new Error(`Donor guard coverage has weak categories: ${weakDonorGuards.map((item) => `${item.id}=${item.weakCategories.join("|")}`).join(", ")}`);
  }

  const donorById = new Map(parsed.donors.map((donor) => [donor.id, donor]));
  for (const template of parsed.templatePackages) {
    const donor = donorById.get(template.donorTemplateId);
    if (!donor) {
      throw new Error(`Template '${template.id}' must reference a hydrated donor.`);
    }
    if (template.deckClass !== donor.deckClass) {
      throw new Error(`Template '${template.id}' deckClass '${template.deckClass}' must match donor deckClass '${donor.deckClass}'.`);
    }
    if (template.rendererProfile === "standard-wide" && template.aspectRatio !== "16:9") {
      throw new Error(`Template '${template.id}' standard-wide renderer profile must use 16:9.`);
    }
    if (template.rendererProfile === "social-portrait" && template.aspectRatio !== "3:4") {
      throw new Error(`Template '${template.id}' social-portrait renderer profile must use 3:4.`);
    }
  }

  const badRegistry = structuredClone(parsed);
  badRegistry.themes[0]!.wcag = {
    passed: false,
    minContrastRatio: 1.1,
    issues: ["Intentional failing theme for registry gate test."]
  };

  const badResult = skillRegistrySchema.safeParse(badRegistry);
  if (badResult.success) {
    throw new Error("Registry WCAG gate should reject a theme with passed=false.");
  }

  const mismatchedLayoutContractRegistry = structuredClone(parsed);
  mismatchedLayoutContractRegistry.layouts[0]!.contract.roleFit = ["cover"];
  const mismatchedLayoutContractResult = skillRegistrySchema.safeParse(mismatchedLayoutContractRegistry);
  if (mismatchedLayoutContractResult.success) {
    throw new Error("Registry layout gate should reject layout contract roleFit that drifts from layout roleFit.");
  }

  const badFallbackLayoutRegistry = structuredClone(parsed) as unknown as {
    layouts: Array<{ contract: { fallbackLayouts: string[] } }>;
  };
  badFallbackLayoutRegistry.layouts[0]!.contract.fallbackLayouts = ["not-a-layout"];
  const badFallbackLayoutResult = skillRegistrySchema.safeParse(badFallbackLayoutRegistry);
  if (badFallbackLayoutResult.success) {
    throw new Error("Registry layout gate should reject fallback layout IDs outside the closed renderable set.");
  }

  const emptyDonorRegistry = structuredClone(parsed);
  emptyDonorRegistry.donors[0]!.contract = {
    forbiddenTextPatterns: [],
    forbiddenTextExamples: [],
    forbiddenClasses: [],
    coverOnlyClasses: [],
    decorativeOnlyClasses: [],
    cssRedactClasses: [],
    reviewedExemptions: {}
  };
  const emptyDonorResult = skillRegistrySchema.safeParse(emptyDonorRegistry);
  if (emptyDonorResult.success) {
    throw new Error("Registry donor gate should reject empty donor contracts.");
  }

  const missingTextGuardRegistry = structuredClone(parsed);
  missingTextGuardRegistry.donors[0]!.contract = {
    forbiddenTextPatterns: [],
    forbiddenTextExamples: [],
    forbiddenClasses: ["legacy-only"],
    coverOnlyClasses: [],
    decorativeOnlyClasses: [],
    cssRedactClasses: ["legacy-only"],
    reviewedExemptions: {}
  };
  const missingTextGuardResult = skillRegistrySchema.safeParse(missingTextGuardRegistry);
  if (missingTextGuardResult.success) {
    throw new Error("Registry donor gate should reject contracts without text guards unless reviewedExemptions.textGuards is set.");
  }

  const missingClassCssGuardRegistry = structuredClone(parsed);
  missingClassCssGuardRegistry.donors[0]!.contract = {
    forbiddenTextPatterns: ["Legacy\\s+copy"],
    forbiddenTextExamples: [],
    forbiddenClasses: [],
    coverOnlyClasses: [],
    decorativeOnlyClasses: [],
    cssRedactClasses: [],
    reviewedExemptions: {}
  };
  const missingClassCssGuardResult = skillRegistrySchema.safeParse(missingClassCssGuardRegistry);
  if (missingClassCssGuardResult.success) {
    throw new Error("Registry donor gate should reject contracts without class/CSS guards unless reviewedExemptions.classCssGuards is set.");
  }

  const reviewedExemptionRegistry = structuredClone(parsed);
  reviewedExemptionRegistry.donors[0]!.contract = {
    forbiddenTextPatterns: [],
    forbiddenTextExamples: [],
    forbiddenClasses: ["legacy-only"],
    coverOnlyClasses: [],
    decorativeOnlyClasses: [],
    cssRedactClasses: ["legacy-only"],
    reviewedExemptions: {
      textGuards: "Reviewed donor source has no reusable donor copy beyond content supplied at runtime."
    }
  };
  const reviewedExemptionResult = skillRegistrySchema.safeParse(reviewedExemptionRegistry);
  if (!reviewedExemptionResult.success) {
    throw new Error("Registry donor gate should allow a missing guard category only when an explicit reviewed exemption is present.");
  }

  const extraAnimationRegistry = structuredClone(parsed) as unknown as {
    animations: Array<{ id: string; cssClass: string; kind: "enter" | "loop"; perfClass: "cheap" | "medium" | "heavy" }>;
  };
  extraAnimationRegistry.animations.push({
    id: "legacy-only",
    cssClass: "anim-legacy-only",
    kind: "enter",
    perfClass: "cheap"
  });
  const extraAnimationResult = skillRegistrySchema.safeParse(extraAnimationRegistry);
  if (extraAnimationResult.success) {
    throw new Error("Registry animation schema should reject animation IDs outside ANIMATION_IDS.");
  }

  const service = registryService as unknown as {
    contrastRatio: (foreground: string, background: string, baseBackground: string) => number;
  };
  const colorChecks = [
    ["rgb legacy syntax", "rgb(0, 0, 0)", "#ffffff"],
    ["rgb modern syntax", "rgb(0 0 0 / 100%)", "#ffffff"],
    ["hsl syntax", "hsl(0 0% 0%)", "white"],
    ["oklch syntax", "oklch(0% 0 0)", "white"],
    ["oklab syntax", "oklab(0 0 0)", "white"]
  ] as const;
  for (const [label, foreground, background] of colorChecks) {
    const ratio = service.contrastRatio(foreground, background, "#ffffff");
    if (ratio < 20) {
      throw new Error(`Registry WCAG parser should support ${label}; got ratio ${ratio.toFixed(2)}.`);
    }
  }
  const transparentRatio = service.contrastRatio("transparent", "white", "white");
  if (transparentRatio !== 1) {
    throw new Error(`Transparent foreground should blend to the background; got ratio ${transparentRatio.toFixed(2)}.`);
  }

  const negativeRoot = resolve(process.cwd(), "..", "..", ".local-runtime", "html-ppt-v2", "registry-negative-fixtures");
  await assertMissingFxFails({ skillRoot, targetRoot: join(negativeRoot, "missing-fx") });
  await assertMissingAnimationFails({ skillRoot, targetRoot: join(negativeRoot, "missing-animation") });
  await assertMissingTemplateThumbnailFails({ skillRoot, targetRoot: join(negativeRoot, "missing-template-thumbnail") });

  console.log([
    "HTML-PPT v2 skill registry verification passed.",
    `layouts=${parsed.layouts.length}`,
    `themes=${parsed.themes.length}`,
    `donors=${parsed.donors.length}`,
    `animations=${parsed.animations.length}`,
    `fx=${parsed.fx.length}`,
    `hash=${parsed.hash.slice(0, 12)}`
  ].join(" "));
  console.log(`HTML-PPT v2 renderable layout contracts: ${layoutContractReport.map(formatLayoutContractReport).join("; ")}`);
  console.log(`HTML-PPT v2 donor guard coverage: ${donorGuardReport.map(formatDonorGuardReport).join("; ")}`);
}

type LayoutContractReportItem = {
  id: string;
  roles: number;
  density: string;
  axis: string;
  requiredSlots: number;
  optionalSlots: number;
  primitives: number;
  fallbackLayouts: number;
  weakCategories: string[];
};

function buildLayoutContractReport(layouts: LayoutCatalogItem[]): LayoutContractReportItem[] {
  const layoutById = new Map(layouts.map((layout) => [layout.id, layout]));
  return RENDERABLE_LAYOUT_IDS.map((id) => {
    const layout = layoutById.get(id);
    if (!layout) {
      return {
        id,
        roles: 0,
        density: "missing",
        axis: "missing",
        requiredSlots: 0,
        optionalSlots: 0,
        primitives: 0,
        fallbackLayouts: 0,
        weakCategories: ["missing"]
      };
    }
    const weakCategories: string[] = [];
    if (!layout.contract.roleFit.length) weakCategories.push("roles");
    if (!layout.contract.requiredSlots.length) weakCategories.push("required-slots");
    if (!layout.contract.primitives.length) weakCategories.push("primitives");
    if (layout.contract.capacity.maxCards === undefined && layout.contract.capacity.maxBullets === undefined && layout.contract.capacity.maxMetrics === undefined) {
      weakCategories.push("capacity");
    }
    if (!layout.contract.fallbackLayouts.every((fallback) => layoutById.has(fallback))) {
      weakCategories.push("fallbacks");
    }
    return {
      id,
      roles: layout.contract.roleFit.length,
      density: `${layout.contract.density.preferred}/${layout.contract.density.supported.join("|")}`,
      axis: layout.contract.axis,
      requiredSlots: layout.contract.requiredSlots.length,
      optionalSlots: layout.contract.optionalSlots.length,
      primitives: layout.contract.primitives.length,
      fallbackLayouts: layout.contract.fallbackLayouts.length,
      weakCategories
    };
  });
}

function formatLayoutContractReport(item: LayoutContractReportItem): string {
  return [
    item.id,
    `roles=${item.roles}`,
    `density=${item.density}`,
    `axis=${item.axis}`,
    `requiredSlots=${item.requiredSlots}`,
    `optionalSlots=${item.optionalSlots}`,
    `primitives=${item.primitives}`,
    `fallbacks=${item.fallbackLayouts}`,
    `weak=${item.weakCategories.length ? item.weakCategories.join("|") : "none"}`
  ].join(",");
}

type DonorGuardReportItem = {
  id: string;
  textGuards: number;
  classCssGuards: number;
  totalGuards: number;
  indexTextChars: number;
  styleClassCount: number;
  weakCategories: string[];
};

async function buildDonorGuardReport(donors: DonorCatalogItem[]): Promise<DonorGuardReportItem[]> {
  const reports = await Promise.all(donors.map(async (donor) => {
    const [indexHtml, styleCss] = await Promise.all([
      readFile(join(donor.dir, "index.html"), "utf8"),
      readFile(join(donor.dir, "style.css"), "utf8")
    ]);
    const counts = countDonorContractGuards(donor.contract);
    const indexTextChars = extractTextContent(indexHtml).length;
    const styleClassCount = extractClassSelectors(styleCss).size;
    const weakCategories: string[] = [];
    if (indexTextChars > 0 && counts.textGuards === 0 && !counts.textGuardsExempted) {
      weakCategories.push("text");
    }
    if (styleClassCount > 0 && counts.classCssGuards === 0 && !counts.classCssGuardsExempted) {
      weakCategories.push("class-css");
    }
    return {
      id: donor.id,
      textGuards: counts.textGuards,
      classCssGuards: counts.classCssGuards,
      totalGuards: counts.totalGuards,
      indexTextChars,
      styleClassCount,
      weakCategories
    };
  }));
  return reports.sort((a, b) => a.id.localeCompare(b.id));
}

function formatDonorGuardReport(item: DonorGuardReportItem): string {
  return [
    item.id,
    `text=${item.textGuards}`,
    `classCss=${item.classCssGuards}`,
    `total=${item.totalGuards}`,
    `indexChars=${item.indexTextChars}`,
    `styleClasses=${item.styleClassCount}`,
    `weak=${item.weakCategories.length ? item.weakCategories.join("|") : "none"}`
  ].join(",");
}

function extractTextContent(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractClassSelectors(css: string): Set<string> {
  const classes = new Set<string>();
  for (const match of css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)\b/g)) {
    if (match[1]) classes.add(match[1]);
  }
  return classes;
}

async function assertMissingTemplateThumbnailFails(input: { skillRoot: string; targetRoot: string }) {
  await rm(input.targetRoot, { recursive: true, force: true });
  await cp(input.skillRoot, input.targetRoot, { recursive: true });
  const templateDir = join(input.targetRoot, "templates", "full-decks", "product-launch");
  const templatePackage = JSON.parse(await readFile(join(templateDir, "template-package.json"), "utf8")) as { thumbnailFile: string };
  await rm(join(templateDir, templatePackage.thumbnailFile), { force: true });
  const service = new SkillRegistryService();
  service.clearCache();
  try {
    await service.hydrate(input.targetRoot);
  } catch (error) {
    if (String(error).includes("Template package 'product-launch' thumbnailFile is missing")) return;
    throw error;
  }
  throw new Error("Registry hydration should fail when a template package thumbnailFile does not exist.");
}

async function assertMissingFxFails(input: { skillRoot: string; targetRoot: string }) {
  await rm(input.targetRoot, { recursive: true, force: true });
  await cp(input.skillRoot, input.targetRoot, { recursive: true });
  await rm(join(input.targetRoot, "assets", "animations", "fx", "gradient-blob.js"), { force: true });
  const service = new SkillRegistryService();
  service.clearCache();
  try {
    await service.hydrate(input.targetRoot);
  } catch (error) {
    if (String(error).includes("FX 'soft-glow' source file is missing")) return;
    throw error;
  }
  throw new Error("Registry hydration should fail when a mapped FX source file is missing.");
}

async function assertMissingAnimationFails(input: { skillRoot: string; targetRoot: string }) {
  await rm(input.targetRoot, { recursive: true, force: true });
  await cp(input.skillRoot, input.targetRoot, { recursive: true });
  const animationCssPath = join(input.targetRoot, "assets", "animations", "animations.css");
  const css = await readFile(animationCssPath, "utf8");
  await writeFile(animationCssPath, css.replace(/\.anim-fade-up\b/g, ".anim-fade-up-missing"), "utf8");
  const service = new SkillRegistryService();
  service.clearCache();
  try {
    await service.hydrate(input.targetRoot);
  } catch (error) {
    if (String(error).includes("animations.css is missing renderer-supported animation classes")) return;
    throw error;
  }
  throw new Error("Registry hydration should fail when a renderer-supported animation class is missing.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
