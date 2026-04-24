import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from "@nestjs/common";
import {
  getVideoChunkRateLimitRequests,
  getVideoOutputRateLimitRequests,
  getVideoRateLimitRequests,
  getVideoRateLimitWindowMs
} from "./video.config";

type RateBucket = {
  count: number;
  resetAt: number;
};

@Injectable()
export class VideoRateLimitGuard implements CanActivate {
  private static readonly buckets = new Map<string, RateBucket>();

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{
      ip?: string;
      headers?: Record<string, string | string[] | undefined>;
      route?: { path?: string };
      path?: string;
      originalUrl?: string;
    }>();
    const response = context.switchToHttp().getResponse<{ setHeader(name: string, value: string): void }>();

    const routeKey = this.getRouteKey(request);
    const limit = this.getLimit(routeKey);
    const windowMs = getVideoRateLimitWindowMs();
    const bucketKey = `${this.getClientIp(request)}:${routeKey}`;
    const now = Date.now();

    this.pruneExpiredBuckets(now);

    const existing = VideoRateLimitGuard.buckets.get(bucketKey);
    const bucket =
      existing && existing.resetAt > now
        ? existing
        : {
            count: 0,
            resetAt: now + windowMs
          };

    bucket.count += 1;
    VideoRateLimitGuard.buckets.set(bucketKey, bucket);

    if (bucket.count > limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      response.setHeader("Retry-After", String(retryAfterSeconds));
      throw new HttpException(`视频接口请求过于频繁，请在 ${retryAfterSeconds} 秒后重试。`, HttpStatus.TOO_MANY_REQUESTS);
    }

    return true;
  }

  private getClientIp(request: {
    ip?: string;
    headers?: Record<string, string | string[] | undefined>;
  }) {
    const forwardedFor = request.headers?.["x-forwarded-for"];
    const forwardedValue = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
    const forwardedIp = forwardedValue?.split(",")[0]?.trim();
    return forwardedIp || request.ip || "unknown";
  }

  private getRouteKey(request: {
    route?: { path?: string };
    path?: string;
    originalUrl?: string;
  }) {
    return request.route?.path || request.path || request.originalUrl || "video";
  }

  private getLimit(routeKey: string) {
    if (routeKey.includes("chunk")) {
      return getVideoChunkRateLimitRequests();
    }

    if (routeKey.includes("output")) {
      return getVideoOutputRateLimitRequests();
    }

    return getVideoRateLimitRequests();
  }

  private pruneExpiredBuckets(now: number) {
    if (VideoRateLimitGuard.buckets.size < 2048) {
      return;
    }

    for (const [key, bucket] of VideoRateLimitGuard.buckets.entries()) {
      if (bucket.resetAt <= now) {
        VideoRateLimitGuard.buckets.delete(key);
      }
    }
  }
}
