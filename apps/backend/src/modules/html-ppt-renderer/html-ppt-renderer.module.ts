import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { HtmlPptRendererController } from "./html-ppt-renderer.controller";
import { HtmlPptRendererService } from "./html-ppt-renderer.service";

@Module({
  imports: [DatabaseModule],
  controllers: [HtmlPptRendererController],
  providers: [HtmlPptRendererService],
  exports: [HtmlPptRendererService]
})
export class HtmlPptRendererModule {}
