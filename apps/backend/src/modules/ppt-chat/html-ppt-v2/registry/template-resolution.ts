import type { SkillRegistry, TemplatePackage } from "./registry.schemas";

export type TemplatePackageResolution =
  | { kind: "auto"; templateId: null; template: undefined }
  | { kind: "pinned"; templateId: string; template: TemplatePackage }
  | { kind: "unknown"; templateId: string; template: undefined };

export function normalizeTemplatePackageId(value: unknown): string | null {
  const templateId = typeof value === "string" ? value.trim() : "";
  if (!templateId || templateId === "auto" || templateId === "html-ppt-v2") {
    return null;
  }
  return templateId;
}

export function resolveTemplatePackageSelection(
  registry: Pick<SkillRegistry, "templatePackages">,
  value: unknown
): TemplatePackageResolution {
  const templateId = normalizeTemplatePackageId(value);
  if (!templateId) {
    return { kind: "auto", templateId: null, template: undefined };
  }

  const template = registry.templatePackages.find((item) => item.id === templateId);
  if (!template) {
    return { kind: "unknown", templateId, template: undefined };
  }

  return { kind: "pinned", templateId, template };
}
