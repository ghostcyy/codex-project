import { BadRequestException, Controller, Get, Inject, NotFoundException, Param, Req, Res } from "@nestjs/common";
import { CurrentUser } from "../../../../common/auth/current-user.decorator";
import { createReadStream } from "node:fs";
import type { AuthenticatedUser } from "../../../auth/auth.types";
import { PptV3JobService } from "../jobs/ppt-v3-job.service";
import { resolvePreviewFile } from "./preview-static";
import { HTML_PPT_V3_STALE_TEMPLATE_CODE, isHtmlPptV3StaleTemplateError } from "../shared";

type PreviewRequest = {
  params: Record<string, unknown>;
};

type PreviewResponse = NodeJS.WritableStream & {
  setHeader: (name: string, value: string) => void;
};

export function getPreviewRequestPath(req: PreviewRequest): string {
  const pathParam = req.params.path ?? req.params[0];
  if (Array.isArray(pathParam)) {
    return pathParam.join("/");
  }
  return String(pathParam ?? "index.html");
}

@Controller("html-ppt-v3")
export class HtmlPptV3PreviewController {
  constructor(@Inject(PptV3JobService) private readonly jobService: PptV3JobService) {}

  @Get("preview/:jobId/*path")
  async servePreview(
    @Param("jobId") jobId: string,
    @Req() req: PreviewRequest,
    @CurrentUser() user: AuthenticatedUser,
    @Res() res: PreviewResponse
  ) {
    const job = await this.jobService.requireOwnedJob(jobId, user.id);
    if (job.status !== "done" || !job.previewPath) {
      throw new NotFoundException("Preview is not available for this job.");
    }

    const rawPath = getPreviewRequestPath(req);
    try {
      const file = await resolvePreviewFile(job.previewPath, rawPath);
      res.setHeader("Content-Type", file.contentType);
      createReadStream(file.absolutePath).pipe(res);
    } catch (error) {
      if (isHtmlPptV3StaleTemplateError(error)) {
        throw new BadRequestException({
          code: HTML_PPT_V3_STALE_TEMPLATE_CODE,
          message: error.message
        });
      }
      throw new NotFoundException("Preview file not found.");
    }
  }
}
