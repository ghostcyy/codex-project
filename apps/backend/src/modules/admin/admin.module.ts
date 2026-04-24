import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { NewsModule } from "../news/news.module";
import { AdminController } from "./admin.controller";
import { AdminNewsController } from "./admin-news.controller";

@Module({
  imports: [NewsModule, AuthModule],
  controllers: [AdminController, AdminNewsController]
})
export class AdminModule {}
