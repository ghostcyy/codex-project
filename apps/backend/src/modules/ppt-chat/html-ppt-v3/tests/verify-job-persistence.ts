import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PptV3JobService } from "../jobs/ppt-v3-job.service";
import type { GenerateRequest } from "../shared";

type QueryCall = { text: string; values: unknown[] };

class FakeDatabaseService {
  readonly calls: QueryCall[] = [];
  private rows = new Map<string, Record<string, unknown>>();

  seedLegacyJob(id: string, request: Record<string, unknown>) {
    this.rows.set(id, {
      id,
      user_id: null,
      project_id: null,
      request,
      template_id: request.templateId,
      status: "done",
      output_dir: previewPath,
      zip_path: zipPath,
      preview_path: previewPath,
      plan: null,
      content: null,
      error: null,
      created_at: new Date("2026-05-02T00:00:00.000Z"),
      completed_at: new Date("2026-05-02T00:01:00.000Z")
    });
  }

  seedRunningJob(id: string, request: Record<string, unknown>) {
    this.rows.set(id, {
      id,
      user_id: null,
      owner_user_id: 1,
      project_id: null,
      request,
      template_id: request.templateId,
      status: "writing",
      output_dir: previewPath,
      zip_path: zipPath,
      preview_path: previewPath,
      plan: null,
      content: null,
      error: null,
      stage_history: [
        {
          stage: "writing",
          status: "running",
          startedAt: "2026-05-02T00:00:10.000Z",
          completedAt: null,
          elapsedMs: null,
          detail: "Writing slide content",
          summary: null
        }
      ],
      created_at: new Date("2026-05-02T00:00:00.000Z"),
      completed_at: null
    });
  }

  async query(text: string, values: unknown[] = []) {
    this.calls.push({ text, values });
    const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();

    if (normalized.startsWith("create table") || normalized.startsWith("create index") || normalized.startsWith("alter table")) {
      return { rows: [], rowCount: 0 };
    }

    if (normalized.startsWith("insert into ppt_v3_jobs")) {
      const row = {
        id: values[0],
        user_id: values[1],
        project_id: values[2] ?? null,
        request: values[3],
        template_id: values[4],
        status: "pending",
        output_dir: null,
        zip_path: null,
        preview_path: null,
        plan: null,
        content: null,
        error: null,
        created_at: new Date("2026-05-02T00:00:00.000Z"),
        completed_at: null
      };
      this.rows.set(String(row.id), row);
      return { rows: [row], rowCount: 1 };
    }

    if (normalized.startsWith("select") && normalized.includes("from ppt_v3_jobs")) {
      const row = this.rows.get(String(values[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }

    if (normalized.startsWith("update ppt_v3_jobs") && normalized.includes("where status in")) {
      const message = String(values[0]);
      const completedAt = String(values[1]);
      const updated: Record<string, unknown>[] = [];
      for (const row of this.rows.values()) {
        if (!["planning", "writing", "imaging", "injecting", "packaging"].includes(String(row.status))) continue;
        row.status = "failed";
        row.error = message;
        row.output_dir = null;
        row.zip_path = null;
        row.preview_path = null;
        row.completed_at = new Date("2026-05-02T00:01:00.000Z");
        row.stage_history = Array.isArray(row.stage_history)
          ? row.stage_history.map((entry) => {
              if (!entry || typeof entry !== "object" || (entry as Record<string, unknown>).status !== "running") return entry;
              return {
                ...(entry as Record<string, unknown>),
                status: "failed",
                completedAt,
                detail: message
              };
            })
          : [];
        updated.push(row);
      }
      return { rows: updated, rowCount: updated.length };
    }

    if (normalized.startsWith("update ppt_v3_jobs")) {
      const id = String(values[values.length - 1]);
      const row = this.rows.get(id);
      if (!row) return { rows: [], rowCount: 0 };
      if (normalized.includes("status = $1")) {
        row.status = values[0];
        row.error = values[1];
        if (values[0] === "failed") {
          row.output_dir = null;
          row.zip_path = null;
          row.preview_path = null;
        }
      }
      if (normalized.includes("status = 'done'")) {
        row.status = "done";
        row.output_dir = values[0];
        row.zip_path = values[1];
        row.preview_path = values[2];
      }
      if (normalized.includes("completed_at")) row.completed_at = new Date("2026-05-02T00:01:00.000Z");
      return { rows: [row], rowCount: 1 };
    }

    throw new Error(`Unexpected query: ${text}`);
  }
}

const fixtureRoot = join(__dirname, "..", ".tmp", "job-persistence");
rmSync(fixtureRoot, { recursive: true, force: true });
mkdirSync(fixtureRoot, { recursive: true });
const previewPath = join(fixtureRoot, "preview");
const zipPath = join(fixtureRoot, "deck.zip");
mkdirSync(previewPath, { recursive: true });
writeFileSync(join(previewPath, "index.html"), "<html></html>");
writeFileSync(zipPath, "zip");

async function main() {
  const db = new FakeDatabaseService();
  db.seedRunningJob("interrupted-job", {
    theme: "中断任务",
    pageCount: 8,
    wordBudget: 1600,
    templateId: "01-tech-web3",
    includeImages: false,
    includeVideo: false,
    includeChart: false,
    includeAudio: false
  });
  const service = new PptV3JobService(db as never);
  await service.onModuleInit();

  const interrupted = await service.getJob("interrupted-job");
  if (
    !interrupted ||
    interrupted.status !== "failed" ||
    !interrupted.error?.includes("backend restart") ||
    interrupted.outputDir ||
    interrupted.previewPath ||
    interrupted.zipPath ||
    interrupted.stageHistory[0]?.status !== "failed"
  ) {
    throw new Error("Startup should mark interrupted running jobs as failed and clear stale output paths.");
  }

  const request: GenerateRequest = {
    theme: "AI Agent落地路线",
    pageCount: 6,
    wordBudget: 1200,
    templateId: "01-tech-web3",
    includeImages: false,
    includeVideo: false,
    includeChart: false,
    includeAudio: false,
    includeSpeakerNotes: false
  };

  const created = await service.createJob(request, "user-1");
  if (created.status !== "pending" || created.request.theme !== request.theme) {
    throw new Error("createJob should persist a pending row with the original request.");
  }

  await service.markDone(created.id, { outputDir: previewPath, previewPath, zipPath });
  const loaded = await service.getJob(created.id);
  if (!loaded || loaded.status !== "done") {
    throw new Error("getJob should load the durable completed job.");
  }
  if (loaded.zipPath !== zipPath || loaded.previewPath !== previewPath || !loaded.completedAt) {
    throw new Error("markDone should persist zipPath, previewPath, and completedAt.");
  }
  if (!existsSync(loaded.zipPath) || !existsSync(join(loaded.previewPath!, "index.html"))) {
    throw new Error("Persisted paths should point at existing durable files.");
  }
  await service.setStatus(created.id, "failed", "stale template");
  const failed = await service.getJob(created.id);
  if (!failed || failed.status !== "failed" || failed.outputDir || failed.previewPath || failed.zipPath) {
    throw new Error("setStatus(failed) should clear stale preview/download paths.");
  }
  if (!db.calls.some((call) => call.text.includes("CREATE TABLE IF NOT EXISTS ppt_v3_jobs"))) {
    throw new Error("PptV3JobService should ensure the table exists at startup.");
  }

  db.seedLegacyJob("legacy-job", {
    theme: "旧请求",
    pageCount: 5,
    wordBudget: 1200,
    templateId: "mock-template",
    includeImages: false,
    includeVideo: false
  });
  const legacyLoaded = await service.getJob("legacy-job");
  if (!legacyLoaded || legacyLoaded.request.includeChart !== false || legacyLoaded.request.includeAudio !== false) {
    throw new Error("Job service should normalize old DB requests with missing includeChart/includeAudio to false.");
  }

  console.log("HTML-PPT v3 job persistence verification passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
