import { resolve } from "node:path";
import { type IntentIR } from "../ir";
import { summarizeTemplateSelectionProgress, traceTemplateSelection } from "../orchestration";
import { hydrateHtmlPptV2SkillRegistry } from "../registry";
import { runTemplateSelectionStage } from "../stages";
import type { JsonOnlyModelClient, JsonOnlyModelRequest } from "../stages/json-model-client";

const cases: Array<{
  expected: string;
  intent: IntentIR;
  prompt: string;
}> = [
  caseFor("pitch-deck", "investors", "pitch", "authoritative", "新能源储能公司 Series A 融资路演，强调 investor market size traction", "Series A investor pitch market size traction"),
  caseFor("product-launch", "consumers", "showcase", "inspirational", "AI 硬件新品产品发布，介绍 launch feature go-to-market customer value", "product launch feature go-to-market"),
  caseFor("tech-sharing", "engineers", "lecture", "rigorous", "云服务器架构技术分享，覆盖 developer architecture technical system design", "cloud architecture technical system design"),
  caseFor("weekly-report", "executives", "report", "analytical", "团队月报复盘，汇总 KPI weekly monthly progress 数据汇报", "weekly report KPI progress"),
  caseFor("course-module", "students", "tutorial", "tutorial", "面向学生的课程培训教程，讲清 lesson course training tutorial learning", "course training tutorial learning"),
  caseFor("xhs-post", "consumers", "showcase", "friendly", "小红书生活方式图文种草，做 swipe social lifestyle guide", "小红书 swipe social lifestyle guide"),
  caseFor("presenter-mode-reveal", "general-public", "lecture", "narrative", "主题分享演讲 keynote presenter speech talk reveal", "keynote presenter talk reveal"),
  caseFor("xhs-white-editorial", "designers", "briefing", "friendly", "白底杂志风科普长图，editorial magazine clean explainer", "white editorial magazine explainer"),
  caseFor("graphify-dark-graph", "researchers", "analysis", "analytical", "AI 知识图谱和复杂系统分析，graph network dark data", "graph network dark data"),
  caseFor("knowledge-arch-blueprint", "engineers", "analysis", "rigorous", "知识体系蓝图与架构图方法论，framework blueprint methodology architecture", "blueprint methodology architecture"),
  caseFor("hermes-cyber-terminal", "engineers", "briefing", "rigorous", "网络安全底层系统终端风格，cyber terminal security infra", "cyber terminal security infra"),
  caseFor("obsidian-claude-gradient", "executives", "showcase", "inspirational", "高端 AI 品牌创意科技展示，premium gradient future brand", "premium gradient future brand"),
  caseFor("xhs-pastel-card", "consumers", "tutorial", "friendly", "健康生活建议马卡龙柔和卡片，pastel friendly lifestyle", "pastel friendly lifestyle"),
  caseFor("dir-key-nav-minimal", "executives", "briefing", "analytical", "极简克制导航式简洁汇报，minimal clean concise brief", "minimal clean concise brief"),
  caseFor("testing-safety-alert", "policy-makers", "report", "authoritative", "安全事故风险警示预案，alert risk incident safety", "alert risk incident safety")
];

async function main() {
  const workspaceRoot = resolve(process.cwd(), "..", "..");
  const registry = await hydrateHtmlPptV2SkillRegistry(resolve(workspaceRoot, ".agents", "skills", "html-ppt"));
  const failures: string[] = [];

  for (const item of cases) {
    const result = await runTemplateSelectionStage({
      intent: item.intent,
      registry,
      rawPrompt: item.prompt
    });
    if (result.selectedTemplate.id !== item.expected) {
      failures.push(`${item.expected}: got ${result.selectedTemplate.id}; shortlist=${result.shortlist.map((candidate) => `${candidate.id}:${candidate.deterministicScore}`).join(",")}`);
    }
    if (result.source !== "auto-deterministic" || result.attempts !== 0) {
      failures.push(`${item.expected}: expected deterministic no-model source, got source=${result.source} attempts=${result.attempts}`);
    }
    assertShortlist(result.shortlist, item.expected, failures);
    assertTrace(result, "auto-deterministic", item.expected, failures);
    assertPublicTraceBreakdown(result, item.expected, failures);
  }

  await assertModelSelectionBehavior(registry, cases[0]!, failures);

  const pinned = registry.templatePackages.find((template) => template.id === "testing-safety-alert");
  if (!pinned) throw new Error("Missing testing-safety-alert template.");
  const pinnedResult = await runTemplateSelectionStage({
    intent: cases[0]!.intent,
    registry,
    rawPrompt: "This prompt would normally match pitch, but user selected a safety template.",
    pinnedTemplate: pinned
  });
  if (pinnedResult.source !== "pinned" || pinnedResult.selectedTemplate.id !== "testing-safety-alert" || pinnedResult.attempts !== 0) {
    failures.push(`pinned override failed: source=${pinnedResult.source} selected=${pinnedResult.selectedTemplate.id} attempts=${pinnedResult.attempts}`);
  }
  assertTrace(pinnedResult, "pinned", "testing-safety-alert", failures);
  assertPublicTraceBreakdown(pinnedResult, "testing-safety-alert", failures, { pinned: true });

  if (failures.length) {
    throw new Error(`Template auto-selection verification failed:\n${failures.join("\n")}`);
  }

  console.log(`HTML-PPT v2 template auto-selection verification passed. cases=${cases.length}; templates=${registry.templatePackages.length}`);
}

async function assertModelSelectionBehavior(
  registry: Awaited<ReturnType<typeof hydrateHtmlPptV2SkillRegistry>>,
  item: { expected: string; intent: IntentIR; prompt: string },
  failures: string[]
) {
  const deterministic = await runTemplateSelectionStage({
    intent: item.intent,
    registry,
    rawPrompt: item.prompt
  });
  const secondChoice = deterministic.shortlist[1]?.id;
  if (!secondChoice) {
    failures.push("model behavior: deterministic shortlist did not include a second candidate");
    return;
  }

  const validModel = modelReturning((request) => {
    const user = JSON.parse(String(request.user)) as { shortlist: Array<{ id: string }> };
    return {
      chosenTemplateId: user.shortlist[1]!.id,
      rationale: "Second shortlist candidate is deliberately selected for LLM-path verification.",
      confidence: "high"
    };
  });
  const llmResult = await runTemplateSelectionStage({
    intent: item.intent,
    registry,
    rawPrompt: item.prompt,
    model: validModel
  });
  if (llmResult.source !== "auto-llm" || llmResult.attempts !== 1 || llmResult.selectedTemplate.id !== secondChoice) {
    failures.push(`model behavior: expected auto-llm to select shortlist second=${secondChoice}, got source=${llmResult.source} attempts=${llmResult.attempts} selected=${llmResult.selectedTemplate.id}`);
  }
  assertTrace(llmResult, "auto-llm", secondChoice, failures);
  assertPublicTraceBreakdown(llmResult, secondChoice, failures);

  const invalidResult = await runTemplateSelectionStage({
    intent: item.intent,
    registry,
    rawPrompt: item.prompt,
    model: modelReturning(() => ({
      chosenTemplateId: "not-in-shortlist",
      rationale: "Invalid template should be rejected.",
      confidence: "high"
    }))
  });
  assertDeterministicFallback("invalid model choice", deterministic, invalidResult, failures);

  const lowConfidenceResult = await runTemplateSelectionStage({
    intent: item.intent,
    registry,
    rawPrompt: item.prompt,
    model: modelReturning(() => ({
      chosenTemplateId: secondChoice,
      rationale: "Low confidence should be rejected even when the ID is valid.",
      confidence: "low"
    }))
  });
  assertDeterministicFallback("low-confidence model choice", deterministic, lowConfidenceResult, failures);
}

function assertDeterministicFallback(
  label: string,
  deterministic: Awaited<ReturnType<typeof runTemplateSelectionStage>>,
  result: Awaited<ReturnType<typeof runTemplateSelectionStage>>,
  failures: string[]
) {
  if (result.source !== "auto-deterministic" || result.attempts !== 1 || result.selectedTemplate.id !== deterministic.selectedTemplate.id) {
    failures.push(`${label}: expected deterministic fallback selected=${deterministic.selectedTemplate.id}, got source=${result.source} attempts=${result.attempts} selected=${result.selectedTemplate.id}`);
  }
  if (!result.validationErrors.length || !result.rationale.includes("Model output rejected")) {
    failures.push(`${label}: expected validation error and rejected-model rationale`);
  }
  assertTrace(result, "auto-deterministic", deterministic.selectedTemplate.id, failures);
  assertPublicTraceBreakdown(result, deterministic.selectedTemplate.id, failures);
}

function assertShortlist(
  shortlist: Awaited<ReturnType<typeof runTemplateSelectionStage>>["shortlist"],
  expected: string,
  failures: string[]
) {
  if (shortlist.length < 3 || shortlist.length > 5) {
    failures.push(`${expected}: shortlist size must be 3-5, got ${shortlist.length}`);
  }
  if (shortlist[0]?.id !== expected) {
    failures.push(`${expected}: deterministic top-1 should be expected template, got ${shortlist[0]?.id}`);
  }
  for (let index = 1; index < shortlist.length; index += 1) {
    if (shortlist[index - 1]!.deterministicScore < shortlist[index]!.deterministicScore) {
      failures.push(`${expected}: shortlist must be sorted by descending deterministic score`);
      break;
    }
  }
  for (const candidate of shortlist) {
    if (!candidate.reason.includes("audience") || !candidate.reason.includes("format") || !candidate.reason.includes("tone") || !candidate.reason.includes("signals") || !candidate.reason.includes("forbid") || !candidate.reason.includes("slideCount")) {
      failures.push(`${expected}: candidate ${candidate.id} reason does not explain all scoring dimensions`);
      break;
    }
  }
}

function assertTrace(
  result: Awaited<ReturnType<typeof runTemplateSelectionStage>>,
  mode: string,
  chosenId: string,
  failures: string[]
) {
  for (const token of [`mode=${mode}`, "shortlist=[", `chosen=${chosenId}`, `confidence=${result.confidence}`, "reason="]) {
    if (!result.rationale.includes(token)) {
      failures.push(`${chosenId}: rationale missing trace token '${token}': ${result.rationale}`);
    }
  }
}

function assertPublicTraceBreakdown(
  result: Awaited<ReturnType<typeof runTemplateSelectionStage>>,
  chosenId: string,
  failures: string[],
  options?: { pinned?: boolean }
) {
  const trace = traceTemplateSelection(result);
  const progress = summarizeTemplateSelectionProgress(result);
  const dimensions = ["audienceFit", "formatFit", "toneFit", "promptSignals", "forbidPromptSignals", "defaultSlideCount"];

  if (trace.chosenTemplateId !== chosenId) {
    failures.push(`${chosenId}: trace chosenTemplateId mismatch: ${trace.chosenTemplateId}`);
  }
  if (trace.shortlist.length !== result.shortlist.length || trace.shortlistScores.length !== result.shortlist.length) {
    failures.push(`${chosenId}: trace shortlist ids and scored shortlist must preserve candidate count`);
  }
  for (const candidate of trace.shortlistScores) {
    if (!trace.shortlist.includes(candidate.id)) {
      failures.push(`${chosenId}: scored candidate '${candidate.id}' is not present in shortlist ids`);
    }
    for (const dimension of dimensions) {
      if (!(dimension in candidate.breakdown)) {
        failures.push(`${chosenId}: candidate '${candidate.id}' missing trace breakdown dimension '${dimension}'`);
      }
      if (!result.rationale.includes(`${dimension}=`)) {
        failures.push(`${chosenId}: rationale missing public breakdown dimension '${dimension}'`);
      }
      if (!progress.includes(`${dimension}=`)) {
        failures.push(`${chosenId}: progress summary missing public breakdown dimension '${dimension}'`);
      }
    }
  }
  if (options?.pinned) {
    const only = trace.shortlistScores[0];
    if (trace.shortlistScores.length !== 1 || only?.deterministicScore !== 999) {
      failures.push(`${chosenId}: pinned trace should contain one explicit 999-score candidate`);
    }
  }
  if (progress.includes(result.rationale) || progress.includes("rawPrompt")) {
    failures.push(`${chosenId}: progress summary should stay compact and must not expose raw prompt/rationale payloads`);
  }
}

function modelReturning(reply: (request: JsonOnlyModelRequest) => unknown): JsonOnlyModelClient {
  return {
    completeJson: async (request) => reply(request)
  };
}

function caseFor(
  expected: string,
  audience: IntentIR["audience"],
  format: IntentIR["format"],
  tone: IntentIR["tone"],
  topic: string,
  prompt: string
): { expected: string; intent: IntentIR; prompt: string } {
  return {
    expected,
    prompt,
    intent: {
      topic,
      language: "zh-CN",
      audience,
      tone,
      format,
      hardConstraints: {
        slideCount: 10,
        narrativeChars: 1500,
        requiredSections: []
      },
      preferences: {
        aestheticHints: [],
        forbiddenThemes: [],
        domainTerminology: prompt.split(/\s+/).filter(Boolean).slice(0, 10),
        knowledgeCutoffWarning: false
      },
      derivedSlideCount: 10,
      derivedNarrativeChars: 1500
    }
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
