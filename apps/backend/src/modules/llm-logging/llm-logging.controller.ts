import { Controller, Get, Inject, Param, Query } from "@nestjs/common";
import { RequirePermissions } from "../../common/auth/permissions.decorator";
import { RequireRoles } from "../../common/auth/roles.decorator";
import { LlmLoggingService } from "./llm-logging.service";

@Controller("admin/llm-logs")
@RequireRoles("ADMIN")
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

  @Get("payloads")
  getRecentPayloadLogs(@Query("limit") limit?: string, @Query("projectId") projectId?: string) {
    const parsedLimit = Number(limit);
    const normalizedLimit = Number.isFinite(parsedLimit) ? parsedLimit : 50;
    const normalizedProjectId = typeof projectId === "string" && projectId.trim().length > 0 ? projectId.trim() : undefined;
    return this.llmLoggingService.getRecentPayloadLogs(normalizedLimit, normalizedProjectId);
  }

  @Get("payloads/:id")
  getPayloadLogDetail(@Param("id") id: string) {
    return this.llmLoggingService.getPayloadLogDetail(id);
  }
}
