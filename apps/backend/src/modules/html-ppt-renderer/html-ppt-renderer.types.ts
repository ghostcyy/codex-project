import type { PptDeckSpec } from "../ppt-chat/ppt-chat.types";

export interface HtmlPptRenderResult {
  deckId: string;
  title: string;
  previewUrl: string;
  downloadUrl: string;
  outputDir: string;
  createdAt: string;
}

export interface HtmlPptRenderedDeck {
  deckSpec: PptDeckSpec;
  render: HtmlPptRenderResult;
}

export interface HtmlPptStaticDeckInput {
  title: string;
  indexHtml: string;
  styleCss: string;
  skillRoot?: string;
  manifest?: Record<string, unknown>;
}
