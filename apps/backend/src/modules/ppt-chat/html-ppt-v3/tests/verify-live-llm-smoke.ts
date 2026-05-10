import "../../../../common/load-env";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../../../app.module";
import { LlmConfigService } from "../../../llm-config/llm-config.service";
import { loadManifestV2 } from "../manifest/manifest-v2.loader";
import { HtmlPptV3LlmClient } from "../orchestration/html-ppt-v3-llm-client";
import { runStage0PoolBuild } from "../stages/stage0-pool-build";
import { runStage1Planner } from "../stages/stage1-planner";
import { runStage2Writer } from "../stages/stage2-writer";
import { type GenerateRequest } from "../shared";

const LIVE_FLAG = "HTML_PPT_V3_LIVE_LLM";

const request: GenerateRequest = {
  theme: "AI原生团队的产品研发协同",
  pageCount: 5,
  wordBudget: 1200,
  templateId: "01-tech-web3",
  includeImages: false,
  includeVideo: false,
  includeChart: false,
  includeAudio: false,
  includeSpeakerNotes: false
};

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

async function main() {
  if (process.env[LIVE_FLAG] !== "1") {
    console.log(`HTML-PPT v3 live LLM smoke skipped. Set ${LIVE_FLAG}=1 to enable.`);
    return;
  }

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });

  try {
    const llmConfig = await app.get(LlmConfigService).getActiveConfig();
    const llm = new HtmlPptV3LlmClient(llmConfig);
    const manifest = await loadManifestV2(request.templateId);
    const { pool } = runStage0PoolBuild({ request, manifest });

    const plannerStartedAt = Date.now();
    const planResult = await runStage1Planner({ request, pool, llm });
    const plannerDurationMs = Date.now() - plannerStartedAt;

    const writerStartedAt = Date.now();
    const writeResult = await runStage2Writer({ plan: planResult.plan, manifest, llm });
    const writerDurationMs = Date.now() - writerStartedAt;

    console.log(JSON.stringify({
      templateId: request.templateId,
      plannerSource: planResult.source,
      writerSource: writeResult.source,
      durationsMs: {
        planner: plannerDurationMs,
        writer: writerDurationMs,
        total: plannerDurationMs + writerDurationMs
      },
      validationErrors: {
        planner: planResult.validationErrors,
        writer: writeResult.validationErrors
      },
      slides: {
        planned: planResult.plan.slides.length,
        written: writeResult.content.slides.length
      }
    }, null, 2));
  } finally {
    await app.close();
  }
}
