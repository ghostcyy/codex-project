import {
  runStage3Injector as runFragmentStage3Injector,
  type Stage3InjectorInput,
  type Stage3InjectorResult
} from "../injector/stage3-injector";
import { HtmlPptV3StaleTemplateError } from "../shared";

type LegacyStage3Input = {
  html: string;
  manifest: unknown;
  content: unknown;
};

type LegacyStage3Result = {
  html: string;
  warnings: string[];
};

export type { Stage3InjectorInput, Stage3InjectorResult };

export function runStage3Injector(input: Stage3InjectorInput): Stage3InjectorResult;
export function runStage3Injector(input: LegacyStage3Input): LegacyStage3Result;
export function runStage3Injector(input: Stage3InjectorInput | LegacyStage3Input): Stage3InjectorResult | LegacyStage3Result {
  if ("templateDir" in input && "workdir" in input) {
    return runFragmentStage3Injector(input);
  }

  throw new HtmlPptV3StaleTemplateError("Legacy section-index Stage3 input is no longer supported; use manifest-v2 fragments.");
}
