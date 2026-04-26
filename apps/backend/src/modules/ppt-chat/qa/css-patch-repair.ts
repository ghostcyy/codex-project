import postcss from "postcss";
import type { ConsistencyFinding } from "./qa-types";

export const QA_PATCH_SENTINEL = "/* layer-4 consistency patch v1 */";

export type CssPatchInstruction = {
  slideIndex: number;
  role: string;
  property: ConsistencyFinding["property"];
  currentValue: number | string;
  canonicalValue: number | string;
  selector: string;
  message: string;
};

export function buildCssPatchInstructions(findings: ConsistencyFinding[]) {
  const instructions: CssPatchInstruction[] = [];
  for (const finding of findings) {
    for (const outlier of finding.outliers) {
      instructions.push({
        slideIndex: outlier.slideIndex,
        role: outlier.role,
        property: finding.property,
        currentValue: outlier.value,
        canonicalValue: finding.canonical,
        selector: outlier.nodeSelector,
        message: `slide ${outlier.slideIndex}, ${outlier.role}, ${finding.property}, current=${String(outlier.value)}, canonical=${String(finding.canonical)}`
      });
    }
  }
  return dedupeInstructions(instructions).slice(0, 12);
}

export function appendCssPatch(styleCss: string, patchCss: string) {
  const trimmedPatch = patchCss.trim();
  if (!trimmedPatch) return styleCss;
  return `${styleCss.trimEnd()}\n\n${QA_PATCH_SENTINEL}\n${trimmedPatch}\n`;
}

export function stripAppendedCssPatch(styleCss: string) {
  const markerIndex = styleCss.lastIndexOf(QA_PATCH_SENTINEL);
  if (markerIndex < 0) return styleCss;
  return styleCss.slice(0, markerIndex).trimEnd();
}

export function validateCssPatchOutput(input: {
  css: string;
  deckClass: string;
  maxRuleCount: number;
  sanitize: (css: string) => string;
}) {
  const sanitized = input.sanitize(input.css).trim();
  if (!sanitized) {
    return { ok: false as const, reason: "模型未返回有效 CSS patch。" };
  }

  let root;
  try {
    root = postcss.parse(sanitized);
  } catch (error) {
    return { ok: false as const, reason: `CSS patch 解析失败：${error instanceof Error ? error.message : String(error)}` };
  }

  const selectors: string[] = [];
  root.walkRules((rule) => {
    for (const selector of rule.selectors ?? []) selectors.push(selector.trim());
  });

  if (selectors.length === 0) {
    return { ok: false as const, reason: "CSS patch 没有任何规则。" };
  }
  if (selectors.length > Math.max(1, input.maxRuleCount)) {
    return { ok: false as const, reason: `CSS patch 规则数 ${selectors.length} 超过上限 ${input.maxRuleCount}。` };
  }

  for (const selector of selectors) {
    if (!selector.startsWith(`body.${input.deckClass} `)) {
      return { ok: false as const, reason: `CSS patch 选择器未作用域到 body.${input.deckClass}：${selector}` };
    }
    if (/\b(?:^|[\s>+~])(?:\.deck|\.progress-bar)\b/i.test(selector)) {
      return { ok: false as const, reason: `CSS patch 不允许操作 .deck 或 .progress-bar：${selector}` };
    }
    if (/body\.[\w-]+\s+\.slide(?:\s*$|[^\w-])/i.test(selector) && !/\.slide:nth-child\(\d+\)\s+/.test(selector)) {
      return { ok: false as const, reason: `CSS patch 必须定位到具体页和具体节点，不能只写裸 .slide：${selector}` };
    }
  }

  return { ok: true as const, css: sanitized };
}

function dedupeInstructions(instructions: CssPatchInstruction[]) {
  const seen = new Set<string>();
  return instructions.filter((instruction) => {
    const key = `${instruction.slideIndex}:${instruction.property}:${instruction.selector}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
