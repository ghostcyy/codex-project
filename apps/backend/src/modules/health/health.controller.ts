import { Controller, Get, Inject } from "@nestjs/common";
import { Public } from "../../common/auth/public.decorator";
import { DatabaseService } from "../database/database.service";

@Controller("health")
export class HealthController {
  constructor(@Inject(DatabaseService) private readonly databaseService: DatabaseService) {}

  @Get()
  @Public()
  getHealth() {
    return {
      service: "personal-ai-site-api",
      status: "ok",
      timestamp: new Date().toISOString(),
      phase: "phase-2-auth-rbac",
      modules: ["health", "news", "auth", "rbac", "admin-overview"],
      database: this.databaseService.getMode()
    };
  }
}
