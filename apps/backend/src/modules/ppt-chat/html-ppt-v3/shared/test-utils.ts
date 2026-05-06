import { readFileSync } from "node:fs";
import type { ZodType } from "zod";

export function loadFixture<T>(absPath: string, schema: ZodType<T>): T {
  const raw = JSON.parse(readFileSync(absPath, "utf8")) as unknown;
  return schema.parse(raw);
}
