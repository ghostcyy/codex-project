import type { DeckIR } from "../ir";
import type { SkillRegistry } from "../registry";
import type { RenderedSlideSection } from "./layout-renderers";

export type RenderedDeckFiles = {
  indexHtml: string;
  previewHtml: string;
  standaloneHtml: string;
  styleCss: string;
  manifestJson: string;
  exportZip: Buffer;
  assets: Record<string, string>;
};

export type RenderedDeckManifest = {
  schemaVersion: "html-ppt-v2-render-manifest-v1";
  deckTitle: string;
  slideCount: number;
  themeId: string;
  donorTemplateId: string;
  deckClass: string;
  generatedAt: string;
  irVersion: DeckIR["meta"]["irVersion"];
  registryHash?: string;
  files: {
    indexHtml: string;
    previewHtml: string;
    standaloneHtml: string;
    styleCss: string;
    zip: string;
    assets: string[];
    verificationReport?: string;
    screenshots?: string[];
    auxiliaryArtifacts?: {
      speakerNotes: string;
      agendaPdf: string;
      talkingPoints: string;
      qaPrep: string;
      accessibilityReport: string;
    };
  };
  qualityScores: DeckIR["meta"]["qualityScores"];
  verification?: {
    status: "clean" | "warning" | "failed";
    reportFile: string;
    generatedAt: string;
    hardIssueCount: number;
    warningCount: number;
    mode: "static" | "playwright";
  };
  auxiliaryArtifacts?: {
    speakerNotes: string;
    agendaPdf: string;
    talkingPoints: string;
    qaPrep: string;
    accessibilityReport: string;
  };
};

export type RenderedDeck = {
  deck: DeckIR;
  sections: RenderedSlideSection[];
  files: RenderedDeckFiles;
  manifest: RenderedDeckManifest;
};

export type RenderDeckToDirectoryOptions = {
  outputDir: string;
  registryHash?: string;
  registry?: SkillRegistry;
};
