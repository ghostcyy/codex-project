export * from "./types";
export * from "./cover";
export * from "./toc";
export * from "./two-column";
export * from "./three-column";
export * from "./kpi-grid";
export * from "./bullet-list";
export * from "./process";
export * from "./quote";
export * from "./section-divider";
export * from "./stat-highlight";
export * from "./timeline";
export * from "./comparison";
export * from "./chart";
export * from "./image-hero";
export * from "./cta";

import type { RenderableLayoutId } from "../../ir";
import { bulletListLayoutPackage } from "./bullet-list";
import { comparisonLayoutPackage } from "./comparison";
import { chartLayoutPackage } from "./chart";
import { coverLayoutPackage } from "./cover";
import { ctaLayoutPackage } from "./cta";
import { imageHeroLayoutPackage } from "./image-hero";
import { kpiGridLayoutPackage } from "./kpi-grid";
import { processLayoutPackage } from "./process";
import { quoteLayoutPackage } from "./quote";
import { sectionDividerLayoutPackage } from "./section-divider";
import { statHighlightLayoutPackage } from "./stat-highlight";
import { threeColumnLayoutPackage } from "./three-column";
import { timelineLayoutPackage } from "./timeline";
import { tocLayoutPackage } from "./toc";
import { twoColumnLayoutPackage } from "./two-column";

export const coreLayoutPackages = [
  coverLayoutPackage,
  tocLayoutPackage,
  twoColumnLayoutPackage,
  threeColumnLayoutPackage,
  kpiGridLayoutPackage,
  timelineLayoutPackage,
  comparisonLayoutPackage,
  bulletListLayoutPackage,
  processLayoutPackage,
  statHighlightLayoutPackage,
  sectionDividerLayoutPackage,
  quoteLayoutPackage,
  chartLayoutPackage,
  imageHeroLayoutPackage,
  ctaLayoutPackage
] as const;

export type AnyCoreLayoutPackage = (typeof coreLayoutPackages)[number];

export const coreLayoutPackageById = new Map<RenderableLayoutId, AnyCoreLayoutPackage>(
  coreLayoutPackages.map((layoutPackage) => [layoutPackage.id, layoutPackage] as const)
);
