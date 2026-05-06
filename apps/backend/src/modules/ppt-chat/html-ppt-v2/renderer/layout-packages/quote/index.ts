import type { SlideSlotFillIR } from "../../../ir";
import { renderQuote } from "../../layout-renderers";
import type { CoreLayoutPackage } from "../types";

type Fill = Extract<SlideSlotFillIR, { kind: "quote" }>;

export const quoteLayoutPackage: CoreLayoutPackage<Fill> = {
  id: "quote",
  roleFit: ["synthesis", "case-study", "hook"],
  renderer: renderQuote,
  sampleFill: {
    slideIndex: 1,
    kind: "quote",
    title: "Editorial Quote",
    kicker: "Signal",
    quote: "A strong idea deserves a slide that gives the audience time to sit with it.",
    attribution: "HTML-PPT v2 renderer",
    supportingText: "Use quote slides to emphasize a decisive narrative turn.",
    citationKeys: []
  },
  allowedClasses: [
    "slide",
    "layout-quote",
    "quote-shell",
    "kicker",
    "quote-figure",
    "quote-mark",
    "quote-text",
    "quote-attribution",
    "quote-support",
    "citation-row",
    "citation-key",
    "slide-footer"
  ]
};
