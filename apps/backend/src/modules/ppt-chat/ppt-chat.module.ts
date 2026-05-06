import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { LlmConfigModule } from "../llm-config/llm-config.module";
import { LlmLoggingModule } from "../llm-logging/llm-logging.module";
import { HtmlPptV2Controller } from "./html-ppt-v2/html-ppt-v2.controller";
import { HtmlPptV2PublishService } from "./html-ppt-v2/orchestration";
import { SkillRegistryService } from "./html-ppt-v2/registry";
import { PptChatController } from "./ppt-chat.controller";
import { PptTemplateController } from "./ppt-template.controller";
import { PptChatService } from "./ppt-chat.service";

@Module({
  imports: [DatabaseModule, LlmConfigModule, LlmLoggingModule],
  controllers: [PptChatController, PptTemplateController, HtmlPptV2Controller],
  providers: [PptChatService, HtmlPptV2PublishService, SkillRegistryService],
  exports: [PptChatService]
})
export class PptChatModule {}
