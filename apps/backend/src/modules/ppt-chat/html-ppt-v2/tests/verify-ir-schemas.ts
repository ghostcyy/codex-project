import { deckIrSchema, type DeckIR } from "../ir";
import { sampleDeckIr } from "./fixtures/sample-deck-ir";
import { deckIrFixtures } from "./fixtures/deck-ir-fixtures";

function cloneDeck(): DeckIR {
  return JSON.parse(JSON.stringify(sampleDeckIr)) as DeckIR;
}

function expectPass(name: string, value: unknown) {
  const result = deckIrSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`${name} should pass but failed: ${result.error.issues.map((issue) => issue.message).join("; ")}`);
  }
}

function expectFail(name: string, value: unknown, expectedMessage: string) {
  const result = deckIrSchema.safeParse(value);
  if (result.success) {
    throw new Error(`${name} should fail but passed.`);
  }

  const messages = result.error.issues.map((issue) => issue.message).join("\n");
  if (!messages.includes(expectedMessage)) {
    throw new Error(`${name} failed for the wrong reason. Expected message containing '${expectedMessage}', got:\n${messages}`);
  }
}

if (deckIrFixtures.length !== 5) {
  throw new Error(`Expected 5 DeckIR fixtures, got ${deckIrFixtures.length}.`);
}

for (const [index, fixture] of deckIrFixtures.entries()) {
  expectPass(`deckIrFixtures[${index}]`, fixture);
}

{
  const bad = cloneDeck();
  bad.intent.derivedSlideCount = 5;
  expectFail("slide-count mismatch", bad, "Narrative slide count must match intent.derivedSlideCount.");
}

{
  const bad = cloneDeck() as unknown as { layoutPlan: Array<{ layoutId: string }> };
  bad.layoutPlan[2]!.layoutId = "unknown-layout";
  expectFail("unknown layout", bad, "Invalid option");
}

{
  const bad = cloneDeck();
  bad.narrative.slides[2]!.contentBrief.evidenceRefs.push("missing-citation");
  expectFail("unresolved citation", bad, "Unresolved citationKey: missing-citation");
}

{
  const bad = cloneDeck();
  bad.evidence.dataPoints[0]!.citationKey = bad.evidence.facts[0]!.citationKey.toUpperCase();
  expectFail("duplicate cross evidence citation", bad, "Duplicate citationKey");
}

{
  const bad = cloneDeck();
  bad.design.contrastReport.passed = false;
  bad.design.contrastReport.issues.push("Low text/background contrast.");
  expectFail("bad contrast", bad, "DesignSystemIR cannot lock a theme that fails its contrast report.");
}

{
  const bad = cloneDeck();
  bad.design.themeTokens.palette.bg = "#fff; } body { background:red";
  expectFail("unsafe theme color token", bad, "CSS color token must be a safe registry color value.");
}

{
  const bad = cloneDeck();
  bad.design.themeTokens.typography.fontDisplay = "Aptos; } body { color:red";
  expectFail("unsafe theme font token", bad, "CSS font token must be a safe registry font family.");
}

{
  const bad = cloneDeck();
  bad.design.themeTokens.elevation.shadowSm = "0 0 0 red; } .slide { display:none";
  expectFail("unsafe theme shadow token", bad, "CSS shadow token must be a safe registry shadow value.");
}

{
  const bad = cloneDeck();
  bad.layoutPlan[2]!.layoutId = "kpi-grid";
  expectFail("slot layout mismatch", bad, "must match layout");
}

{
  const bad = cloneDeck() as unknown as { assets: Record<string, unknown> };
  bad.assets["raw-background"] = {
    kind: "background-svg",
    svgInline: "<svg><script>alert(1)</script></svg>"
  };
  expectFail("raw background svg asset", bad, "Invalid input");
}

{
  const bad = cloneDeck() as unknown as { assets: Record<string, unknown> };
  bad.assets["chart-with-unknown-config"] = {
    kind: "chart",
    chartType: "bar",
    chartConfig: {
      title: "Unsafe chart",
      labels: ["A"],
      series: [{ label: "A", data: [1], color: "#fff" }],
      callback: "function() { return window.location; }"
    },
    sourceCitationKeys: []
  };
  expectFail("chart config unknown key", bad, "Unrecognized key");
}

{
  const bad = cloneDeck() as unknown as { assets: Record<string, unknown> };
  bad.assets["chart-with-unsafe-color"] = {
    kind: "chart",
    chartType: "bar",
    chartConfig: {
      title: "Unsafe chart",
      labels: ["A"],
      series: [{ label: "A", data: [1], color: "#fff; } body { color:red" }]
    },
    sourceCitationKeys: []
  };
  expectFail("chart config unsafe color", bad, "CSS color token must be a safe registry color value.");
}

{
  const bad = cloneDeck() as unknown as { choreography: Array<{ builds: Array<{ target: string }> }> };
  bad.choreography[1]!.builds[0]!.target = "h1";
  expectFail("unsafe choreography target", bad, "Invalid option");
}

console.log("HTML-PPT v2 IR schema verification passed.");
