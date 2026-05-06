import { resolve } from "node:path";
import { runDesignStage, runEvidenceStage, runIntentStage, runLayoutPlanStage, runNarrativeStage } from "../stages";
import { hydrateHtmlPptV2SkillRegistry, resolveTemplatePackageSelection, type SkillRegistry, type TemplatePackage } from "../registry";
import type { LayoutPlanIR, NarrativeIR, RenderableLayoutId, SlideRoleId } from "../ir";

async function main() {
  const workspaceRoot = resolve(process.cwd(), "..", "..");
  const registry = await hydrateHtmlPptV2SkillRegistry(resolve(workspaceRoot, ".agents", "skills", "html-ppt"));
  assertTemplateResolution(registry);
  assertTemplateLayoutDna(registry);
  const intent = (await runIntentStage({
    userPrompt: "制作一个10页HTML PPT，主题为中国新能源车产业出海，约1500字，面向企业管理层。"
  })).intent;
  const evidence = (await runEvidenceStage({ intent })).evidence;
  const narrative = (await runNarrativeStage({ intent, evidence })).narrative;

  for (const template of registry.templatePackages) {
    const designResult = await runDesignStage({
      intent,
      evidence,
      narrative,
      registry,
      pinnedTemplate: template
    });
    if (designResult.source !== "pinned" || designResult.attempts !== 0) {
      throw new Error(`Template '${template.id}' should pin design without model attempts.`);
    }
    if (designResult.design.donorTemplateId !== template.donorTemplateId || designResult.design.themeId !== template.themeId) {
      throw new Error(`Template '${template.id}' did not lock donor/theme from template package.`);
    }

    const layoutResult = await runLayoutPlanStage({
      intent,
      narrative,
      design: designResult.design,
      registry,
      pinnedTemplate: template
    });
    if (layoutResult.source !== "pinned" || layoutResult.attempts !== 0) {
      throw new Error(`Template '${template.id}' should pin layout without model attempts.`);
    }
    assertLayoutPolicy(template, narrative, layoutResult.layoutPlan);
  }

  console.log(`HTML-PPT v2 template pinning verification passed. templates=${registry.templatePackages.length}`);
}

function assertTemplateResolution(registry: SkillRegistry) {
  const auto = resolveTemplatePackageSelection(registry, "auto");
  const legacyAuto = resolveTemplatePackageSelection(registry, "html-ppt-v2");
  const known = resolveTemplatePackageSelection(registry, registry.templatePackages[0]?.id);
  const unknown = resolveTemplatePackageSelection(registry, "not-a-real-template");

  if (auto.kind !== "auto" || legacyAuto.kind !== "auto") {
    throw new Error("Template resolution must keep auto/html-ppt-v2 on the Auto path.");
  }
  if (known.kind !== "pinned" || known.template.id !== registry.templatePackages[0]?.id) {
    throw new Error("Template resolution must resolve known template IDs to pinned packages.");
  }
  if (unknown.kind !== "unknown" || unknown.templateId !== "not-a-real-template") {
    throw new Error("Template resolution must reject unknown non-auto template IDs instead of falling back to Auto.");
  }
}

function assertTemplateLayoutDna(registry: SkillRegistry) {
  const dnaLayouts = new Set<RenderableLayoutId>([
    "bullet-list",
    "process",
    "stat-highlight",
    "quote",
    "image-hero"
  ]);
  const signatures = new Map<string, string[]>();

  for (const template of registry.templatePackages) {
    const bodyLayouts = template.layoutPolicy.body;
    if (bodyLayouts.length < 4) {
      throw new Error(`Template '${template.id}' should pin at least 4 body layouts to avoid generic deck repetition.`);
    }
    if (!bodyLayouts.some((layoutId) => dnaLayouts.has(layoutId))) {
      throw new Error(`Template '${template.id}' body layout policy must include at least one promoted layout-DNA renderer.`);
    }
    const signature = bodyLayouts.join("/");
    signatures.set(signature, [...(signatures.get(signature) ?? []), template.id]);
  }

  const productLaunch = registry.templatePackages.find((template) => template.id === "product-launch");
  const expectedProductLaunchPolicy: RenderableLayoutId[] = ["image-hero", "stat-highlight", "comparison", "process", "kpi-grid"];
  if (!productLaunch || JSON.stringify(productLaunch.layoutPolicy.body) !== JSON.stringify(expectedProductLaunchPolicy)) {
    throw new Error(`Product Launch template must pin a launch-specific body policy: ${expectedProductLaunchPolicy.join("/")}.`);
  }

  const repeatedSignatures = [...signatures.entries()].filter(([, templateIds]) => templateIds.length > 1);
  const allowedRepeats = new Set(["xhs-pastel-card,xhs-post"]);
  for (const [, templateIds] of repeatedSignatures) {
    const key = templateIds.sort().join(",");
    if (!allowedRepeats.has(key)) {
      throw new Error(`Template body layout policy should not collapse to repeated generic signatures: ${templateIds.join(", ")}.`);
    }
  }
}

function assertLayoutPolicy(template: TemplatePackage, narrative: NarrativeIR, layoutPlan: LayoutPlanIR) {
  const bySlide = new Map(layoutPlan.map((item) => [item.slideIndex, item.layoutId]));
  let bodyOrdinal = 0;
  for (const slide of narrative.slides) {
    const actual = bySlide.get(slide.index);
    const expected = expectedLayoutForRole(template, slide.role, bodyOrdinal);
    if (!["cover", "toc", "cta", "thanks"].includes(slide.role)) {
      bodyOrdinal += 1;
    }
    if (actual !== expected) {
      throw new Error(`Template '${template.id}' slide ${slide.index} expected '${expected}' for role '${slide.role}', got '${actual}'.`);
    }
  }
}

function expectedLayoutForRole(template: TemplatePackage, role: SlideRoleId, bodyOrdinal: number): RenderableLayoutId {
  if (role === "cover" || role === "hook") return template.layoutPolicy.cover;
  if (role === "toc") return template.layoutPolicy.toc;
  if (role === "cta" || role === "thanks") return template.layoutPolicy.closing;
  return template.layoutPolicy.body[bodyOrdinal % template.layoutPolicy.body.length]!;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
