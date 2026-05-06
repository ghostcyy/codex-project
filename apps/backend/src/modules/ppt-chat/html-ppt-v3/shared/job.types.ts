import { z } from "zod";
import type { ContentIR } from "./content-ir.types";
import type { PlanIR } from "./plan-ir.types";

export const generateRequestSchema = z.object({
  theme: z.string().min(1).max(500),
  pageCount: z.number().int().min(5).max(30),
  wordBudget: z.number().int().min(500).max(15000),
  templateId: z.string().min(1),
  includeImages: z.boolean().default(false),
  includeVideo: z.boolean().default(false),
  includeChart: z.boolean().default(false),
  includeAudio: z.boolean().default(false)
});
export type GenerateRequest = z.infer<typeof generateRequestSchema>;

export function normalizeGenerateRequest(raw: unknown): GenerateRequest {
  const body = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  return generateRequestSchema.parse({
    theme: body.theme ?? body.topic,
    pageCount: body.pageCount,
    wordBudget: body.wordBudget ?? body.charCount,
    templateId: body.templateId,
    includeImages: body.includeImages ?? body.wantsImageSlides ?? false,
    includeVideo: body.includeVideo ?? body.wantsVideoSlides ?? false,
    includeChart: body.includeChart ?? body.wantsChartSlides ?? false,
    includeAudio: body.includeAudio ?? body.wantsAudioSlides ?? false
  });
}

export const JOB_STATUSES = [
  "pending",
  "planning",
  "writing",
  "imaging",
  "injecting",
  "packaging",
  "done",
  "failed"
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export type RunningJobStatus = Exclude<JobStatus, "pending" | "done" | "failed">;

export type PptV3StageHistoryEntry = {
  stage: RunningJobStatus;
  status: "running" | "done" | "failed";
  startedAt: string;
  completedAt?: string | null;
  elapsedMs?: number | null;
  detail?: string | null;
  summary?: unknown;
};

export type PptV3Job = {
  id: string;
  userId: string | null;
  ownerUserId: number | null;
  projectId?: string | null;
  request: GenerateRequest;
  templateId: string;
  status: JobStatus;
  outputDir: string | null;
  zipPath: string | null;
  previewPath: string | null;
  plan: PlanIR | null;
  content: ContentIR | null;
  error: string | null;
  stageHistory: PptV3StageHistoryEntry[];
  createdAt: Date;
  completedAt: Date | null;
};
