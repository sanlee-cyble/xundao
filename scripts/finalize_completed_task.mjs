#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalFieldKey } from "../src/field_contracts.mjs";
import { fillDynamicWorkbook } from "../src/dynamic_workbook.mjs";
import { enrichUnmatchedExcelFields } from "../src/evidence_enrichment_service.mjs";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    options[token.slice(2)] = argv[index + 1];
    index += 1;
  }
  return options;
}

function required(options, name) {
  if (!options[name]) throw new Error(`缺少参数 --${name}`);
  return path.resolve(options[name]);
}

function relativeToProject(filePath) {
  return path.relative(path.resolve("."), path.resolve(filePath));
}

function decisionAccepted(decision) {
  return decision?.supported === true
    && decision.value !== null
    && decision.value !== undefined
    && String(decision.value).trim() !== "";
}

function mergeDecisionMaps(original = {}, incoming = {}) {
  const merged = { ...original };
  for (const [key, decision] of Object.entries(incoming)) {
    if (!decisionAccepted(merged[key]) || decisionAccepted(decision)) merged[key] = decision;
  }
  return merged;
}

function retryNeeded(result, requiredColumnKeys) {
  return requiredColumnKeys.some((key) => !decisionAccepted(result.llmFieldDecisions?.[key]));
}

function updateRecentFields(result, task, contractValues) {
  const fields = { ...(result.fields || {}) };
  for (const column of task.columns || []) {
    if (column.contract?.window !== "recent16" || !column.mapping?.name) continue;
    const key = canonicalFieldKey(column.contract);
    if (Object.hasOwn(contractValues, key)) fields[column.mapping.name] = contractValues[key];
  }
  return fields;
}

const options = parseArgs(process.argv.slice(2));
const runDir = required(options, "run-dir");
const inputPath = required(options, "input");
const outputPath = required(options, "output");
const task = JSON.parse(await fs.readFile(path.join(runDir, "task.json"), "utf8"));
const baseResults = JSON.parse(await fs.readFile(path.join(runDir, "collected-results.json"), "utf8"));
const scope2Recovery = JSON.parse(await fs.readFile(path.join(runDir, "scope2-ui-recovery.json"), "utf8"));
const recent16Recovery = JSON.parse(await fs.readFile(path.join(runDir, "recent16-ui-recovery.json"), "utf8"));
const scope2ByCreator = new Map(scope2Recovery.map((item) => [item.creatorId, item]));
const recent16ByCreator = new Map(recent16Recovery.map((item) => [item.creatorId, item]));

const mergedResults = baseResults.map((result) => {
  const scope2 = scope2ByCreator.get(result.creatorId);
  const recent16 = recent16ByCreator.get(result.creatorId);
  if (!scope2?.ok) throw new Error(`${result.nickname || result.creatorId} 缺少 90 天合作全流量恢复结果`);
  if (!recent16?.ok) throw new Error(`${result.nickname || result.creatorId} 缺少近16篇恢复结果`);
  const contractValues = {
    ...(result.contractValues || {}),
    ...(scope2.contractValues || {}),
    ...(recent16.contractValues || {}),
  };
  const recoveredKeys = new Set([
    ...Object.keys(scope2.contractValues || {}),
    ...Object.keys(recent16.contractValues || {}),
  ]);
  const missingFields = (result.missingFields || []).filter((key) => !recoveredKeys.has(key));
  const evidenceFiles = [
    ...(result.evidenceFiles || []),
    ...(scope2.evidencePath ? [relativeToProject(scope2.evidencePath)] : []),
    ...(recent16.evidencePaths || []).map(relativeToProject),
  ];
  return {
    ...result,
    fields: {
      ...updateRecentFields(result, task, recent16.contractValues || {}),
      "90天合作笔记样本数": scope2.noteNumber,
    },
    contractValues,
    missingFields,
    dataStatus: missingFields.length ? "部分缺失" : "成功",
    errorReason: missingFields.length ? `缺少字段：${missingFields.join("、")}` : "",
    evidenceFiles: [...new Set(evidenceFiles)],
    metricScope: {
      ...(result.metricScope || {}),
      label: `动态字段合同第 ${task.taskContract?.version || 1} 版（页面原生交互补采）`,
      requests: [
        ...(result.metricScope?.requests || []),
        {
          id: `${result.creatorId}:scope-2:ui-recovery`,
          ok: true,
          status: 200,
          resumed: true,
          recoveredFromNativeUi: true,
        },
        {
          id: `${result.creatorId}:scope-5:ui-recovery`,
          ok: true,
          status: 200,
          resumed: true,
          recoveredFromNativeUi: true,
        },
      ],
    },
  };
});

await fs.writeFile(
  path.join(runDir, "merged-results.json"),
  `${JSON.stringify(mergedResults, null, 2)}\n`,
  "utf8",
);

const warnings = [];
let enriched = await enrichUnmatchedExcelFields(mergedResults, task, {
  failOpen: false,
  batchSize: 3,
  concurrency: 2,
  maxAttempts: 2,
  timeoutMs: 90000,
  onWarning: (warning) => warnings.push(warning),
  onCall: (event) => {
    if (event?.stage) console.log(`DeepSeek：${event.stage}`);
  },
});

const requiredLabels = new Set(["序号", "达人类型", "账号数据表现", "推荐理由", "内容方向"]);
const requiredColumnKeys = task.unmatchedColumns
  .filter((column) => requiredLabels.has(column.displayLabel))
  .map((column) => column.key);

for (let attempt = 1; attempt <= 2; attempt += 1) {
  const indexes = enriched
    .map((result, index) => retryNeeded(result, requiredColumnKeys) ? index : -1)
    .filter((index) => index >= 0);
  if (!indexes.length) break;
  console.log(`DeepSeek 逐行补充第 ${attempt} 轮：${indexes.length} 行`);
  let cursor = 0;
  let completed = 0;
  async function retryWorker() {
    while (cursor < indexes.length) {
      const index = indexes[cursor];
      cursor += 1;
      const retryWarnings = [];
      const [retried] = await enrichUnmatchedExcelFields([mergedResults[index]], task, {
        failOpen: false,
        batchSize: 1,
        concurrency: 1,
        maxAttempts: 1,
        timeoutMs: 90000,
        onWarning: (warning) => retryWarnings.push(warning),
      });
      warnings.push(...retryWarnings);
      enriched[index] = {
        ...enriched[index],
        llmFieldDecisions: mergeDecisionMaps(
          enriched[index].llmFieldDecisions,
          retried.llmFieldDecisions,
        ),
        llmModel: enriched[index].llmModel || retried.llmModel,
      };
      completed += 1;
      console.log(`DeepSeek 第 ${attempt} 轮：${completed}/${indexes.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, indexes.length) }, () => retryWorker()));
}

const unresolvedModelCells = enriched.flatMap((result) => requiredColumnKeys
  .filter((key) => !decisionAccepted(result.llmFieldDecisions?.[key]))
  .map((key) => ({
    rowIndex: result.rowIndex,
    columnKey: key,
    reason: result.llmFieldDecisions?.[key]?.reason || "模型未返回可审计值",
  })));

await fs.writeFile(
  path.join(runDir, "final-results.json"),
  `${JSON.stringify(enriched, null, 2)}\n`,
  "utf8",
);
await fs.writeFile(
  path.join(runDir, "model-enrichment-audit.json"),
  `${JSON.stringify({ warnings, unresolvedModelCells }, null, 2)}\n`,
  "utf8",
);

const previewPath = outputPath.replace(/\.xlsx$/i, ".preview.svg");
const validationPath = outputPath.replace(/\.xlsx$/i, ".validation.json");
const validation = await fillDynamicWorkbook({
  inputPath,
  task,
  results: enriched,
  outputPath,
  previewPath,
  validationPath,
});

console.log(JSON.stringify({
  ok: true,
  outputPath,
  previewPath,
  validationPath,
  creatorCount: enriched.length,
  successfulCreators: enriched.filter((result) => result.dataStatus === "成功").length,
  unresolvedModelCellCount: unresolvedModelCells.length,
  unresolvedModelCells,
  filledCount: validation.filled.length,
  blankCount: validation.leftBlank.length,
}));
