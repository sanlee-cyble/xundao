#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { creatorIdFromUrl } from "./pgy_collect_core.mjs";
import {
  DERIVED_FIELD_REGISTRY,
  LLM_FIELD_POLICY,
  compileCollectionPlan,
  matchFieldLabel,
} from "./field_registry.mjs";
import { outputPolicyForLabel } from "./output_policy.mjs";
import { resolveWorkbookColumns } from "./semantic_resolver.mjs";
import { createTaskContract } from "./task_contract.mjs";
import { canonicalFieldKey } from "./field_contracts.mjs";

const WORKBOOK_BRIDGE = fileURLToPath(new URL("./workbook_bridge.py", import.meta.url));

function runWorkbookBridge(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [WORKBOOK_BRIDGE, ...args], {
      cwd: path.dirname(WORKBOOK_BRIDGE),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || stdout.trim() || `workbook bridge exited with ${code}`));
    });
  });
}

function argsFrom(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) continue;
    options[token.slice(2)] = rest[index + 1];
    index += 1;
  }
  return { command, options };
}

function required(options, name) {
  const value = options[name];
  if (!value) throw new Error(`缺少参数 --${name}`);
  return path.resolve(value);
}

function text(value) {
  return String(value ?? "").trim();
}

function isBlank(value) {
  return value === null || value === undefined || text(value) === "";
}

function columnName(index) {
  let current = index + 1;
  let result = "";
  while (current > 0) {
    current -= 1;
    result = String.fromCharCode(65 + (current % 26)) + result;
    current = Math.floor(current / 26);
  }
  return result;
}

function headerDepth(values) {
  const firstDataIndex = values.findIndex((row, index) => (
    index > 0 && (row || []).some((cell) => text(cell).includes("pgy.xiaohongshu.com"))
  ));
  if (firstDataIndex < 1) throw new Error("Excel 中未找到蒲公英达人链接");
  return firstDataIndex;
}

function headerBandStart(values, depth) {
  const rows = values.slice(0, depth);
  const scored = rows.map((row, index) => {
    const cells = (row || []).map(text).filter(Boolean);
    const textCells = cells.filter((value) => (
      !/^[-+△▲▽▼]?$/.test(value)
      && !/^[\d.,%]+$/.test(value)
      && !value.includes("pgy.xiaohongshu.com")
    ));
    const bilingualCells = textCells.filter((value) => (
      /\r?\n/.test(value)
      || /[\u3040-\u30ff].*[\u4e00-\u9fff]|[\u4e00-\u9fff].*[\u3040-\u30ff]/.test(value)
      || /[A-Za-z].*[\u4e00-\u9fff]|[\u4e00-\u9fff].*[A-Za-z]/.test(value)
    ));
    return {
      index,
      score: textCells.length * 10 + bilingualCells.length * 3 + index,
    };
  });
  return scored.sort((left, right) => right.score - left.score)[0]?.index || 0;
}

function columnDescriptors(values, depth, start = 0) {
  const columnCount = Math.max(...values.slice(0, depth).map((row) => row?.length || 0));
  const top = values[start] || [];
  const bottom = values[depth - 1] || [];
  let activeParent = "";
  return Array.from({ length: columnCount }, (_, index) => {
    const topLabel = text(top[index]);
    const childLabel = depth - start > 1 ? text(bottom[index]) : "";
    if (topLabel) activeParent = topLabel;
    const parentLabel = childLabel ? (topLabel || activeParent) : "";
    const displayLabel = childLabel || topLabel;
    const pathLabel = childLabel && parentLabel && childLabel !== parentLabel
      ? `${parentLabel} / ${childLabel}`
      : displayLabel;
    const matched = matchFieldLabel(displayLabel, parentLabel);
    const letter = columnName(index);
    return {
      index,
      letter,
      key: `${letter}:${pathLabel}`,
      topLabel,
      childLabel,
      parentLabel,
      displayLabel,
      pathLabel,
      mapping: matched ? {
        id: matched.id,
        name: matched.name,
        source: matched.source,
        unit: matched.unit || "",
      } : null,
    };
  });
}

function chooseLinkColumn(columns, values, depth) {
  const mapped = columns.find((column) => column.mapping?.id === "pgy.creator.pgy_profile");
  if (mapped) return mapped;
  for (const column of columns) {
    if (values.slice(depth).some((row) => text(row?.[column.index]).includes("pgy.xiaohongshu.com"))) return column;
  }
  return null;
}

function calculationContext(values, depth) {
  for (let rowIndex = 0; rowIndex < depth; rowIndex += 1) {
    const row = values[rowIndex] || [];
    for (let columnIndex = 0; columnIndex < row.length; columnIndex += 1) {
      if (!/(?:レート|汇率|exchange\s*rate)/i.test(text(row[columnIndex]))) continue;
      const rate = Number(row[columnIndex + 1]);
      if (!Number.isFinite(rate) || rate <= 0) continue;
      return {
        exchangeRate: rate,
        exchangeRateCell: `${columnName(columnIndex + 1)}${rowIndex + 1}`,
      };
    }
  }
  return {};
}

export function analyzeWorkbookValues(values, sheetName = "Sheet1", defaults = {}) {
  const depth = headerDepth(values);
  const headerStart = headerBandStart(values, depth);
  const describedColumns = columnDescriptors(values, depth, headerStart);
  const resolution = resolveWorkbookColumns(describedColumns, defaults);
  const columns = resolution.columns;
  const linkColumn = chooseLinkColumn(columns, values, depth);
  if (!linkColumn) throw new Error("Excel 中未识别到“蒲公英链接”列");
  const nameColumn = columns.find((column) => column.mapping?.id === "pgy.creator.name");
  const creators = [];
  for (let index = depth; index < values.length; index += 1) {
    const row = values[index] || [];
    const pgyLink = text(row[linkColumn.index]);
    if (!pgyLink.includes("pgy.xiaohongshu.com")) continue;
    creators.push({
      rowIndex: index + 1,
      nickname: nameColumn ? text(row[nameColumn.index]) : "",
      pgyLink,
      creatorId: creatorIdFromUrl(pgyLink),
      currentValues: Object.fromEntries(columns
        .filter((column) => !isBlank(row[column.index]))
        .map((column) => [column.key, row[column.index]])),
    });
  }
  const mappedColumns = columns.filter((column) => column.mapping);
  const pgyFieldIds = [...new Set(mappedColumns
    .filter((column) => column.mapping.source === "pgy")
    .map((column) => column.mapping.id))];
  const derivedColumns = mappedColumns.filter((column) => column.mapping.source === "formula");
  const unmatchedColumns = columns
    .filter((column) => column.displayLabel && !column.mapping)
    .map((column) => {
      const outputPolicy = outputPolicyForLabel(column.pathLabel || column.displayLabel);
      return {
        ...column,
        outputPolicy,
        llmPolicy: outputPolicy.mode === "manual"
          || LLM_FIELD_POLICY.protected.includes(column.displayLabel)
          ? "protected"
          : "evidence_only",
      };
    });
  const taskContract = createTaskContract({
    columns,
    creators,
    source: {
      type: "excel",
      sheetName,
      headerDepth: depth,
      headerStartRow: headerStart + 1,
    },
  });
  return {
    version: 2,
    sheetName,
    headerDepth: depth,
    headerStartRow: headerStart + 1,
    columns,
    pgyFieldIds,
    derivedFieldIds: derivedColumns.map((column) => column.mapping.id),
    unmatchedColumns,
    collectionPlan: compileCollectionPlan(pgyFieldIds),
    calculationContext: calculationContext(values, depth),
    creators,
    taskContract,
    scopeGroups: taskContract.scopeGroups,
    unresolved: taskContract.unresolved,
    unresolvedCount: taskContract.unresolvedCount,
    executable: taskContract.unresolvedCount === 0,
  };
}

export async function extractDynamicTask(inputPath) {
  const snapshot = JSON.parse(await runWorkbookBridge([
    "inspect",
    "--input",
    path.resolve(inputPath),
  ]));
  return analyzeWorkbookValues(snapshot.values || [], snapshot.sheetName || "Sheet1");
}

export async function attachLinksToWorkbook(inputPath, links, outputPath = inputPath) {
  const stdout = await runWorkbookBridge([
    "attach-links",
    "--input",
    path.resolve(inputPath),
    "--output",
    path.resolve(outputPath),
    "--links",
    JSON.stringify(links),
  ]);
  return JSON.parse(stdout);
}

export function valueForPgyColumn(column, result) {
  if (column.mapping.id === "pgy.creator.pgy_profile") return result.pgyLink;
  if (column.contract && result.contractValues) {
    try {
      const key = canonicalFieldKey(column.contract);
      if (Object.hasOwn(result.contractValues, key)) return result.contractValues[key];
    } catch {
      // Legacy tasks may not have complete contracts; fall back to the display-name map.
    }
  }
  return result.fields?.[column.mapping.name];
}

function contractKeyOrBlank(contract) {
  if (!contract) return "";
  try {
    return canonicalFieldKey(contract);
  } catch {
    return "";
  }
}

function discoveryLabel(value) {
  return String(value || "")
    .replace(/\r?\n/g, "")
    .replace(/[（）]/g, (character) => character === "（" ? "(" : ")")
    .replace(/[／/｜|:：_\-·，,。.]/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function discoveryCandidates(column) {
  return [...new Set([
    column.displayLabel,
    column.childLabel,
    column.topLabel,
    column.pathLabel,
    ...String(column.displayLabel || "").split(/\r?\n|\s*\/\s*|[｜|]/g),
  ].map(discoveryLabel).filter(Boolean))];
}

export function discoverRuntimePgyColumns(task, results = []) {
  if (!task?.columns?.length || !results.length) return task;
  const observedNames = [...new Set(results.flatMap((result) => Object.keys(result.fields || {})))];
  const observedByLabel = new Map();
  for (const name of observedNames) {
    const key = discoveryLabel(name);
    if (!key) continue;
    const values = observedByLabel.get(key) || [];
    values.push(name);
    observedByLabel.set(key, values);
  }
  const discovered = [];
  const columns = task.columns.map((column) => {
    if (column.mapping || !column.displayLabel) return column;
    const matches = [...new Set(discoveryCandidates(column)
      .flatMap((candidate) => observedByLabel.get(candidate) || []))];
    if (matches.length !== 1) return column;
    const sourceField = matches[0];
    const mapping = {
      id: `pgy.runtime.${Buffer.from(sourceField).toString("hex").slice(0, 24)}`,
      name: sourceField,
      label: column.displayLabel,
      source: "pgy",
      unit: "",
      discoveredAtRuntime: true,
    };
    discovered.push({ columnKey: column.key, sourceField });
    return {
      ...column,
      mapping,
      runtimeSourceField: sourceField,
      resolvedBy: [...new Set([...(column.resolvedBy || []), "runtime_pgy_evidence"])],
    };
  });
  if (!discovered.length) return task;
  const discoveredKeys = new Set(discovered.map((item) => item.columnKey));
  return {
    ...task,
    columns,
    unmatchedColumns: (task.unmatchedColumns || [])
      .filter((column) => !discoveredKeys.has(column.key)),
    runtimeDiscoveredColumns: [
      ...(task.runtimeDiscoveredColumns || []),
      ...discovered,
    ],
  };
}

export async function fillDynamicWorkbook({
  inputPath,
  task = null,
  results,
  outputPath,
  previewPath,
  validationPath,
}) {
  const effectiveTask = task || await extractDynamicTask(inputPath);
  const bridgeTask = {
    ...effectiveTask,
    columns: effectiveTask.columns.map((column) => ({
      ...column,
      contractKey: contractKeyOrBlank(column.contract),
    })),
  };
  const resolvedOutput = path.resolve(outputPath);
  const resolvedPreview = path.resolve(previewPath || resolvedOutput.replace(/\.xlsx$/i, ".preview.svg"));
  const resolvedValidation = path.resolve(validationPath || resolvedOutput.replace(/\.xlsx$/i, ".validation.json"));
  await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });
  await fs.mkdir(path.dirname(resolvedPreview), { recursive: true });
  await fs.mkdir(path.dirname(resolvedValidation), { recursive: true });
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const taskSnapshotPath = path.join(path.dirname(resolvedValidation), `.dynamic-task-${nonce}.json`);
  const resultSnapshotPath = path.join(path.dirname(resolvedValidation), `.dynamic-results-${nonce}.json`);
  await fs.writeFile(taskSnapshotPath, `${JSON.stringify(bridgeTask, null, 2)}\n`, "utf8");
  await fs.writeFile(resultSnapshotPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  try {
    await runWorkbookBridge([
      "dynamic-fill",
      "--input",
      path.resolve(inputPath),
      "--task",
      taskSnapshotPath,
      "--results",
      resultSnapshotPath,
      "--output",
      resolvedOutput,
      "--preview",
      resolvedPreview,
      "--validation",
      resolvedValidation,
    ]);
    return JSON.parse(await fs.readFile(resolvedValidation, "utf8"));
  } finally {
    await fs.rm(taskSnapshotPath, { force: true });
    await fs.rm(resultSnapshotPath, { force: true });
  }
}

export async function exportDynamicWorkbook({
  task,
  results,
  outputPath,
  previewPath,
  validationPath,
}) {
  const bridgeTask = {
    ...task,
    columns: (task?.columns || []).map((column) => ({
      ...column,
      contractKey: contractKeyOrBlank(column.contract),
    })),
  };
  const resolvedOutput = path.resolve(outputPath);
  const resolvedPreview = path.resolve(previewPath || resolvedOutput.replace(/\.xlsx$/i, ".preview.svg"));
  const resolvedValidation = path.resolve(validationPath || resolvedOutput.replace(/\.xlsx$/i, ".validation.json"));
  await Promise.all([
    fs.mkdir(path.dirname(resolvedOutput), { recursive: true }),
    fs.mkdir(path.dirname(resolvedPreview), { recursive: true }),
    fs.mkdir(path.dirname(resolvedValidation), { recursive: true }),
  ]);
  const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const taskSnapshotPath = path.join(path.dirname(resolvedValidation), `.dynamic-export-task-${nonce}.json`);
  const resultSnapshotPath = path.join(path.dirname(resolvedValidation), `.dynamic-export-results-${nonce}.json`);
  await fs.writeFile(taskSnapshotPath, `${JSON.stringify(bridgeTask, null, 2)}\n`, "utf8");
  await fs.writeFile(resultSnapshotPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
  try {
    await runWorkbookBridge([
      "dynamic-export",
      "--task",
      taskSnapshotPath,
      "--results",
      resultSnapshotPath,
      "--output",
      resolvedOutput,
      "--preview",
      resolvedPreview,
      "--validation",
      resolvedValidation,
    ]);
    return JSON.parse(await fs.readFile(resolvedValidation, "utf8"));
  } finally {
    await fs.rm(taskSnapshotPath, { force: true });
    await fs.rm(resultSnapshotPath, { force: true });
  }
}

async function commandExtract(options) {
  const inputPath = required(options, "input");
  const taskPath = required(options, "task");
  const creatorsPath = required(options, "creators");
  const task = await extractDynamicTask(inputPath);
  await fs.mkdir(path.dirname(taskPath), { recursive: true });
  await fs.mkdir(path.dirname(creatorsPath), { recursive: true });
  await fs.writeFile(taskPath, `${JSON.stringify(task, null, 2)}\n`, "utf8");
  await fs.writeFile(creatorsPath, `${JSON.stringify(task.creators, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    ok: true,
    sheetName: task.sheetName,
    creatorCount: task.creators.length,
    pgyFieldCount: task.pgyFieldIds.length,
    unmatchedFieldCount: task.unmatchedColumns.length,
  }));
}

async function commandFill(options) {
  const inputPath = required(options, "input");
  const resultsPath = required(options, "results");
  const outputPath = required(options, "output");
  const previewPath = options.preview
    ? path.resolve(options.preview)
    : outputPath.replace(/\.xlsx$/i, ".preview.svg");
  const validationPath = options.validation
    ? path.resolve(options.validation)
    : outputPath.replace(/\.xlsx$/i, ".validation.json");
  const results = JSON.parse(await fs.readFile(resultsPath, "utf8"));
  const task = options.task
    ? JSON.parse(await fs.readFile(path.resolve(options.task), "utf8"))
    : null;
  const validation = await fillDynamicWorkbook({
    inputPath,
    task,
    results,
    outputPath,
    previewPath,
    validationPath,
  });
  console.log(JSON.stringify({
    ok: true,
    outputPath,
    previewPath,
    validationPath,
    creatorCount: validation.creatorCount,
    filledCount: validation.filled.length,
    blankCount: validation.leftBlank.length,
  }));
}

const { command, options } = argsFrom(process.argv.slice(2));
if (command === "extract") await commandExtract(options);
else if (command === "fill") await commandFill(options);
else if (process.argv[1] === new URL(import.meta.url).pathname) {
  throw new Error("usage: node src/dynamic_workbook.mjs <extract|fill> --input <xlsx> [--task <json> --creators <json>] [--results <json> --output <xlsx>]");
}

export { DERIVED_FIELD_REGISTRY };
