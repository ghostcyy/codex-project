import type { AssetIR, ChoreographyItemIR, DonorContractIR, RenderableLayoutId } from "../../ir";
import type { SlideSlotFillIR } from "../../ir/slot-fill-ir.schema";

export type LayoutRenderContext = {
  slideRole?: string;
  isActive?: boolean;
  choreography?: ChoreographyItemIR;
  assets?: AssetIR;
  donorTemplateId?: string;
  deckClass?: string;
  donorDna?: DonorContractIR["dnaSignature"];
};

export type RenderedSlideSection = {
  slideIndex: number;
  layoutId: RenderableLayoutId;
  html: string;
};

export type LayoutRenderer<TFill extends SlideSlotFillIR = SlideSlotFillIR> = (
  fill: TFill,
  context?: LayoutRenderContext
) => RenderedSlideSection;
