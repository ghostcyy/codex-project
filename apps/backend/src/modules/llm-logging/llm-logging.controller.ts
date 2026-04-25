import { Controller, Get, Inject } from "@nestjs/common";
import { RequirePermissions } from "../../common/auth/permissions.decorator";
import { LlmLoggingService } from "./llm-logging.service";

@Controller("admin/llm-logs")
@RequirePermissions("llm.manage")
export class LlmLoggingController {
  constructor(@Inject(LlmLoggingService) private readonly llmLoggingService: LlmLoggingService) {}

  @Get()
  getRecentLogs() {
    return this.llmLoggingService.getRecentLogs(50);
  }

  @Get("stats")
  getStats() {
    return this.llmLoggingService.getStats();
  }
}
