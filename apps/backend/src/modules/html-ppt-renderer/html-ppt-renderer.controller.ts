import { Controller, Get, Inject, Param, Query, Res, StreamableFile } from "@nestjs/common";
import { HtmlPptRendererService } from "./html-ppt-renderer.service";

@Controller("ppt/decks")
export class HtmlPptRendererController {
  constructor(@Inject(HtmlPptRendererService) private readonly rendererService: HtmlPptRendererService) {}

  @Get(":deckId/index.html")
  getIndex(@Param("deckId") deckId: string, @Res({ passthrough: true }) response: any) {
    const file = this.rendererService.getIndexStream(deckId);
    response.setHeader("Content-Type", file.contentType);
    response.setHeader("Content-Disposition", `inline; filename="${file.fileName}"`);
    return new StreamableFile(file.stream);
  }

  @Get(":deckId/preview.html")
  getPreview(@Param("deckId") deckId: string, @Res({ passthrough: true }) response: any) {
    const file = this.rendererService.getPreviewStream(deckId);
    response.setHeader("Content-Type", file.contentType);
    response.setHeader("Content-Disposition", `inline; filename="${file.fileName}"`);
    return new StreamableFile(file.stream);
  }

  @Get(":deckId/style.css")
  getStyle(@Param("deckId") deckId: string, @Res({ passthrough: true }) response: any) {
    const file = this.rendererService.getStyleStream(deckId);
    response.setHeader("Content-Type", file.contentType);
    response.setHeader("Content-Disposition", `inline; filename="${file.fileName}"`);
    return new StreamableFile(file.stream);
  }

  @Get(":deckId/asset")
  getAsset(
    @Param("deckId") deckId: string,
    @Query("path") path: string | undefined,
    @Res({ passthrough: true }) response: any
  ) {
    const file = this.rendererService.getAssetStream(deckId, path ?? "");
    response.setHeader("Content-Type", file.contentType);
    response.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(file.fileName)}"`);
    return new StreamableFile(file.stream);
  }

  @Get(":deckId/download.html")
  download(@Param("deckId") deckId: string, @Res({ passthrough: true }) response: any) {
    const file = this.rendererService.getStandaloneStream(deckId);
    response.setHeader("Content-Type", file.contentType);
    response.setHeader("Content-Disposition", `attachment; filename="${file.fileName}"`);
    return new StreamableFile(file.stream);
  }

  @Get(":deckId/download.zip")
  downloadZip(@Param("deckId") deckId: string, @Res({ passthrough: true }) response: any) {
    const file = this.rendererService.getZipStream(deckId);
    response.setHeader("Content-Type", file.contentType);
    response.setHeader("Content-Disposition", "attachment; filename=\"html-ppt-deck.zip\"");
    return new StreamableFile(file.stream);
  }
}
