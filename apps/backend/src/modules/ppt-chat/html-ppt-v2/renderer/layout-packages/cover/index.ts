import type { SlideSlotFillIR } from "../../../ir";
import { renderCover } from "../../layout-renderers";
import type { CoreLayoutPackage } from "../types";

type Fill = Extract<SlideSlotFillIR, { kind: "cover" }>;

export const coverLayoutPackage: CoreLayoutPackage<Fill> = {
  id: "cover",
  roleFit: ["cover", "hook"],
  renderer: renderCover,
  sampleFill: {
    slideIndex: 1,
    kind: "cover",
    title: "Deterministic Cover",
    kicker: "V2 Layout",
    subtitle: "A controlled cover slide rendered from typed JSON",
    meta: ["sample", "cover"],
    citationKeys: []
  },
  allowedClasses: ["slide", "layout-cover", "cover-shell", "cover-mark", "cover-copy", "kicker", "h1", "lede", "meta-row", "meta-pill", "citation-row", "citation-key", "slide-footer"]
};
