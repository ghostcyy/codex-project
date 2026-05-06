import type { RenderableLayoutId } from "../../ir";
import { classes, escapeAttr } from "../html";
import { donorVocabularyClasses } from "./donor-vocabulary";
import type { LayoutRenderContext, RenderedSlideSection } from "./types";

export function renderSection(input: {
  slideIndex: number;
  layoutId: RenderableLayoutId;
  title: string;
  role?: string;
  body: string;
  context?: LayoutRenderContext;
}): RenderedSlideSection {
  const choreography = input.context?.choreography;
  const entrance = choreography?.entrance && choreography.entrance !== "none" ? choreography.entrance : undefined;
  const fx = choreography?.fx && choreography.fx !== "none" ? choreography.fx : undefined;
  const buildTargets = choreography?.builds
    .map((build) => build.target)
    .filter(Boolean);
  const buildSpec = choreography?.builds
    .map((build) => {
      const target = build.target;
      return target ? `${target}:${build.anim}:${build.delay}` : "";
    })
    .filter(Boolean);
  const donorSectionClasses = donorVocabularyClasses(input.context, input.layoutId, "section");
  const className = classes(
    "slide",
    `layout-${input.layoutId}`,
    entrance ? `anim-${entrance}` : undefined,
    input.context?.isActive ? "is-active" : undefined,
    ...donorSectionClasses
  );
  const role = input.context?.slideRole ?? input.role ?? input.layoutId;
  const attributes = [
    `class="${className}"`,
    `data-slide-index="${input.slideIndex}"`,
    `data-layoutid="${input.layoutId}"`,
    `data-role="${escapeAttr(role)}"`,
    `data-title="${escapeAttr(input.title)}"`,
    input.context?.donorTemplateId ? `data-donor-template="${escapeAttr(input.context.donorTemplateId)}"` : undefined,
    entrance ? `data-anim="${escapeAttr(entrance)}"` : undefined,
    fx ? `data-fx="${escapeAttr(fx)}"` : undefined,
    buildTargets?.length ? `data-build-targets="${escapeAttr([...new Set(buildTargets)].join(" "))}"` : undefined,
    buildSpec?.length ? `data-builds="${escapeAttr(buildSpec.join("|"))}"` : undefined
  ].filter(Boolean);
  const html = [
    `<section ${attributes.join(" ")}>`,
    input.body,
    "</section>"
  ].join("");

  return {
    slideIndex: input.slideIndex,
    layoutId: input.layoutId,
    html
  };
}
