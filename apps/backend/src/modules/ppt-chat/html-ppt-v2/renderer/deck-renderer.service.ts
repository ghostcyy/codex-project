import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deckIrSchema, type DeckIR } from "../ir";
import { renderCoreLayout } from "./layout-renderers";
import { composeDeckStyleCss } from "./css-composer";
import { renderDeckHtmlDocument } from "./html-shell";
import { HTML_PPT_V2_RUNTIME_JS } from "./runtime-asset";
import type { RenderDeckToDirectoryOptions, RenderedDeck, RenderedDeckManifest } from "./types";
import type { SkillRegistry } from "../registry";
import { createZipBuffer } from "./zip-writer";

export class DeckRendererService {
  render(deckInput: unknown, registryHash?: string, registry?: SkillRegistry): RenderedDeck {
    const deck = deckIrSchema.parse(deckInput);
    const choreographyBySlide = new Map(deck.choreography.map((item) => [item.slideIndex, item]));
    const sections = [...deck.slots]
      .sort((a, b) => a.slideIndex - b.slideIndex)
      .map((slot, index) => renderCoreLayout(slot, {
        isActive: index === 0,
        choreography: choreographyBySlide.get(slot.slideIndex),
        assets: deck.assets,
        donorTemplateId: deck.design.donorTemplateId,
        deckClass: deck.design.deckClass,
        donorDna: deck.design.donorContract.dnaSignature
      }));

    const styleCss = composeDeckStyleCss(deck, registry);
    const sectionsHtml = sections.map((section) => section.html).join("\n");
    const indexHtml = renderDeckHtmlDocument({
      deck,
      sectionsHtml,
      styleHref: "style.css",
      scriptSrc: "assets/runtime-v2.js"
    });
    const previewHtml = indexHtml;
    const standaloneHtml = renderDeckHtmlDocument({
      deck,
      sectionsHtml,
      inlineCss: styleCss,
      inlineScript: HTML_PPT_V2_RUNTIME_JS
    });
    const manifest = this.buildManifest(deck, registryHash);
    const manifestJson = `${JSON.stringify({ ...manifest, deckIr: deck }, null, 2)}\n`;
    const assets = this.buildAssetFiles(deck);
    const exportZip = createZipBuffer([
      { name: "index.html", data: indexHtml },
      { name: "preview.html", data: previewHtml },
      { name: "standalone.html", data: standaloneHtml },
      { name: "style.css", data: styleCss },
      { name: "manifest.json", data: manifestJson },
      ...Object.entries(assets).map(([name, content]) => ({ name: `assets/${name}`, data: content }))
    ]);

    return {
      deck,
      sections,
      manifest,
      files: {
        indexHtml,
        previewHtml,
        standaloneHtml,
        styleCss,
        manifestJson,
        exportZip,
        assets
      }
    };
  }

  async renderToDirectory(deckInput: unknown, options: RenderDeckToDirectoryOptions): Promise<RenderedDeck> {
    const rendered = this.render(deckInput, options.registryHash, options.registry);
    const assetsDir = join(options.outputDir, "assets");
    await mkdir(assetsDir, { recursive: true });

    await Promise.all([
      writeFile(join(options.outputDir, "index.html"), rendered.files.indexHtml, "utf8"),
      writeFile(join(options.outputDir, "preview.html"), rendered.files.previewHtml, "utf8"),
      writeFile(join(options.outputDir, "standalone.html"), rendered.files.standaloneHtml, "utf8"),
      writeFile(join(options.outputDir, "style.css"), rendered.files.styleCss, "utf8"),
      writeFile(join(options.outputDir, "manifest.json"), rendered.files.manifestJson, "utf8"),
      writeFile(join(options.outputDir, "html-ppt-deck.zip"), rendered.files.exportZip),
      ...Object.entries(rendered.files.assets).map(([name, content]) => writeFile(join(assetsDir, name), content, "utf8"))
    ]);

    return rendered;
  }

  private buildManifest(deck: DeckIR, registryHash?: string): RenderedDeckManifest {
    return {
      schemaVersion: "html-ppt-v2-render-manifest-v1",
      deckTitle: deck.narrative.slides[0]?.contentBrief.headline ?? deck.intent.topic,
      slideCount: deck.intent.derivedSlideCount,
      themeId: deck.design.themeId,
      donorTemplateId: deck.design.donorTemplateId,
      deckClass: deck.design.deckClass,
      generatedAt: new Date().toISOString(),
      irVersion: deck.meta.irVersion,
      registryHash,
      files: {
        indexHtml: "index.html",
        previewHtml: "preview.html",
        standaloneHtml: "standalone.html",
        styleCss: "style.css",
        zip: "html-ppt-deck.zip",
      assets: Object.keys(this.buildAssetFiles(deck)).map((name) => `assets/${name}`)
      },
      qualityScores: deck.meta.qualityScores
    };
  }

  private buildAssetFiles(deck: DeckIR): Record<string, string> {
    const files: Record<string, string> = {
      "runtime-v2.js": `${HTML_PPT_V2_RUNTIME_JS}\n`
    };
    for (const [key, asset] of Object.entries(deck.assets)) {
      if (asset.kind === "chart") {
        files[`chart-${safeAssetFileSlug(key)}.json`] = `${JSON.stringify(asset.chartConfig, null, 2)}\n`;
      }
    }
    return files;
  }
}

function safeAssetFileSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90) || "asset";
}
