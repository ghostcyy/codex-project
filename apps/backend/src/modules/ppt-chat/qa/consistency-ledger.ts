import type { AgentPlan } from "../html-ppt-agent.types";
import type {
  ConsistencyFinding,
  ConsistencyLedger,
  ConsistencyOutlier,
  LedgerSample,
  SlideCascade,
  SlideCascadeNode,
  SlideTier
} from "./qa-types";

type RoleConfig = {
  role: string;
  propertyProfiles: Array<ConsistencyFinding["property"]>;
  matches: (node: SlideCascadeNode) => boolean;
};

const ROLE_CONFIGS: RoleConfig[] = [
  {
    role: "h1",
    propertyProfiles: ["h1.fontSize", "font.family", "text.color"],
    matches: (node) => hasClass(node, "h1")
  },
  {
    role: "h2",
    propertyProfiles: ["h2.fontSize", "font.family", "text.color"],
    matches: (node) => hasClass(node, "h2")
  },
  {
    role: "h3",
    propertyProfiles: ["h3.fontSize", "font.family", "text.color"],
    matches: (node) => hasClass(node, "h3")
  },
  {
    role: "kicker",
    propertyProfiles: ["kicker.fontSize", "font.family", "text.color"],
    matches: (node) => hasClass(node, "kicker") || hasClass(node, "eyebrow")
  },
  {
    role: "lede",
    propertyProfiles: ["lede.fontSize", "font.family", "text.color"],
    matches: (node) => hasClass(node, "lede")
  },
  {
    role: "metric-large",
    propertyProfiles: ["metric-large.fontSize", "font.family", "text.color"],
    matches: (node) => hasClass(node, "metric-large") || hasClass(node, "metric-number") || isMetricNumber(node)
  },
  {
    role: "metric-label",
    propertyProfiles: ["metric-label.fontSize", "font.family", "text.color"],
    matches: (node) => hasClass(node, "metric-label")
  },
  {
    role: "card",
    propertyProfiles: ["card.border", "card.borderRadius", "card.padding", "card.background"],
    matches: (node) => hasClass(node, "card")
  },
  {
    role: "card-soft",
    propertyProfiles: ["card.border", "card.borderRadius", "card.padding", "card.background"],
    matches: (node) => hasClass(node, "card-soft")
  },
  {
    role: "card-outline",
    propertyProfiles: ["card.border", "card.borderRadius", "card.padding", "card.background"],
    matches: (node) => hasClass(node, "card-outline")
  },
  {
    role: "card-accent",
    propertyProfiles: ["card.border", "card.borderRadius", "card.padding", "card.background"],
    matches: (node) => hasClass(node, "card-accent")
  },
  {
    role: "kpi-metric",
    propertyProfiles: ["card.border", "card.borderRadius", "card.padding", "card.background"],
    matches: (node) => hasClass(node, "metric") && node.path.includes(".kpi-grid")
  }
];

export function buildLedger(cascades: SlideCascade[], _plan: AgentPlan): ConsistencyLedger {
  const groups: Record<string, LedgerSample[]> = {};

  for (const slide of cascades) {
    for (const node of slide.nodes) {
      for (const config of ROLE_CONFIGS) {
        if (!config.matches(node)) continue;
        const sample: LedgerSample = {
          slideIndex: slide.slideIndex,
          layoutId: slide.layoutId,
          tier: slide.tier,
          nodeId: node.id,
          nodeSelector: node.path,
          role: config.role,
          fontSize: node.computed.fontSize,
          fontWeight: node.computed.fontWeight,
          fontFamily: node.computed.fontFamily,
          color: node.computed.color,
          lineHeight: node.computed.lineHeight,
          border: node.computed.border,
          borderWidth: node.computed.borderWidth,
          borderRadius: node.computed.borderRadius,
          paddingX: node.computed.paddingLeft + node.computed.paddingRight,
          paddingY: node.computed.paddingTop + node.computed.paddingBottom,
          background: node.computed.background ?? node.computed.backgroundColor
        };
        const groupKey = `${slide.tier}:${config.role}`;
        if (!groups[groupKey]) groups[groupKey] = [];
        groups[groupKey].push(sample);
      }
    }
  }

  return { groups };
}

export function detectOutliers(ledger: ConsistencyLedger): ConsistencyFinding[] {
  const findings: ConsistencyFinding[] = [];

  for (const [groupKey, samples] of Object.entries(ledger.groups)) {
    if (samples.length === 0) continue;
    const [, role] = groupKey.split(":");
    const config = ROLE_CONFIGS.find((item) => item.role === role);
    if (!config) continue;
    for (const property of config.propertyProfiles) {
      const next = detectPropertyOutliers(samples, property);
      if (next) findings.push(next);
    }
  }

  return findings;
}

function detectPropertyOutliers(samples: LedgerSample[], property: ConsistencyFinding["property"]): ConsistencyFinding | null {
  const values = samples
    .map((sample) => ({ sample, value: pickPropertyValue(sample, property) }))
    .filter((entry): entry is { sample: LedgerSample; value: number | string } => entry.value !== undefined && entry.value !== "");
  if (values.length < 2) return null;

  if (typeof values[0]?.value === "number") {
    if (values.length < 4) return null;
    const numericValues = values.map((entry) => Number(entry.value)).filter((entry) => Number.isFinite(entry)).sort((a, b) => a - b);
    if (numericValues.length < 4) return null;
    const canonical = median(numericValues);
    if (canonical === undefined) return null;
    const floor = canonical * 0.85;
    const ceiling = canonical * 1.15;
    const outliers = values
      .filter((entry) => {
        const numeric = Number(entry.value);
        return numeric < floor || numeric > ceiling;
      })
      .map((entry) => sampleToOutlier(entry.sample, Number(entry.value)));
    if (outliers.length === 0) return null;
    return { property, canonical: Number(canonical.toFixed(2)), outliers, severity: "warn" };
  }

  const canonical = majorityVote(values.map((entry) => String(entry.value).trim()).filter(Boolean));
  if (!canonical) return null;
  const confidence = values.filter((entry) => comparePropertyValue(property, String(entry.value), canonical)).length / values.length;
  if (confidence < 0.6) return null;
  const outliers = values
    .filter((entry) => !comparePropertyValue(property, String(entry.value), canonical))
    .map((entry) => sampleToOutlier(entry.sample, String(entry.value)));
  if (outliers.length === 0) return null;
  return { property, canonical, outliers, severity: "warn" };
}

function pickPropertyValue(sample: LedgerSample, property: ConsistencyFinding["property"]) {
  switch (property) {
    case "h1.fontSize":
    case "h2.fontSize":
    case "h3.fontSize":
    case "kicker.fontSize":
    case "lede.fontSize":
    case "metric-large.fontSize":
    case "metric-label.fontSize":
      return sample.fontSize;
    case "card.border":
      return sample.border;
    case "card.borderRadius":
      return sample.borderRadius;
    case "card.padding":
      return sample.paddingX && sample.paddingY ? Number(((sample.paddingX + sample.paddingY) / 2).toFixed(2)) : undefined;
    case "card.background":
      return sample.background;
    case "text.color":
      return sample.color;
    case "font.family":
      return sample.fontFamily;
    default:
      return undefined;
  }
}

function sampleToOutlier(sample: LedgerSample, value: number | string): ConsistencyOutlier {
  return {
    slideIndex: sample.slideIndex,
    layoutId: sample.layoutId,
    value,
    nodeSelector: sample.nodeSelector,
    role: sample.role
  };
}

function comparePropertyValue(property: ConsistencyFinding["property"], left: string, right: string) {
  if (property === "text.color") {
    return colorDistance(left, right) <= 8;
  }
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function majorityVote(values: string[]) {
  if (values.length === 0) return null;
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Array.from(counts.entries()).sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
}

function median(values: number[]) {
  const middle = Math.floor(values.length / 2);
  if (values.length === 0) return undefined;
  if (values.length % 2 === 0) return ((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2;
  return values[middle];
}

function isMetricNumber(node: SlideCascadeNode) {
  return hasClass(node, "number") && node.path.includes(".metric");
}

function hasClass(node: SlideCascadeNode, className: string) {
  return node.classList.includes(className);
}

function colorDistance(left: string, right: string) {
  const leftLab = rgbToLab(parseColor(left));
  const rightLab = rgbToLab(parseColor(right));
  if (!leftLab || !rightLab) return Number.MAX_SAFE_INTEGER;
  return Number(
    Math.sqrt(
      (leftLab[0] - rightLab[0]) ** 2 +
      (leftLab[1] - rightLab[1]) ** 2 +
      (leftLab[2] - rightLab[2]) ** 2
    ).toFixed(2)
  );
}

function parseColor(value: string) {
  const normalized = value.trim();
  const hex = normalized.match(/^#([\da-f]{3,8})$/i);
  if (hex) {
    const raw = hex[1] ?? "";
    if (raw.length === 3) {
      return [
        Number.parseInt(raw.charAt(0) + raw.charAt(0), 16),
        Number.parseInt(raw.charAt(1) + raw.charAt(1), 16),
        Number.parseInt(raw.charAt(2) + raw.charAt(2), 16)
      ] as const;
    }
    if (raw.length >= 6) {
      return [
        Number.parseInt(raw.slice(0, 2), 16),
        Number.parseInt(raw.slice(2, 4), 16),
        Number.parseInt(raw.slice(4, 6), 16)
      ] as const;
    }
  }

  const rgb = normalized.match(/^rgba?\(([^)]+)\)$/i);
  if (!rgb) return null;
  const parts = (rgb[1] ?? "").split(",").map((item) => Number.parseFloat(item.trim()));
  if (parts.length < 3 || parts.some((item) => !Number.isFinite(item))) return null;
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0] as const;
}

function rgbToLab(rgb: readonly [number, number, number] | null) {
  if (!rgb) return null;
  const [r, g, b] = rgb.map((value) => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];

  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 1;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const lab = [x, y, z].map((value) => value > 0.008856 ? value ** (1 / 3) : 7.787 * value + 16 / 116) as [number, number, number];
  return [
    116 * lab[1] - 16,
    500 * (lab[0] - lab[1]),
    200 * (lab[1] - lab[2])
  ] as const;
}
