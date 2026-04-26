import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, UnauthorizedException } from "@nestjs/common";
import { Public } from "../../common/auth/public.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { PptChatService } from "./ppt-chat.service";
import type {
  CreatePptProjectInput,
  ResumePptMessageInput,
  SendPptMessageInput,
  UpdatePptProjectInput
} from "./ppt-chat.types";

@Controller("ppt/projects")
export class PptChatController {
  constructor(@Inject(PptChatService) private readonly pptChatService: PptChatService) {}

  @Get()
  listProjects(@CurrentUser() user?: AuthenticatedUser) {
    return this.pptChatService.listProjects(this.requireUser(user).id);
  }

  @Post()
  createProject(@CurrentUser() user?: AuthenticatedUser, @Body() body?: CreatePptProjectInput) {
    return this.pptChatService.createProject(this.requireUser(user).id, body ?? {});
  }

  @Patch(":id")
  updateProject(
    @CurrentUser() user?: AuthenticatedUser,
    @Param("id") id?: string,
    @Body() body?: UpdatePptProjectInput
  ) {
    return this.pptChatService.updateProject(this.requireUser(user).id, String(id ?? ""), body ?? {});
  }

  @Delete(":id")
  deleteProject(@CurrentUser() user?: AuthenticatedUser, @Param("id") id?: string) {
    return this.pptChatService.deleteProject(this.requireUser(user).id, String(id ?? ""));
  }

  @Get(":id/messages")
  listMessages(@CurrentUser() user?: AuthenticatedUser, @Param("id") id?: string) {
    return this.pptChatService.listMessages(this.requireUser(user).id, String(id ?? ""));
  }

  @Post(":id/messages")
  sendMessage(
    @CurrentUser() user?: AuthenticatedUser,
    @Param("id") id?: string,
    @Body() body?: SendPptMessageInput
  ) {
    return this.pptChatService.sendMessage(this.requireUser(user).id, String(id ?? ""), body ?? {});
  }

  @Post(":id/messages/:messageId/resume")
  resumeMessageGeneration(
    @CurrentUser() user?: AuthenticatedUser,
    @Param("id") id?: string,
    @Param("messageId") messageId?: string,
    @Body() body?: ResumePptMessageInput
  ) {
    return this.pptChatService.resumeMessageGeneration(
      this.requireUser(user).id,
      String(id ?? ""),
      String(messageId ?? ""),
      body ?? {}
    );
  }

  private requireUser(user?: AuthenticatedUser) {
    if (!user) {
      throw new UnauthorizedException("Authenticated user context is unavailable.");
    }

    return user;
  }
}
