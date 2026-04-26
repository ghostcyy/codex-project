export type SlideTier = "hero" | "divider" | "body" | "data" | "closer";

export type ComputedStyle = {
  fontSize: number;
  fontWeight?: number;
  fontFamily?: string;
  color?: string;
  lineHeight: number;
  border?: string;
  borderWidth?: number;
  borderStyle?: string;
  borderColor?: string;
  borderRadius?: number;
  background?: string;
  backgroundColor?: string;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  marginLeft: number;
  customProperties: Record<string, string>;
  raw: Record<string, string>;
};

export type SlideCascadeNode = {
  id: string;
  tagName: string;
  classList: string[];
  attributes: Record<string, string>;
  text: string;
  path: string;
  parentId?: string;
  childIndex: number;
  childCount: number;
  computed: ComputedStyle;
};

export type SlideCascade = {
  slideIndex: number;
  layoutId: string;
  tier: SlideTier;
  nodes: SlideCascadeNode[];
};

export type LedgerSample = {
  slideIndex: number;
  layoutId: string;
  tier: SlideTier;
  nodeId: string;
  nodeSelector: string;
  role: string;
  fontSize?: number;
  fontWeight?: number;
  fontFamily?: string;
  color?: string;
  lineHeight?: number;
  border?: string;
  borderWidth?: number;
  borderRadius?: number;
  paddingX?: number;
  paddingY?: number;
  background?: string;
};

export type ConsistencyLedger = {
  groups: Record<string, LedgerSample[]>;
};

export type ConsistencyOutlier = {
  slideIndex: number;
  layoutId: string;
  value: number | string;
  nodeSelector: string;
  role: string;
};

export type ConsistencyFinding = {
  property:
    | "h1.fontSize"
    | "h2.fontSize"
    | "h3.fontSize"
    | "kicker.fontSize"
    | "lede.fontSize"
    | "metric-large.fontSize"
    | "metric-label.fontSize"
    | "card.border"
    | "card.borderRadius"
    | "card.padding"
    | "card.background"
    | "text.color"
    | "font.family";
  canonical: number | string;
  outliers: ConsistencyOutlier[];
  severity: "info" | "warn";
};

export type GeometryFinding = {
  slideIndex: number;
  layoutId: string;
  kind: "hierarchy-violation" | "overflow-estimate" | "competing-primary" | "accent-overuse";
  severity: "warn" | "block";
  message: string;
  fixHint: "css-patch" | "section-rewrite";
  nodeSelector?: string;
};

export type LayerOnePack = {
  ledger: ConsistencyLedger;
  consistencyFindings: ConsistencyFinding[];
  geometryFindings: GeometryFinding[];
};
