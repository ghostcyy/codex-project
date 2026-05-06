import type { RenderableLayoutId, SlideSlotFillIR } from "../../ir";
import type { LayoutRenderer } from "../layout-renderers";

export type CoreLayoutPackage<TFill extends SlideSlotFillIR = SlideSlotFillIR> = {
  id: RenderableLayoutId;
  roleFit: string[];
  renderer: LayoutRenderer<TFill>;
  sampleFill: TFill;
  allowedClasses: string[];
};
