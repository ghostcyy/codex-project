import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { HtmlPptRendererModule } from "../html-ppt-renderer/html-ppt-renderer.module";
import { LlmConfigModule } from "../llm-config/llm-config.module";
import { LlmLoggingModule } from "../llm-logging/llm-logging.module";
import { HtmlPptAgentService } from "./html-ppt-agent.service";
import { PptChatController } from "./ppt-chat.controller";
import { PptTemplateController } from "./ppt-template.controller";
import { PptChatService } from "./ppt-chat.service";

@Module({
  imports: [DatabaseModule, LlmConfigModule, HtmlPptRendererModule, LlmLoggingModule],
  controllers: [PptChatController, PptTemplateController],
  providers: [PptChatService, HtmlPptAgentService],
  exports: [PptChatService]
})
export class PptChatModule {}
