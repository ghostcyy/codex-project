import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { LlmConfigController } from "./llm-config.controller";
import { LlmConfigService } from "./llm-config.service";

@Module({
  imports: [DatabaseModule],
  controllers: [LlmConfigController],
  providers: [LlmConfigService],
  exports: [LlmConfigService]
})
export class LlmConfigModule {}
