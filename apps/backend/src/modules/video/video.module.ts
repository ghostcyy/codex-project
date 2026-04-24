import { Module } from "@nestjs/common";
import { VideoController } from "./video.controller";
import { VideoRateLimitGuard } from "./video-rate-limit.guard";
import { VideoService } from "./video.service";

@Module({
  controllers: [VideoController],
  providers: [VideoService, VideoRateLimitGuard],
  exports: [VideoService]
})
export class VideoModule {}
