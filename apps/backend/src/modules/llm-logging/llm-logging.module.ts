import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { LlmLoggingController } from "./llm-logging.controller";
import { LlmLoggingService } from "./llm-logging.service";

@Module({
  imports: [DatabaseModule],
  controllers: [LlmLoggingController],
  providers: [LlmLoggingService],
  exports: [LlmLoggingService]
})
export class LlmLoggingModule {}
