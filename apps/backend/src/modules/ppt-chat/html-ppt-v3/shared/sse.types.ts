import type { JobStatus, PptV3StageHistoryEntry, RunningJobStatus } from "./job.types";

type RunningStage = RunningJobStatus;

export type SSEEvent =
  | { event: "job-created"; data: { jobId: string; warnings?: string[] } }
  | {
      event: "stage-start";
      data: {
        stage: RunningStage;
        startedAt?: string;
        elapsedMs?: number;
        detail?: string;
        stageHistory?: PptV3StageHistoryEntry[];
      };
    }
  | {
      event: "stage-done";
      data: {
        stage: RunningStage;
        startedAt?: string;
        completedAt?: string;
        elapsedMs?: number;
        summary?: unknown;
        stageHistory?: PptV3StageHistoryEntry[];
      };
    }
  | { event: "progress"; data: { percent: number; message?: string } }
  | {
      event: "done";
      data: {
        jobId: string;
        previewUrl: string;
        downloadUrl: string;
        warnings?: string[];
        modelCallCount?: number;
        stageHistory?: PptV3StageHistoryEntry[];
      };
    }
  | {
      event: "error";
      data: { message: string; stage?: JobStatus; startedAt?: string; completedAt?: string; elapsedMs?: number };
    };
