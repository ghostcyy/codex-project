import { ANIMATION_IDS, type RenderableLayoutId } from "../ir";
import { coreLayoutPackageById } from "./layout-packages";

export type StaticClassCoverageIssue = {
  scope: "document" | "section";
  className: string;
  slideIndex?: number;
  layoutId?: string;
};

export type StaticClassCoverageReport = {
  allClasses: string[];
  unknownClasses: StaticClassCoverageIssue[];
};

const GLOBAL_CLASSES = new Set([
  "deck-viewport",
  "deck",
  "deck-status",
  "deck-progress",
  "deck-progress-bar",
  "slide",
  "is-active",
  ...ANIMATION_IDS.filter((id) => id !== "none").map((id) => `anim-${id}`)
]);

export function checkStaticClassCoverage(input: { html: string; deckClass: string }): StaticClassCoverageReport {
  const allClasses = [...collectClassTokens(input.html)].sort();
  const globallyAllowed = new Set<string>([...GLOBAL_CLASSES, input.deckClass]);
  const sectionIssues = checkSectionClassCoverage(input.html, globallyAllowed);
  const packageAllowed = collectPackageAllowedClasses();
  const documentIssues: StaticClassCoverageIssue[] = allClasses
    .filter((className) => !globallyAllowed.has(className) && !packageAllowed.has(className) && !isAllowedDynamicClass(className))
    .map((className) => ({ scope: "document" as const, className }));

  const seen = new Set<string>();
  const unknownClasses = [...documentIssues, ...sectionIssues].filter((issue) => {
    const key = `${issue.scope}:${issue.slideIndex ?? ""}:${issue.layoutId ?? ""}:${issue.className}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });

  return { allClasses, unknownClasses };
}

function checkSectionClassCoverage(html: string, globallyAllowed: Set<string>): StaticClassCoverageIssue[] {
  const issues: StaticClassCoverageIssue[] = [];
  const sectionPattern = /<section\b[\s\S]*?<\/section>/gi;
  const sections = html.match(sectionPattern) ?? [];

  for (const sectionHtml of sections) {
    const layoutId = readAttr(sectionHtml, "data-layoutid");
    const slideIndex = Number(readAttr(sectionHtml, "data-slide-index"));
    const layoutPackage = isCoreLayoutId(layoutId) ? coreLayoutPackageById.get(layoutId) : undefined;
    const allowed = new Set([...(layoutPackage?.allowedClasses ?? []), ...globallyAllowed]);

    for (const className of collectClassTokens(sectionHtml)) {
      if (!allowed.has(className) && !isAllowedDynamicClass(className)) {
        issues.push({
          scope: "section",
          className,
          slideIndex: Number.isFinite(slideIndex) ? slideIndex : undefined,
          layoutId: layoutId || undefined
        });
      }
    }
  }

  return issues;
}

function collectClassTokens(html: string): Set<string> {
  const classes = new Set<string>();
  const classAttrPattern = /\bclass=(["'])(.*?)\1/gi;
  let match: RegExpExecArray | null;

  while ((match = classAttrPattern.exec(html))) {
    const raw = match[2] ?? "";
    for (const token of raw.split(/\s+/)) {
      const className = token.trim();
      if (className) {
        classes.add(className);
      }
    }
  }

  return classes;
}

function collectPackageAllowedClasses(): Set<string> {
  const allowed = new Set<string>();
  for (const layoutPackage of coreLayoutPackageById.values()) {
    for (const className of layoutPackage.allowedClasses) {
      allowed.add(className);
    }
  }
  return allowed;
}

function isAllowedDynamicClass(className: string): boolean {
  return className.startsWith("donor-") || className.startsWith("dna-");
}

function readAttr(html: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b${escapedName}=(["'])(.*?)\\1`, "i");
  return pattern.exec(html)?.[2] ?? "";
}

function isCoreLayoutId(value: string): value is RenderableLayoutId {
  return coreLayoutPackageById.has(value as RenderableLayoutId);
}
