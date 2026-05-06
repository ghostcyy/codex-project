import type { z } from "zod";

export type JsonLikeShape = "object" | "array" | "auto";

export function parseJsonLike(raw: unknown, options: { shape?: JsonLikeShape } = {}): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    const shape = options.shape ?? "auto";
    const match = shape === "array"
      ? raw.match(/\[[\s\S]*\]/)
      : shape === "object"
        ? raw.match(/\{[\s\S]*\}/)
        : raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (!match) return raw;
    try {
      return JSON.parse(match[0]);
    } catch {
      return raw;
    }
  }
}

export function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
}
