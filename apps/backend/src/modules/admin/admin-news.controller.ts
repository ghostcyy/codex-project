import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query
} from "@nestjs/common";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import { RequirePermissions } from "../../common/auth/permissions.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { NewsService } from "../news/news.service";

@Controller("admin/news")
export class AdminNewsController {
  constructor(@Inject(NewsService) private readonly newsService: NewsService) {}

  @Get()
  @RequirePermissions("news.write")
  listNews(@Query("status") status?: string) {
    return this.newsService.listAdmin(status);
  }

  @Get(":id")
  @RequirePermissions("news.write")
  async getNewsItem(@Param("id") id: string) {
    const article = await this.newsService.getAdminById(id);

    if (!article) {
      throw new NotFoundException(`News article ${id} was not found.`);
    }

    return article;
  }

  @Post()
  @RequirePermissions("news.write")
  createNews(
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.newsService.createAdminArticle(body, user.id);
  }

  @Patch(":id")
  @RequirePermissions("news.write")
  updateNews(
    @Param("id") id: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.newsService.updateAdminArticle(id, body, user.id);
  }

  @Delete(":id")
  @RequirePermissions("news.write")
  deleteNews(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.newsService.deleteAdminArticle(id, user.id);
  }
}
