import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const inputPath = getArgValue(args, "--input") || process.env.HTML_PPT_SMOKE_REPORT_INPUT || "";
const outputPath = getArgValue(args, "--output") || process.env.HTML_PPT_SMOKE_REPORT_OUTPUT || "";
const smokeDir = resolve(process.env.HTML_PPT_SMOKE_OUTPUT_DIR || ".local-runtime/logs/smoke");

const reportInput = inputPath ? resolve(inputPath) : await findLatestSmokeRecord(smokeDir);
const record = JSON.parse(await readFile(reportInput, "utf8"));
const markdown = buildReport(record, reportInput);
const reportOutput = outputPath
  ? resolve(outputPath)
  : join(dirname(reportInput), `${basename(reportInput, ".json")}.md`);

await writeFile(reportOutput, markdown, "utf8");
console.log(reportOutput);

async function findLatestSmokeRecord(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const candidates = entries
    .filter((entry) => entry.isFile() && /^html-ppt-quick-smoke-.*\.json$/.test(entry.name))
    .map((entry) => join(directory, entry.name));
  if (candidates.length === 0) {
    throw new Error(`No smoke JSON records found in ${directory}`);
  }
  const stats = await Promise.all(candidates.map(async (path) => {
    const { stat } = await import("node:fs/promises");
    return { path, mtimeMs: (await stat(path)).mtimeMs };
  }));
  return stats.sort((a, b) => b.mtimeMs - a.mtimeMs)[0].path;
}

function buildReport(record, sourcePath) {
  const results = Array.isArray(record.results) ? record.results : [];
  const compareMode = record.mode === "v1-v2-comparison";
  const lines = [
    "# HTML-PPT V1/V2 Smoke Comparison Report",
    "",
    `- Source: \`${sourcePath}\``,
    `- Mode: \`${record.mode ?? "unknown"}\``,
    `- Started: ${record.startedAt ?? "unknown"}`,
    `- Finished: ${record.finishedAt ?? "not finished in record"}`,
    `- Duration: ${formatDuration(record.durationMs)}`,
    `- Cases: ${results.length}`,
    ""
  ];

  if (!compareMode) {
    lines.push("This record is not a V1/V2 comparison run.");
    return lines.join("\n");
  }

  const aggregate = aggregateComparison(results);
  lines.push("## Summary", "");
  lines.push(...summaryTable(aggregate));
  lines.push("");

  lines.push("## Case Results", "");
  lines.push("| Case | Gate | Expected | V1 Slides | V2 Slides | V1 Status | V2 Status | V1 Leak | V2 Leak | V2 Contrast | V2 Hard | V2 Obstruction | Notes |");
  lines.push("|---|---:|---:|---:|---:|---|---|---:|---:|---|---:|---:|---|");
  for (const result of results) {
    const comparison = result.comparison ?? {};
    const v1 = result.v1 ?? {};
    const v2 = result.v2 ?? {};
    const notes = [
      ...(comparison.v2GateIssues ?? []),
      v1.errorMessage ? `V1: ${shorten(v1.errorMessage, 80)}` : null,
      v2.errorMessage ? `V2: ${shorten(v2.errorMessage, 80)}` : null
    ].filter(Boolean).join("<br>");
    lines.push([
      result.name ?? "unknown",
      comparison.v2GatePassed ? "PASS" : "FAIL",
      result.expectedSlides ?? comparison.expectedSlides ?? "",
      v1.slideCount ?? "",
      v2.slideCount ?? "",
      v1.status ?? "",
      v2.status ?? "",
      v1.previewAnalysis?.forbiddenTextHits?.length ?? "",
      v2.previewAnalysis?.forbiddenTextHits?.length ?? "",
      stringifyBool(v2.manifestAnalysis?.contrastPassed),
      v2.verificationAnalysis?.hardIssueCount ?? "",
      v2.verificationAnalysis?.obstructionIssueCount ?? "",
      notes || ""
    ].map(cell).join("|").replace(/^/, "|").replace(/$/, "|"));
  }
  lines.push("");

  lines.push("## Failed V2 Gate Issues", "");
  const failed = results.filter((result) => !result.comparison?.v2GatePassed);
  if (failed.length === 0) {
    lines.push("- None.");
  } else {
    for (const result of failed) {
      lines.push(`- ${result.name}: ${(result.comparison?.v2GateIssues ?? ["unknown failure"]).join("; ")}`);
    }
  }
  lines.push("");

  lines.push("## Next Fix Candidates", "");
  lines.push(...recommendations(aggregate));
  lines.push("");

  return lines.join("\n");
}

function aggregateComparison(results) {
  const count = results.length;
  const v1Completed = results.filter((item) => item.v1?.status === "completed").length;
  const v2Completed = results.filter((item) => item.v2?.status === "completed").length;
  const v1SlideExact = results.filter((item) => item.v1?.slideCountExact === true).length;
  const v2SlideExact = results.filter((item) => item.v2?.slideCountExact === true).length;
  const v1LeakCases = results.filter((item) => (item.v1?.previewAnalysis?.forbiddenTextHits?.length ?? 0) > 0).length;
  const v2LeakCases = results.filter((item) => (item.v2?.previewAnalysis?.forbiddenTextHits?.length ?? 0) > 0).length;
  const v2ContrastFailures = results.filter((item) => item.v2?.manifestAnalysis?.contrastPassed === false).length;
  const v2HardIssueCases = results.filter((item) => (item.v2?.verificationAnalysis?.hardIssueCount ?? 0) > 0).length;
  const v2ObstructionCases = results.filter((item) => (item.v2?.verificationAnalysis?.obstructionIssueCount ?? 0) > 0).length;
  const v2GatePassed = results.filter((item) => item.comparison?.v2GatePassed === true).length;
  return {
    count,
    v1Completed,
    v2Completed,
    v1SlideExact,
    v2SlideExact,
    v1LeakCases,
    v2LeakCases,
    v2ContrastFailures,
    v2HardIssueCases,
    v2ObstructionCases,
    v2GatePassed
  };
}

function summaryTable(aggregate) {
  return [
    "| Metric | V1 | V2 |",
    "|---|---:|---:|",
    `| Completed cases | ${aggregate.v1Completed}/${aggregate.count} | ${aggregate.v2Completed}/${aggregate.count} |`,
    `| Exact slide count | ${aggregate.v1SlideExact}/${aggregate.count} | ${aggregate.v2SlideExact}/${aggregate.count} |`,
    `| Donor/runtime leak cases | ${aggregate.v1LeakCases}/${aggregate.count} | ${aggregate.v2LeakCases}/${aggregate.count} |`,
    `| Contrast failures | n/a | ${aggregate.v2ContrastFailures}/${aggregate.count} |`,
    `| Verification hard issue cases | n/a | ${aggregate.v2HardIssueCases}/${aggregate.count} |`,
    `| Obstruction/overflow issue cases | n/a | ${aggregate.v2ObstructionCases}/${aggregate.count} |`,
    `| V2 migration gate passed | n/a | ${aggregate.v2GatePassed}/${aggregate.count} |`
  ];
}

function recommendations(aggregate) {
  const items = [];
  if (aggregate.v2Completed < aggregate.count) {
    items.push("- Fix V2 generation failures first; reliability blocks all later migration decisions.");
  }
  if (aggregate.v2SlideExact < aggregate.count) {
    items.push("- Prioritize slide-count fidelity in Stage 1 intent, Stage 3 narrative, and Stage 5 layout-plan gates.");
  }
  if (aggregate.v2LeakCases > 0) {
    items.push("- Tighten donor/runtime leakage scanner and Stage 6 slot-fill text restrictions.");
  }
  if (aggregate.v2ContrastFailures > 0) {
    items.push("- Fix theme registry contrast selection before broad traffic routing.");
  }
  if (aggregate.v2HardIssueCases > 0 || aggregate.v2ObstructionCases > 0) {
    items.push("- Inspect Stage 11 verification reports and improve layout capacity or targeted Stage 6 remediation.");
  }
  if (items.length === 0) {
    items.push("- V2 passed this corpus gate. Next step is persistent per-stage observability and a larger 100-prompt gate.");
  }
  return items;
}

function getArgValue(values, name) {
  const prefix = `${name}=`;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === name) {
      return values[index + 1] && !values[index + 1].startsWith("--") ? values[index + 1] : "";
    }
    if (value.startsWith(prefix)) {
      return value.slice(prefix.length);
    }
  }
  return "";
}

function cell(value) {
  return ` ${String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>")} `;
}

function stringifyBool(value) {
  if (value === true) return "PASS";
  if (value === false) return "FAIL";
  return "";
}

function shorten(value, max) {
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "unknown";
  const seconds = Math.round(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${rest}s`;
}
