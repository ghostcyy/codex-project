import { Controller, Get, Inject } from "@nestjs/common";
import { Public } from "../../common/auth/public.decorator";
import { PptChatService } from "./ppt-chat.service";

@Controller("ppt/templates")
export class PptTemplateController {
  constructor(@Inject(PptChatService) private readonly pptChatService: PptChatService) {}

  @Public()
  @Get("catalog")
  listTemplates() {
    return this.pptChatService.listTemplates();
  }
}
