import { Module } from "@nestjs/common";
import { HtmlPptRendererController } from "./html-ppt-renderer.controller";
import { HtmlPptRendererService } from "./html-ppt-renderer.service";

@Module({
  controllers: [HtmlPptRendererController],
  providers: [HtmlPptRendererService],
  exports: [HtmlPptRendererService]
})
export class HtmlPptRendererModule {}
