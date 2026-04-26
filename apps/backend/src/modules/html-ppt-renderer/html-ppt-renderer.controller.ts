import { Controller, Get, Inject, Param, Query, Res, StreamableFile, UnauthorizedException } from "@nestjs/common";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { HtmlPptRendererService } from "./html-ppt-renderer.service";

@Controller("ppt/decks")
export class HtmlPptRendererController {
  constructor(@Inject(HtmlPptRendererService) private readonly rendererService: HtmlPptRendererService) {}

  @Get(":deckId/index.html")
  async getIndex(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param("deckId") deckId: string,
    @Res({ passthrough: true }) response: any
  ) {
    await this.rendererService.assertDeckOwnership(this.requireUser(user).id, deckId);
    const file = this.rendererService.getIndexStream(deckId);
    response.setHeader("Content-Type", file.contentType);
    response.setHeader("Content-Disposition", `inline; filename="${file.fileName}"`);
    return new StreamableFile(file.stream);
  }

  @Get(":deckId/preview.html")
  async getPreview(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param("deckId") deckId: string,
    @Res({ passthrough: true }) response: any
  ) {
    await this.rendererService.assertDeckOwnership(this.requireUser(user).id, deckId);
    const file = this.rendererService.getPreviewStream(deckId);
    response.setHeader("Content-Type", file.contentType);
    response.setHeader("Content-Disposition", `inline; filename="${file.fileName}"`);
    return new StreamableFile(file.stream);
  }

  @Get(":deckId/style.css")
  async getStyle(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param("deckId") deckId: string,
    @Res({ passthrough: true }) response: any
  ) {
    await this.rendererService.assertDeckOwnership(this.requireUser(user).id, deckId);
    const file = this.rendererService.getStyleStream(deckId);
    response.setHeader("Content-Type", file.contentType);
    response.setHeader("Content-Disposition", `inline; filename="${file.fileName}"`);
    return new StreamableFile(file.stream);
  }

  @Get(":deckId/asset")
  async getAsset(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param("deckId") deckId: string,
    @Query("path") path: string | undefined,
    @Res({ passthrough: true }) response: any
  ) {
    await this.rendererService.assertDeckOwnership(this.requireUser(user).id, deckId);
    const file = this.rendererService.getAssetStream(deckId, path ?? "");
    response.setHeader("Content-Type", file.contentType);
    response.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(file.fileName)}"`);
    return new StreamableFile(file.stream);
  }

  @Get(":deckId/download.html")
  async download(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param("deckId") deckId: string,
    @Res({ passthrough: true }) response: any
  ) {
    await this.rendererService.assertDeckOwnership(this.requireUser(user).id, deckId);
    const file = this.rendererService.getStandaloneStream(deckId);
    response.setHeader("Content-Type", file.contentType);
    response.setHeader("Content-Disposition", `attachment; filename="${file.fileName}"`);
    return new StreamableFile(file.stream);
  }

  @Get(":deckId/download.zip")
  async downloadZip(
    @CurrentUser() user: AuthenticatedUser | undefined,
    @Param("deckId") deckId: string,
    @Res({ passthrough: true }) response: any
  ) {
    await this.rendererService.assertDeckOwnership(this.requireUser(user).id, deckId);
    const file = this.rendererService.getZipStream(deckId);
    response.setHeader("Content-Type", file.contentType);
    response.setHeader("Content-Disposition", "attachment; filename=\"html-ppt-deck.zip\"");
    return new StreamableFile(file.stream);
  }

  private requireUser(user?: AuthenticatedUser) {
    if (!user) {
      throw new UnauthorizedException("Authenticated user context is unavailable.");
    }

    return user;
  }
}
