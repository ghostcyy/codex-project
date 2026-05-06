import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const smokeDir = resolve(process.env.HTML_PPT_SMOKE_OUTPUT_DIR || ".local-runtime/logs/smoke");
const inputPaths = collectInputs(args);
const thresholds = {
  minCases: numberArg(args, "--min-cases", envNumber("HTML_PPT_V2_GATE_MIN_CASES", 20)),
  minPassRate: numberArg(args, "--min-pass-rate", envNumber("HTML_PPT_V2_GATE_MIN_PASS_RATE", 1)),
  maxLeakCases: numberArg(args, "--max-leak-cases", envNumber("HTML_PPT_V2_GATE_MAX_LEAK_CASES", 0)),
  maxContrastFailures: numberArg(args, "--max-contrast-failures", envNumber("HTML_PPT_V2_GATE_MAX_CONTRAST_FAILURES", 0)),
  maxHardIssueCases: numberArg(args, "--max-hard-issue-cases", envNumber("HTML_PPT_V2_GATE_MAX_HARD_ISSUE_CASES", 0)),
  maxObstructionIssueCases: numberArg(args, "--max-obstruction-issue-cases", envNumber("HTML_PPT_V2_GATE_MAX_OBSTRUCTION_ISSUE_CASES", 0)),
  requireExactSlideCount: booleanArg(args, "--require-exact-slide-count", envBoolean("HTML_PPT_V2_GATE_REQUIRE_EXACT_SLIDE_COUNT", true))
};
const resolvedInputs = inputPaths.length > 0
  ? inputPaths.map((item) => resolve(item))
  : await findRecentSmokeRecords(smokeDir, thresholds.minCases);

const records = await Promise.all(resolvedInputs.map(readSmokeRecord));
const results = mergeResultsByName(records);
const aggregate = aggregateResults(results);
const failures = evaluateGate(aggregate, thresholds);
const reportText = buildMarkdownReport({ inputs: resolvedInputs, aggregate, thresholds, failures });

printSummary({ inputs: resolvedInputs, aggregate, thresholds, failures });
await maybeWriteReport(args, reportText);

if (failures.length > 0) {
  process.exitCode = 1;
}

async function readSmokeRecord(path) {
  const record = JSON.parse(await readFile(path, "utf8"));
  if (record.mode !== "v1-v2-comparison" && !(record.mode === "single-pipeline" && record.pipeline === "v2")) {
    throw new Error(`Migration gate accepts v1-v2 comparison records or single-pipeline v2 records: ${path}`);
  }
  if (!Array.isArray(record.results)) {
    throw new Error(`Smoke record has no results array: ${path}`);
  }
  return { path, record };
}

function mergeResultsByName(records) {
  const merged = new Map();
  for (const { path, record } of records) {
    record.results.forEach((result, index) => {
      const key = String(result.name || `${path}#${index + 1}`);
      if (merged.has(key)) {
        merged.delete(key);
      }
      merged.set(key, { ...result, sourcePath: path });
    });
  }
  return [...merged.values()];
}

function aggregateResults(results) {
  const count = results.length;
  const v2Completed = results.filter((item) => v2Result(item)?.status === "completed").length;
  const v2SlideExact = results.filter((item) => v2Result(item)?.slideCountExact === true || item.comparison?.v2SlideCountExact === true).length;
  const v2GatePassed = results.filter((item) => gatePassed(item)).length;
  const v2LeakCases = results.filter((item) => {
    const v2 = v2Result(item);
    const hits = v2?.previewAnalysis?.forbiddenTextHits?.length ?? item.comparison?.v2ForbiddenTextHits ?? 0;
    return hits > 0;
  }).length;
  const v2ContrastFailures = results.filter((item) => {
    const v2 = v2Result(item);
    const passed = v2?.manifestAnalysis?.contrastPassed ?? item.comparison?.v2ContrastPassed;
    return passed === false;
  }).length;
  const v2HardIssueCases = results.filter((item) => {
    const v2 = v2Result(item);
    const issueCount = v2?.verificationAnalysis?.hardIssueCount ?? item.comparison?.v2HardIssueCount ?? 0;
    return issueCount > 0;
  }).length;
  const v2ObstructionIssueCases = results.filter((item) => {
    const v2 = v2Result(item);
    const issueCount = v2?.verificationAnalysis?.obstructionIssueCount ?? item.comparison?.v2ObstructionIssueCount ?? 0;
    return issueCount > 0;
  }).length;
  const failedCases = results
    .filter((item) => !gatePassed(item))
    .map((item) => ({
      name: item.name ?? "unknown",
      sourcePath: item.sourcePath,
      issues: item.comparison?.v2GateIssues ?? gateIssues(item)
    }));

  return {
    count,
    v2Completed,
    v2SlideExact,
    v2GatePassed,
    v2GatePassRate: count > 0 ? v2GatePassed / count : 0,
    v2LeakCases,
    v2ContrastFailures,
    v2HardIssueCases,
    v2ObstructionIssueCases,
    failedCases
  };
}

function v2Result(item) {
  return item.v2 ?? (item.pipeline === "v2" ? item : null);
}

function gatePassed(item) {
  if (item.comparison?.v2GatePassed === true) return true;
  const issues = gateIssues(item);
  return issues.length === 0;
}

function gateIssues(item) {
  const v2 = v2Result(item);
  if (!v2) return ["missing v2 result"];
  const expectedSlides = item.expectedSlides ?? null;
  const forbiddenHits = v2.previewAnalysis?.forbiddenTextHits?.length ?? 0;
  const hardIssues = v2.verificationAnalysis?.hardIssueCount ?? 0;
  const obstructionIssues = v2.verificationAnalysis?.obstructionIssueCount ?? 0;
  return [
    v2.status === "completed" ? null : `v2 status=${v2.status ?? "unknown"}`,
    v2.slideCountExact === false ? `v2 slide count ${v2.slideCount} != expected ${expectedSlides}` : null,
    forbiddenHits > 0 ? `v2 donor/text leakage hits=${forbiddenHits}` : null,
    v2.manifestAnalysis?.contrastPassed === false ? "v2 contrast failed" : null,
    hardIssues > 0 ? `v2 hard verification issues=${hardIssues}` : null,
    obstructionIssues > 0 ? `v2 obstruction/overflow issues=${obstructionIssues}` : null,
    v2.errorMessage ? `v2 error=${v2.errorMessage}` : null
  ].filter(Boolean);
}

function evaluateGate(aggregate, limits) {
  const failures = [];
  if (aggregate.count < limits.minCases) {
    failures.push(`case count ${aggregate.count} is below required minimum ${limits.minCases}`);
  }
  if (aggregate.v2GatePassRate < limits.minPassRate) {
    failures.push(`V2 gate pass rate ${percent(aggregate.v2GatePassRate)} is below required ${percent(limits.minPassRate)}`);
  }
  if (limits.requireExactSlideCount && aggregate.v2SlideExact !== aggregate.count) {
    failures.push(`exact slide-count cases ${aggregate.v2SlideExact}/${aggregate.count}; expected all cases exact`);
  }
  if (aggregate.v2LeakCases > limits.maxLeakCases) {
    failures.push(`donor/runtime leak cases ${aggregate.v2LeakCases}; allowed ${limits.maxLeakCases}`);
  }
  if (aggregate.v2ContrastFailures > limits.maxContrastFailures) {
    failures.push(`contrast failures ${aggregate.v2ContrastFailures}; allowed ${limits.maxContrastFailures}`);
  }
  if (aggregate.v2HardIssueCases > limits.maxHardIssueCases) {
    failures.push(`hard verification issue cases ${aggregate.v2HardIssueCases}; allowed ${limits.maxHardIssueCases}`);
  }
  if (aggregate.v2ObstructionIssueCases > limits.maxObstructionIssueCases) {
    failures.push(`obstruction/overflow issue cases ${aggregate.v2ObstructionIssueCases}; allowed ${limits.maxObstructionIssueCases}`);
  }
  return failures;
}

function printSummary({ inputs, aggregate, thresholds, failures }) {
  console.log("HTML-PPT v2 migration gate");
  console.log(`Inputs: ${inputs.length}`);
  inputs.forEach((input) => console.log(`- ${input}`));
  console.log("");
  console.log(`Cases: ${aggregate.count}`);
  console.log(`V2 completed: ${aggregate.v2Completed}/${aggregate.count}`);
  console.log(`Exact slide count: ${aggregate.v2SlideExact}/${aggregate.count}`);
  console.log(`V2 gate pass: ${aggregate.v2GatePassed}/${aggregate.count} (${percent(aggregate.v2GatePassRate)})`);
  console.log(`Donor/runtime leak cases: ${aggregate.v2LeakCases}`);
  console.log(`Contrast failures: ${aggregate.v2ContrastFailures}`);
  console.log(`Hard verification issue cases: ${aggregate.v2HardIssueCases}`);
  console.log(`Obstruction/overflow issue cases: ${aggregate.v2ObstructionIssueCases}`);
  console.log("");
  console.log(`Thresholds: ${JSON.stringify(thresholds)}`);
  if (aggregate.failedCases.length > 0) {
    console.log("");
    console.log("Failed cases:");
    aggregate.failedCases.forEach((item) => {
      console.log(`- ${item.name}: ${item.issues.join("; ")}`);
    });
  }
  console.log("");
  if (failures.length === 0) {
    console.log("PASS: HTML-PPT v2 migration gate passed.");
  } else {
    console.log("FAIL: HTML-PPT v2 migration gate failed.");
    failures.forEach((failure) => console.log(`- ${failure}`));
  }
}

async function findRecentSmokeRecords(directory, minCases) {
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
  const newestFirst = stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const selected = [];
  const caseNames = new Set();
  for (const candidate of newestFirst) {
    const record = JSON.parse(await readFile(candidate.path, "utf8"));
    if (
      (record.mode !== "v1-v2-comparison" && !(record.mode === "single-pipeline" && record.pipeline === "v2")) ||
      !Array.isArray(record.results)
    ) {
      continue;
    }
    selected.push(candidate.path);
    record.results.forEach((result, index) => {
      caseNames.add(String(result.name || `${candidate.path}#${index + 1}`));
    });
    if (caseNames.size >= minCases) {
      break;
    }
  }
  if (selected.length === 0) {
    throw new Error(`No v1-v2 comparison smoke JSON records found in ${directory}`);
  }
  return selected.reverse();
}

async function maybeWriteReport(values, markdown) {
  const explicitOutput = getArgValue(values, "--output");
  const shouldWrite = values.includes("--write-report") || explicitOutput || process.env.HTML_PPT_V2_GATE_WRITE_REPORT === "1";
  if (!shouldWrite) return;
  const outputPath = resolve(explicitOutput || join(smokeDir, `html-ppt-v2-migration-gate-${stamp(new Date())}.md`));
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, markdown, "utf8");
  console.log(`Report: ${outputPath}`);
}

function buildMarkdownReport({ inputs, aggregate, thresholds, failures }) {
  const lines = [
    "# HTML-PPT v2 Migration Gate Report",
    "",
    "## Inputs",
    "",
    ...inputs.map((input) => `- \`${input}\``),
    "",
    "## Summary",
    "",
    "| Metric | Result |",
    "|---|---:|",
    `| Cases | ${aggregate.count} |`,
    `| V2 completed | ${aggregate.v2Completed}/${aggregate.count} |`,
    `| Exact slide count | ${aggregate.v2SlideExact}/${aggregate.count} |`,
    `| V2 gate pass | ${aggregate.v2GatePassed}/${aggregate.count} (${percent(aggregate.v2GatePassRate)}) |`,
    `| Donor/runtime leak cases | ${aggregate.v2LeakCases} |`,
    `| Contrast failures | ${aggregate.v2ContrastFailures} |`,
    `| Hard verification issue cases | ${aggregate.v2HardIssueCases} |`,
    `| Obstruction/overflow issue cases | ${aggregate.v2ObstructionIssueCases} |`,
    "",
    "## Thresholds",
    "",
    "```json",
    JSON.stringify(thresholds, null, 2),
    "```",
    "",
    "## Gate Result",
    "",
    failures.length === 0 ? "PASS" : "FAIL",
    ""
  ];
  if (failures.length) {
    lines.push("## Failures", "", ...failures.map((failure) => `- ${failure}`), "");
  }
  if (aggregate.failedCases.length) {
    lines.push("## Failed Cases", "");
    for (const item of aggregate.failedCases) {
      lines.push(`- ${item.name}: ${item.issues.join("; ")}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function collectInputs(values) {
  const inputs = [];
  const envInputs = process.env.HTML_PPT_V2_GATE_INPUTS || process.env.HTML_PPT_MIGRATION_GATE_INPUTS || "";
  if (envInputs.trim()) {
    inputs.push(...envInputs.split(",").map((item) => item.trim()).filter(Boolean));
  }
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--input") {
      const next = values[index + 1];
      if (next && !next.startsWith("--")) {
        inputs.push(next);
        index += 1;
      }
      continue;
    }
    if (value.startsWith("--input=")) {
      inputs.push(value.slice("--input=".length));
      continue;
    }
    if (value === "--inputs") {
      const next = values[index + 1];
      if (next && !next.startsWith("--")) {
        inputs.push(...next.split(",").map((item) => item.trim()).filter(Boolean));
        index += 1;
      }
      continue;
    }
    if (value.startsWith("--inputs=")) {
      inputs.push(...value.slice("--inputs=".length).split(",").map((item) => item.trim()).filter(Boolean));
    }
  }
  return inputs;
}

function numberArg(values, name, fallback) {
  const raw = getArgValue(values, name);
  if (raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanArg(values, name, fallback) {
  const raw = getArgValue(values, name);
  if (raw === "") return fallback;
  return /^(1|true|yes)$/i.test(raw);
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

function envNumber(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBoolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return /^(1|true|yes)$/i.test(value);
}

function percent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function stamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}
