import { Module } from "@nestjs/common";
import { AdminModule } from "./modules/admin/admin.module";
import { AuthModule } from "./modules/auth/auth.module";
import { DatabaseModule } from "./modules/database/database.module";
import { HealthModule } from "./modules/health/health.module";
import { HtmlPptRendererModule } from "./modules/html-ppt-renderer/html-ppt-renderer.module";
import { LlmConfigModule } from "./modules/llm-config/llm-config.module";
import { NewsModule } from "./modules/news/news.module";
import { PptChatModule } from "./modules/ppt-chat/ppt-chat.module";
import { VideoModule } from "./modules/video/video.module";

@Module({
  imports: [
    DatabaseModule,
    HealthModule,
    NewsModule,
    AuthModule,
    AdminModule,
    VideoModule,
    LlmConfigModule,
    HtmlPptRendererModule,
    PptChatModule
  ]
})
export class AppModule {}
