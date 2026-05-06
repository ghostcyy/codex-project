import { resolve } from "node:path";

export const HTML_PPT_V3_MODULE_ROOT = resolve(__dirname, "..");
export const WORKSPACE_ROOT = resolve(__dirname, "../../../../../../..");
export const TEMPLATES_ROOT = resolve(WORKSPACE_ROOT, ".agents", "skills", "html-ppt", "templates", "full-decks", "gemini");
export const HTML_PPT_V3_OUTPUT_DIR =
  process.env.HTML_PPT_V3_OUTPUT_DIR ?? resolve(WORKSPACE_ROOT, ".local-runtime", "html-ppt-v3");
