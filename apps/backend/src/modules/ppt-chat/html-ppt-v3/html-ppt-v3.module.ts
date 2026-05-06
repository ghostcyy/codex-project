/**
 * html-ppt-v3 :: html-ppt-v3.module.ts
 */

import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../database/database.module";
import { LlmConfigModule } from "../../llm-config/llm-config.module";
import { LlmLoggingModule } from "../../llm-logging/llm-logging.module";
import { HtmlPptV3Controller } from "./html-ppt-v3.controller";
import { PptV3JobService } from "./jobs/ppt-v3-job.service";
import { HtmlPptV3PreviewController } from "./preview/preview.controller";
import { PptV3ProjectService } from "./projects/ppt-v3-project.service";

@Module({
  imports:     [DatabaseModule, LlmConfigModule, LlmLoggingModule],
  controllers: [HtmlPptV3Controller, HtmlPptV3PreviewController],
  providers:   [PptV3JobService, PptV3ProjectService],
})
export class HtmlPptV3Module {}
