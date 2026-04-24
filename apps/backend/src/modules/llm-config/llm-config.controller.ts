import { Body, Controller, Get, Inject, Put, UnauthorizedException } from "@nestjs/common";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { RequirePermissions } from "../../common/auth/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { LlmConfigService } from "./llm-config.service";
import type { LlmConfigInput } from "./llm-config.types";

@Controller("admin/llm-config")
@RequirePermissions("llm.manage")
export class LlmConfigController {
  constructor(@Inject(LlmConfigService) private readonly llmConfigService: LlmConfigService) {}

  @Get()
  getConfig() {
    return this.llmConfigService.getConfigSummary();
  }

  @Put()
  updateConfig(@Body() body: LlmConfigInput, @CurrentUser() user?: AuthenticatedUser) {
    if (!user) {
      throw new UnauthorizedException("Authenticated user context is unavailable.");
    }

    return this.llmConfigService.updateConfig(body, user.id);
  }
}
