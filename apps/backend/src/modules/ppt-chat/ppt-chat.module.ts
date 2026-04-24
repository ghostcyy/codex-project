import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { HtmlPptRendererModule } from "../html-ppt-renderer/html-ppt-renderer.module";
import { LlmConfigModule } from "../llm-config/llm-config.module";
import { HtmlPptAgentService } from "./html-ppt-agent.service";
import { PptChatController } from "./ppt-chat.controller";
import { PptChatService } from "./ppt-chat.service";

@Module({
  imports: [DatabaseModule, LlmConfigModule, HtmlPptRendererModule],
  controllers: [PptChatController],
  providers: [PptChatService, HtmlPptAgentService],
  exports: [PptChatService]
})
export class PptChatModule {}
