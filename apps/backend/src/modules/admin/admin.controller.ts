import { Controller, Get, Inject } from "@nestjs/common";
import { RequirePermissions } from "../../common/auth/permissions.decorator";
import { AuthService } from "../auth/auth.service";
import { NewsService } from "../news/news.service";

@Controller("admin")
export class AdminController {
  constructor(
    @Inject(NewsService) private readonly newsService: NewsService,
    @Inject(AuthService) private readonly authService: AuthService
  ) {}

  @Get("overview")
  @RequirePermissions("admin.access")
  getOverview() {
    return this.newsService.getAdminOverview();
  }

  @Get("users")
  @RequirePermissions("user.manage")
  getUsers() {
    return this.authService.listUsers();
  }
}
