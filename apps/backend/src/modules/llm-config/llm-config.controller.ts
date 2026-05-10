import { Body, Controller, Delete, Get, Inject, Param, Post, Put, UnauthorizedException } from "@nestjs/common";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { RequirePermissions } from "../../common/auth/permissions.decorator";
import { RequireRoles } from "../../common/auth/roles.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { LlmConfigService } from "./llm-config.service";
import type { ImageModelConfigInput, JsonModelConfigInput, LlmConfigInput } from "./llm-config.types";

@Controller("admin/llm-config")
@RequireRoles("ADMIN")
@RequirePermissions("llm.manage")
export class LlmConfigController {
  constructor(@Inject(LlmConfigService) private readonly llmConfigService: LlmConfigService) {}

  @Get()
  getConfigList() {
    return this.llmConfigService.getConfigList();
  }

  @Get("image/default")
  getImageConfig() {
    return this.llmConfigService.getImageConfig();
  }

  @Put("image/default")
  updateImageConfig(@Body() body: ImageModelConfigInput, @CurrentUser() user?: AuthenticatedUser) {
    if (!user) throw new UnauthorizedException("Authenticated user context is unavailable.");
    return this.llmConfigService.updateImageConfig(body, user.id);
  }

  @Get("json/default")
  getJsonModelConfig() {
    return this.llmConfigService.getJsonModelConfig();
  }

  @Put("json/default")
  updateJsonModelConfig(@Body() body: JsonModelConfigInput, @CurrentUser() user?: AuthenticatedUser) {
    if (!user) throw new UnauthorizedException("Authenticated user context is unavailable.");
    return this.llmConfigService.updateJsonModelConfig(body, user.id);
  }

  @Post()
  createConfig(@Body() body: LlmConfigInput, @CurrentUser() user?: AuthenticatedUser) {
    if (!user) throw new UnauthorizedException("Authenticated user context is unavailable.");
    return this.llmConfigService.createConfig(body, user.id);
  }

  @Put(":id")
  updateConfig(
    @Param("id") id: string,
    @Body() body: LlmConfigInput,
    @CurrentUser() user?: AuthenticatedUser
  ) {
    if (!user) throw new UnauthorizedException("Authenticated user context is unavailable.");
    return this.llmConfigService.updateConfig(id, body, user.id);
  }

  @Delete(":id")
  deleteConfig(@Param("id") id: string) {
    return this.llmConfigService.deleteConfig(id);
  }
}
