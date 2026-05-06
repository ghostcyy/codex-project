import { access, readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { parseDocument } from "htmlparser2";
import { selectAll, selectOne } from "css-select";
import type { ChildNode, Element } from "domhandler";
import {
  AUDIO_PAGE_TYPES,
  IMAGE_PAGE_TYPES,
  VIDEO_PAGE_TYPES,
  templateManifestV2Schema,
  type PageFragment,
  type TemplateManifestV2
} from "../shared";
import { detectMediaKinds } from "./media-kind-detector";

export type ManifestV2ValidationResult =
  | { ok: true; manifest: TemplateManifestV2 }
  | { ok: false; reasons: string[] };

export async function parseManifestV2Json(raw: string): Promise<ManifestV2ValidationResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reasons: [`manifest-v2.json is not valid JSON: ${formatError(error)}`] };
  }

  const schemaResult = templateManifestV2Schema.safeParse(parsed);
  if (!schemaResult.success) {
    return {
      ok: false,
      reasons: schemaResult.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    };
  }

  return { ok: true, manifest: schemaResult.data };
}

export async function validateManifestV2Files(
  manifest: TemplateManifestV2,
  templateDir: string
): Promise<{ ok: true } | { ok: false; reasons: string[] }> {
  const reasons: string[] = [];

  await assertReadable(join(templateDir, manifest.shellHtmlFile), reasons, `shellHtmlFile '${manifest.shellHtmlFile}'`);
  for (const cssFile of manifest.cssFiles) {
    await assertReadable(join(templateDir, cssFile), reasons, `cssFile '${cssFile}'`);
  }
  for (const jsFile of manifest.jsFiles) {
    await assertReadable(join(templateDir, jsFile), reasons, `jsFile '${jsFile}'`);
  }
  for (const assetDir of manifest.assetDirs) {
    await assertReadable(join(templateDir, assetDir), reasons, `assetDir '${assetDir}'`);
  }

  const pool = manifest.pool as Record<string, PageFragment>;
  const fragments: Array<readonly [string, PageFragment]> = [
    ["fixed.cover", manifest.fixed.cover] as const,
    ["fixed.closing", manifest.fixed.closing] as const,
    ...Object.entries(pool).map(([key, fragment]) => [`pool.${key}`, fragment] as const)
  ];

  const shellPath = join(templateDir, manifest.shellHtmlFile);
  try {
    const shell = await readFile(shellPath, "utf8");
    const slideMarkers = countOccurrences(shell, "<!-- SLIDES -->");
    if (slideMarkers !== 1) {
      reasons.push(`${manifest.shellHtmlFile} must contain exactly one <!-- SLIDES --> marker; got ${slideMarkers}.`);
    }
  } catch {
    // Already reported by assertReadable.
  }

  await validateDeckEffects(manifest, templateDir, reasons);
  await validateFragmentsPreserveSourceLayout(manifest, templateDir, reasons);

  for (const [location, fragment] of fragments) {
    validateFragmentMetadata(location, fragment, reasons);
    await validateFragmentFile(location, fragment, templateDir, reasons);
  }

  validateCapabilitiesMatchMediaKinds(manifest, reasons);

  if (!manifest.capabilities.hasAudioPages && Object.values(pool).some((fragment) => AUDIO_PAGE_TYPES.includes(fragment.pageType) || fragment.mediaKinds.includes("audio"))) {
    reasons.push("capabilities.hasAudioPages=false but pool exposes audio fragment(s).");
  }
  if (!manifest.capabilities.hasImagePages && Object.values(pool).some((fragment) => IMAGE_PAGE_TYPES.includes(fragment.pageType) || fragment.mediaKinds.includes("image"))) {
    reasons.push("capabilities.hasImagePages=false but pool exposes image fragment(s).");
  }
  if (!manifest.capabilities.hasVideoPages && Object.values(pool).some((fragment) => VIDEO_PAGE_TYPES.includes(fragment.pageType) || fragment.mediaKinds.includes("video"))) {
    reasons.push("capabilities.hasVideoPages=false but pool exposes video fragment(s).");
  }

  return reasons.length ? { ok: false, reasons } : { ok: true };
}

async function validateFragmentsPreserveSourceLayout(
  manifest: TemplateManifestV2,
  templateDir: string,
  reasons: string[]
) {
  const indexHtml = await readFile(join(templateDir, "index.html"), "utf8").catch(() => "");
  if (!indexHtml) return;
  const sourceSections = extractSourceSections(indexHtml);
  const fragments: PageFragment[] = [
    manifest.fixed.cover,
    manifest.fixed.closing,
    ...Object.values(manifest.pool as Record<string, PageFragment>)
  ];

  for (const fragment of fragments) {
    const sourceHtml = sourceSections[fragment.sourceSlideIndex - 1] ?? "";
    if (!sourceHtml) continue;
    const expectedClasses = collectKeyLayoutClasses(sourceHtml);
    if (!expectedClasses.length) continue;

    const fragmentHtml = await readFile(join(templateDir, normalize(fragment.htmlFile)), "utf8").catch(() => "");
    const actualClasses = collectKeyLayoutClasses(fragmentHtml);
    for (const className of expectedClasses) {
      if (!actualClasses.includes(className)) {
        reasons.push(`${fragment.htmlFile} must preserve source layout class '${className}' from slide ${fragment.sourceSlideIndex}.`);
      }
    }
  }
}

function extractSourceSections(indexHtml: string) {
  return [...indexHtml.matchAll(/<section\b(?=[^>]*\bclass=["'][^"']*\bslide\b[^"']*["'])[\s\S]*?<\/section>/gi)].map((match) => match[0] ?? "");
}

function collectKeyLayoutClasses(html: string) {
  if (!html) return [];
  const dom = parseDocument(html, { decodeEntities: false });
  const elements = selectAll("[class]", dom as unknown as ChildNode) as Element[];
  const classes = new Set<string>();
  for (const element of elements) {
    for (const className of (element.attribs?.class ?? "").split(/\s+/).filter(Boolean)) {
      if (/^(?:layout-|grid-layout-)/.test(className)) classes.add(className);
    }
  }
  return [...classes].sort();
}

async function validateDeckEffects(manifest: TemplateManifestV2, templateDir: string, reasons: string[]) {
  const indexHtml = await readFile(join(templateDir, "index.html"), "utf8").catch(() => "");
  const expectedElementIds = extractDeckLevelEffectIds(indexHtml);
  const deckEffects = manifest.deckEffects;

  if (expectedElementIds.length && !deckEffects) {
    reasons.push(`deckEffects is required because source index.html has deck-level effect element(s): ${expectedElementIds.join(", ")}.`);
    return;
  }
  if (!deckEffects) return;

  for (const elementId of expectedElementIds) {
    if (!deckEffects.elementIds.includes(elementId)) {
      reasons.push(`deckEffects.elementIds must include '${elementId}'.`);
    }
  }

  let shell = "";
  try {
    shell = await readFile(join(templateDir, manifest.shellHtmlFile), "utf8");
  } catch {
    // Already reported by assertReadable.
  }

  if (deckEffects.htmlFile) {
    const html = await readFile(join(templateDir, normalize(deckEffects.htmlFile)), "utf8").catch(() => "");
    if (!html) {
      reasons.push(`deckEffects.htmlFile does not exist: ${deckEffects.htmlFile}`);
    } else {
      for (const elementId of deckEffects.elementIds) {
        if (!html.includes(`id="${elementId}"`) && !html.includes(`id='${elementId}'`)) {
          reasons.push(`deckEffects.htmlFile must contain element id '${elementId}'.`);
        }
      }
    }
  }

  if (shell) {
    for (const elementId of deckEffects.elementIds) {
      if (!shell.includes(`id="${elementId}"`) && !shell.includes(`id='${elementId}'`)) {
        reasons.push(`shell.html must preserve deckEffects element id '${elementId}'.`);
      }
    }
    if (deckEffects.jsFile && !shell.includes(deckEffects.jsFile)) {
      reasons.push(`shell.html must reference deckEffects.jsFile '${deckEffects.jsFile}'.`);
    }
  }

  if (deckEffects.jsFile) {
    const js = await readFile(join(templateDir, normalize(deckEffects.jsFile)), "utf8").catch(() => "");
    if (!js) {
      reasons.push(`deckEffects.jsFile does not exist: ${deckEffects.jsFile}`);
    } else if (/createChart\s*\(|getElementById\(["'](?:lineChart|pieChart|barChart|ganttChart)["']\)/i.test(js)) {
      reasons.push("deckEffects.jsFile must not contain legacy chart initialization.");
    }
  }
}

function extractDeckLevelEffectIds(indexHtml: string) {
  if (!indexHtml) return [];
  const dom = parseDocument(indexHtml, { decodeEntities: false });
  const nodes = selectAll("body > canvas[id], .deck > canvas[id]", dom as unknown as ChildNode) as Element[];
  return nodes
    .map((node) => node.attribs?.id)
    .filter((id): id is string => Boolean(id));
}

function validateFragmentMetadata(location: string, fragment: PageFragment, reasons: string[]) {
  const locationKey = location.split(".").at(-1);
  if (locationKey && fragment.fragmentId && location.startsWith("pool.") && fragment.fragmentId !== locationKey) {
    reasons.push(`${location}.fragmentId must equal pool key '${locationKey}'.`);
  }
  if (!fragment.pagePortrait?.summary || !fragment.pagePortrait.componentSignature) {
    reasons.push(`${location}.pagePortrait must include summary and componentSignature.`);
  }
  if (location === "fixed.cover" && fragment.pageType !== "cover") {
    reasons.push("fixed.cover.pageType must be 'cover'.");
  }
  if (location === "fixed.closing" && fragment.pageType !== "closing") {
    reasons.push("fixed.closing.pageType must be 'closing'.");
  }
  if (location.startsWith("pool.") && (fragment.pageType === "cover" || fragment.pageType === "closing")) {
    reasons.push(`${location} must not expose fixed pageType '${fragment.pageType}' in pool.`);
  }
  for (const anchor of fragment.anchors) {
    if (typeof anchor.tarChars !== "number") {
      reasons.push(`${location}.anchors.${anchor.slotId}.tarChars is required in generated manifest-v2.json.`);
      continue;
    }
    const expectedTarChars = Math.ceil(anchor.maxChars / 2);
    if (anchor.tarChars !== expectedTarChars) {
      reasons.push(`${location}.anchors.${anchor.slotId}.tarChars must equal ceil(maxChars / 2) (${expectedTarChars}).`);
    }
  }
}

async function validateFragmentFile(
  location: string,
  fragment: PageFragment,
  templateDir: string,
  reasons: string[]
) {
  const htmlPath = join(templateDir, normalize(fragment.htmlFile));
  let html: string;
  try {
    html = await readFile(htmlPath, "utf8");
  } catch {
    reasons.push(`${location}.htmlFile does not exist: ${fragment.htmlFile}`);
    return;
  }

  const dom = parseDocument(html);
  const sections = selectAll("section.slide", dom as unknown as ChildNode) as Element[];
  if (sections.length !== 1) {
    reasons.push(`${location} must contain exactly one section.slide; got ${sections.length}.`);
    return;
  }

  const section = sections[0]!;
  const pageType = section.attribs?.["data-page-type"];
  if (pageType !== fragment.pageType) {
    reasons.push(`${location} section data-page-type must be '${fragment.pageType}', got '${pageType ?? ""}'.`);
  }

  if (selectOne("html, head, script", section as unknown as ChildNode)) {
    reasons.push(`${location} fragment must not contain html/head/script tags.`);
  }

  for (const anchor of fragment.anchors) {
    const matches = selectAll(anchor.selector, section as unknown as ChildNode);
    if (matches.length !== 1) {
      reasons.push(`${location} anchor '${anchor.slotId}' selector '${anchor.selector}' must match exactly one element; got ${matches.length}.`);
    }
  }

  if (fragment.pageType === "chart" || fragment.mediaKinds.includes("chart")) {
    if (fragment.chartCanvasSelector) {
      const matches = selectAll(fragment.chartCanvasSelector, section as unknown as ChildNode);
      if (matches.length !== 1) {
        reasons.push(`${location} chartCanvasSelector '${fragment.chartCanvasSelector}' must match exactly one canvas; got ${matches.length}.`);
      }
    }
    if (!fragment.chartSlots?.length) {
      reasons.push(`${location} chart fragment must declare at least one chartSlots entry.`);
    }
    for (const slot of fragment.chartSlots ?? []) {
      const slotMatches = selectAll(slot.selector, section as unknown as ChildNode);
      if (slotMatches.length !== 1) {
        reasons.push(`${location} chartSlots '${slot.slotId}' selector '${slot.selector}' must match exactly one canvas; got ${slotMatches.length}.`);
      }
    }
  }

  validateFragmentMediaKinds(location, fragment, section, html, reasons);

  for (const selector of fragment.imageSlotSelectors) {
    const matches = selectAll(selector, section as unknown as ChildNode);
    if (matches.length !== 1) {
      reasons.push(`${location} image slot selector '${selector}' must match exactly one img; got ${matches.length}.`);
    }
  }

  if (fragment.videoSlotSelector) {
    const matches = selectAll(fragment.videoSlotSelector, section as unknown as ChildNode);
    if (matches.length !== 1) {
      reasons.push(`${location} videoSlotSelector '${fragment.videoSlotSelector}' must match exactly one video; got ${matches.length}.`);
    }
  }
}

function validateFragmentMediaKinds(
  location: string,
  fragment: PageFragment,
  section: Element,
  html: string,
  reasons: string[]
) {
  const detectedKinds = detectMediaKinds(html);
  for (const mediaKind of detectedKinds) {
    if (!fragment.mediaKinds.includes(mediaKind)) {
      reasons.push(`${location} contains ${mediaKind} media DOM but mediaKinds does not include '${mediaKind}'.`);
    }
  }
  for (const mediaKind of fragment.mediaKinds) {
    if (!detectedKinds.includes(mediaKind)) {
      reasons.push(`${location} declares mediaKinds '${mediaKind}' but no matching media DOM was detected.`);
    }
  }

  if (fragment.mediaKinds.includes("image")) {
    if (!detectedKinds.includes("image")) {
      reasons.push(`${location} declares image media but no image DOM/style reference was detected.`);
    }
  }
  if (fragment.mediaKinds.includes("chart")) {
    const selectors = fragment.chartSlots?.length
      ? fragment.chartSlots.map((slot) => slot.selector)
      : [fragment.chartCanvasSelector ?? "canvas[data-chart-slot='primary']"];
    if (!selectors.some((selector) => selectAll(selector, section as unknown as ChildNode).length > 0)) {
      reasons.push(`${location} declares chart media but no chart slot selector matches a canvas.`);
    }
  }
  if (fragment.mediaKinds.includes("video")) {
    if (fragment.videoSlotSelector) {
      const videos = selectAll(fragment.videoSlotSelector, section as unknown as ChildNode);
      if (!videos.length) reasons.push(`${location} declares video media but videoSlotSelector did not match.`);
    }
    if (!detectedKinds.includes("video")) {
      reasons.push(`${location} declares video media but no video DOM or video-like playback UI was detected.`);
    }
  }
}

function validateCapabilitiesMatchMediaKinds(manifest: TemplateManifestV2, reasons: string[]) {
  const fragments = Object.values(manifest.pool as Record<string, PageFragment>);
  const hasImage = fragments.some((fragment) => fragment.mediaKinds.includes("image"));
  const hasVideo = fragments.some((fragment) => fragment.mediaKinds.includes("video"));
  const hasAudio = fragments.some((fragment) => fragment.mediaKinds.includes("audio"));
  const hasChart = fragments.some((fragment) => fragment.mediaKinds.includes("chart"));
  if (manifest.capabilities.hasImagePages !== hasImage) {
    reasons.push(`capabilities.hasImagePages must equal pool mediaKinds image presence (${hasImage}).`);
  }
  if (manifest.capabilities.hasVideoPages !== hasVideo) {
    reasons.push(`capabilities.hasVideoPages must equal pool mediaKinds video presence (${hasVideo}).`);
  }
  if (manifest.capabilities.hasAudioPages !== hasAudio) {
    reasons.push(`capabilities.hasAudioPages must equal pool mediaKinds audio presence (${hasAudio}).`);
  }
  if (hasChart && manifest.capabilities.chartTypes.length === 0) {
    reasons.push("capabilities.chartTypes must be non-empty when any pool fragment declares chart media.");
  }
  if (!hasChart && manifest.capabilities.chartTypes.length > 0) {
    reasons.push("capabilities.chartTypes must be empty when no pool fragment declares chart media.");
  }
}

async function assertReadable(path: string, reasons: string[], label: string) {
  try {
    await access(path);
  } catch {
    reasons.push(`${label} does not exist: ${path}`);
  }
}

function countOccurrences(value: string, needle: string) {
  return value.split(needle).length - 1;
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
