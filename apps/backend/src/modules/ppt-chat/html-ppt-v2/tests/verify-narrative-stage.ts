import {
  runEvidenceStage,
  runIntentStage,
  runNarrativeStage,
  type JsonOnlyModelClient
} from "../stages";

async function main() {
  const previousCandidateEnv = process.env.HTML_PPT_V2_NARRATIVE_CANDIDATES;
  process.env.HTML_PPT_V2_NARRATIVE_CANDIDATES = "1";
  const intent = (await runIntentStage({
    userPrompt: "制作一个6页HTML PPT，主题为力量举的前世今生，1000字，适合学生，要求包含历史、规则、冠军。"
  })).intent;
  const evidence = (await runEvidenceStage({ intent })).evidence;
  const calls: Array<{ system: string; user: string }> = [];
  const model: JsonOnlyModelClient = {
    async completeJson(request) {
      calls.push({ system: request.system, user: request.user });
      if (calls.length === 1) {
        return {
          arc: "chronological",
          slides: [
            {
              index: 1,
              role: "cover",
              beat: "Open the topic.",
              contentBrief: {
                headline: "力量举的前世今生",
                supportingPoints: ["建立主题。"],
                evidenceRefs: ["topic-brief"]
              },
              densityBudget: "sparse",
              estimatedNarrativeChars: 200
            }
          ],
          totalEstimatedChars: 200,
          transitions: []
        };
      }

      return JSON.stringify({
        arc: "chronological",
        slides: [
          {
            index: 1,
            role: "cover",
            beat: "用力量举的核心问题打开。",
            contentBrief: {
              headline: "力量举的前世今生",
              subhead: "从力量文化到竞技体系",
              supportingPoints: ["解释力量举为什么是一项清晰、可量化、可训练的力量运动。"],
              evidenceRefs: ["topic-brief"]
            },
            densityBudget: "sparse",
            estimatedNarrativeChars: 150
          },
          {
            index: 2,
            role: "toc",
            beat: "给出内容地图。",
            contentBrief: {
              headline: "内容地图",
              supportingPoints: ["历史", "规则", "冠军", "训练启示"],
              evidenceRefs: ["audience-brief"]
            },
            densityBudget: "sparse",
            estimatedNarrativeChars: 120
          },
          {
            index: 3,
            role: "context",
            beat: "解释历史脉络。",
            contentBrief: {
              headline: "力量举如何从力量文化走向现代竞技",
              supportingPoints: ["从民间力量展示到标准化项目，力量举逐步形成明确比赛逻辑。"],
              evidenceRefs: ["topic-brief"]
            },
            densityBudget: "balanced",
            estimatedNarrativeChars: 220
          },
          {
            index: 4,
            role: "analysis",
            beat: "解释比赛规则。",
            contentBrief: {
              headline: "深蹲、卧推、硬拉构成了力量举的判断框架",
              supportingPoints: ["三项动作把下肢、上肢和后链力量组合成总成绩。"],
              evidenceRefs: ["audience-brief"],
              keyMetrics: ["Audience focus"]
            },
            densityBudget: "dense",
            estimatedNarrativeChars: 230
          },
          {
            index: 5,
            role: "case-study",
            beat: "连接冠军案例。",
            contentBrief: {
              headline: "冠军故事把训练方法变成可理解的样板",
              supportingPoints: ["国内外冠军可以用于解释级别、专项技术和长期训练周期。"],
              evidenceRefs: ["topic-brief"]
            },
            densityBudget: "balanced",
            estimatedNarrativeChars: 200
          },
          {
            index: 6,
            role: "cta",
            beat: "收束到学习行动。",
            contentBrief: {
              headline: "理解力量举，从规则和动作开始",
              supportingPoints: ["用安全技术和长期计划理解力量举，而不是只看重量数字。"],
              evidenceRefs: ["audience-brief"]
            },
            densityBudget: "sparse",
            estimatedNarrativeChars: 120
          }
        ],
        totalEstimatedChars: 1040,
        transitions: [
          { fromSlide: 1, toSlide: 2, bridge: "从主题进入结构。" },
          { fromSlide: 2, toSlide: 3, bridge: "从目录进入历史。" },
          { fromSlide: 3, toSlide: 4, bridge: "从历史进入规则。" },
          { fromSlide: 4, toSlide: 5, bridge: "从规则进入人物。" },
          { fromSlide: 5, toSlide: 6, bridge: "从人物回到行动。" }
        ]
      });
    }
  };

  const result = await runNarrativeStage({ intent, evidence, model });
  if (result.source !== "model" || result.attempts !== 2 || calls.length !== 2) {
    throw new Error("Narrative stage should retry once and accept corrected model JSON.");
  }

  if (!calls[1]?.user.includes("The previous JSON failed validation.")) {
    throw new Error("Narrative retry prompt must include validation feedback.");
  }

  if (result.narrative.slides.length !== intent.derivedSlideCount) {
    throw new Error("Narrative stage must preserve exact slide count.");
  }

  if (result.narrative.totalEstimatedChars < intent.derivedNarrativeChars) {
    throw new Error("Narrative stage must satisfy requested narrative length.");
  }

  const availableRefs = new Set([
    ...evidence.facts.map((fact) => fact.citationKey),
    ...evidence.dataPoints.map((point) => point.citationKey)
  ]);
  for (const slide of result.narrative.slides) {
    for (const ref of slide.contentBrief.evidenceRefs) {
      if (!availableRefs.has(ref)) {
        throw new Error(`Narrative stage emitted unresolved evidence ref: ${ref}`);
      }
    }
  }

  const fallback = await runNarrativeStage({ intent, evidence });
  if (
    fallback.source !== "fallback" ||
    fallback.narrative.slides.length !== intent.derivedSlideCount ||
    fallback.narrative.totalEstimatedChars < intent.derivedNarrativeChars
  ) {
    throw new Error("Narrative stage fallback must produce valid count-locked NarrativeIR.");
  }

  process.env.HTML_PPT_V2_NARRATIVE_CANDIDATES = "3";
  let sampleCalls = 0;
  const sampledModel: JsonOnlyModelClient = {
    async completeJson() {
      sampleCalls += 1;
      const candidate = JSON.parse(JSON.stringify(result.narrative)) as typeof result.narrative;
      candidate.totalEstimatedChars = Math.round(intent.derivedNarrativeChars * (sampleCalls === 2 ? 1.08 : 1.01));
      candidate.slides = candidate.slides.map((slide, index) => ({
        ...slide,
        contentBrief: {
          ...slide.contentBrief,
          headline: sampleCalls === 2 && index === 2 ? "Best sampled narrative" : slide.contentBrief.headline,
          supportingPoints: sampleCalls === 2
            ? [slide.contentBrief.supportingPoints[0] ?? "核心观点", "补充证据", "行动含义"]
            : [slide.contentBrief.supportingPoints[0] ?? "核心观点"]
        },
        estimatedNarrativeChars: Math.max(slide.estimatedNarrativeChars, Math.round(intent.derivedNarrativeChars / intent.derivedSlideCount))
      }));
      return JSON.stringify(candidate);
    }
  };
  const sampled = await runNarrativeStage({ intent, evidence, model: sampledModel });
  if (sampleCalls !== 3 || sampled.attempts !== 3 || sampled.narrative.slides[2]?.contentBrief.headline !== "Best sampled narrative") {
    throw new Error("Narrative stage should sample three first-pass candidates and choose the highest-scoring candidate.");
  }

  if (previousCandidateEnv === undefined) {
    delete process.env.HTML_PPT_V2_NARRATIVE_CANDIDATES;
  } else {
    process.env.HTML_PPT_V2_NARRATIVE_CANDIDATES = previousCandidateEnv;
  }

  console.log("HTML-PPT v2 narrative stage verification passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
