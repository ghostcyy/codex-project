export const HTML_PPT_V3_STALE_TEMPLATE_CODE = "HTML_PPT_V3_STALE_TEMPLATE";
export const HTML_PPT_V3_STALE_TEMPLATE_MESSAGE = "该历史结果使用旧模板结构，无法继续预览，请重新生成。";

export class HtmlPptV3StaleTemplateError extends Error {
  readonly code = HTML_PPT_V3_STALE_TEMPLATE_CODE;

  constructor(detail?: string) {
    super(detail ? `${HTML_PPT_V3_STALE_TEMPLATE_MESSAGE} ${detail}` : HTML_PPT_V3_STALE_TEMPLATE_MESSAGE);
    this.name = "HtmlPptV3StaleTemplateError";
  }
}

export function isHtmlPptV3StaleTemplateError(error: unknown): error is HtmlPptV3StaleTemplateError {
  return error instanceof HtmlPptV3StaleTemplateError ||
    (typeof error === "object" && error !== null && "code" in error && error.code === HTML_PPT_V3_STALE_TEMPLATE_CODE);
}
