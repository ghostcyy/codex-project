import { Controller, Get, Inject, NotFoundException, Param, Query } from "@nestjs/common";
import { Public } from "../../common/auth/public.decorator";
import { NewsService } from "./news.service";

@Controller("news")
export class NewsController {
  constructor(@Inject(NewsService) private readonly newsService: NewsService) {}

  @Get("today")
  @Public()
  getToday() {
    return this.newsService.getTodayBundle();
  }

  @Get()
  @Public()
  listNews(
    @Query("page") page?: string,
    @Query("pageSize") pageSize?: string,
    @Query("date") date?: string
  ) {
    return this.newsService.list(Number(page ?? "1"), Number(pageSize ?? "10"), date);
  }

  @Get(":id")
  @Public()
  async getNewsItem(@Param("id") id: string) {
    const article = await this.newsService.getById(id);

    if (!article) {
      throw new NotFoundException(`News article ${id} was not found.`);
    }

    return article;
  }
}
