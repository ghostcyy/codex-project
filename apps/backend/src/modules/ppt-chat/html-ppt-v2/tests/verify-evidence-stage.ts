import { runEvidenceStage, runIntentStage, type JsonOnlyModelClient, type ResearchClient } from "../stages";

async function main() {
  const intentResult = await runIntentStage({
    userPrompt: "制作一个12页的HTML PPT，主题为AI云服务器的应用和未来，约1500字，面向企业管理层，风格科技商务。"
  });
  const researchClient: ResearchClient = {
    async search(queries) {
      return queries.slice(0, 3).map((query, index) => ({
        query,
        title: `Research source ${index + 1}`,
        url: `https://example.com/research-${index + 1}`,
        snippet: `Source-backed snippet for ${query.query}.`,
        publishedAt: "2026-04-01",
        sourceType: query.kind === "paper" ? "paper" : query.kind === "web-stat" ? "data" : "web"
      }));
    }
  };
  const calls: Array<{ system: string; user: string }> = [];
  const model: JsonOnlyModelClient = {
    async completeJson(request) {
      calls.push({ system: request.system, user: request.user });
      if (calls.length === 1) {
        return {
          facts: [
            {
              claim: "",
              confidence: "high",
              sources: [],
              citationKey: "x"
            }
          ]
        };
      }

      return JSON.stringify({
        facts: [
          {
            claim: "AI云服务器需要同时解释算力弹性、数据安全、成本模型和行业落地场景。",
            confidence: "medium",
            sources: [{ url: "https://example.com/research-1", title: "Research source 1", type: "web" }],
            citationKey: "ai-cloud"
          },
          {
            claim: "企业管理层更关心AI基础设施如何转化为速度、风险控制和可持续预算。",
            confidence: "medium",
            sources: [{ url: "https://example.com/research-2", title: "Research source 2", type: "data" }],
            citationKey: "ai-cloud"
          }
        ],
        dataPoints: [
          {
            metric: "部署周期",
            value: "按业务场景差异化评估",
            source: "ai-cloud",
            citationKey: "AI-CLOUD"
          }
        ],
        candidateVisuals: [
          {
            kind: "chart-data",
            description: "展示AI云服务器在成本、性能和安全之间的取舍。",
            relevanceScore: 0.82
          }
        ],
        terminology: [
          {
            term: "AI云服务器",
            definition: "为AI训练、推理或数据处理工作负载配置的弹性云端算力环境。",
            usage: "technical"
          }
        ],
        narrativeAngles: [
          {
            angle: "从基础设施到业务结果",
            tradeoffs: "适合管理层理解价值链，但需要后续补充行业案例。"
          }
        ],
        knownGaps: []
      });
    }
  };

  const result = await runEvidenceStage({ intent: intentResult.intent, model, researchClient });
  if (result.source !== "model" || result.attempts !== 2 || calls.length !== 2) {
    throw new Error("Evidence stage should retry once and accept corrected model JSON.");
  }

  if (!calls[1]?.user.includes("The previous JSON failed validation.")) {
    throw new Error("Evidence retry prompt must include validation feedback.");
  }

  if (result.researchQueries.length < 5 || result.researchHits.length !== 3) {
    throw new Error("Evidence stage should build deterministic research queries and use ResearchClient hits.");
  }

  const citationKeys = [
    ...result.evidence.facts.map((fact) => fact.citationKey),
    ...result.evidence.dataPoints.map((point) => point.citationKey)
  ];
  if (new Set(citationKeys).size !== citationKeys.length) {
    throw new Error("Evidence stage must normalize duplicate fact/dataPoint citation keys.");
  }

  if (!result.evidence.facts.every((fact) => fact.sources.length >= 1)) {
    throw new Error("Every evidence fact must have at least one source.");
  }

  const fallback = await runEvidenceStage({ intent: intentResult.intent });
  if (fallback.source !== "fallback" || fallback.evidence.facts.length < 3 || !fallback.evidence.knownGaps.length) {
    throw new Error("Evidence stage fallback must produce a valid EvidencePack with known gaps.");
  }

  const fallbackCitationKeys = [
    ...fallback.evidence.facts.map((fact) => fact.citationKey),
    ...fallback.evidence.dataPoints.map((point) => point.citationKey)
  ];
  if (fallbackCitationKeys.some((key) => /^section-\d+$/i.test(key) || ["topic-context", "audience-fit", "scope-lock"].includes(key))) {
    throw new Error("Evidence stage fallback must not emit generic placeholder citation keys.");
  }
  if (!fallback.evidence.facts.some((fact) => fact.internalOnly) || !fallback.evidence.dataPoints.every((point) => point.internalOnly)) {
    throw new Error("Evidence stage fallback must mark orchestration-only facts and data points as internalOnly.");
  }
  if (fallback.evidence.facts.filter((fact) => !fact.internalOnly).length < 2) {
    throw new Error("Evidence stage fallback must still expose at least two user-visible facts for downstream narrative/slot-fill stages.");
  }

  console.log("HTML-PPT v2 evidence stage verification passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
