#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {
  ROOT,
  collectCreators,
  createBackgroundCollectContext,
  createPgyContext,
} from "./pgy_collect_core.mjs";
import { nowStamp, writeJson } from "./common.mjs";
import {
  discoverRuntimePgyColumns,
  extractDynamicTask,
  fillDynamicWorkbook,
} from "./dynamic_workbook.mjs";
import { enrichUnmatchedExcelFields } from "./evidence_enrichment_service.mjs";
import { compileCollectionPlan } from "./field_registry.mjs";
import { resolveWorkbookColumns } from "./semantic_resolver.mjs";
import { createTaskContract } from "./task_contract.mjs";
import { loadEncryptedStorageState } from "./pgy_connection_service.mjs";

function argsFrom(argv) {
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

const options = argsFrom(process.argv.slice(2));
const inputPath = required(options, "input");
const outputPath = required(options, "output");
const runDir = path.resolve(options["run-dir"] || path.join(ROOT, "runs", `dynamic-${nowStamp()}`));
const storageStatePath = options["storage-state"] ? path.resolve(options["storage-state"]) : "";
const encryptedStorageStatePath = options["encrypted-storage-state"]
  ? path.resolve(options["encrypted-storage-state"])
  : "";
const connectionKeyPath = options["connection-key"]
  ? path.resolve(options["connection-key"])
  : "";
const previewPath = path.resolve(options.preview || outputPath.replace(/\.xlsx$/i, ".preview.svg"));
const validationPath = path.resolve(options.validation || outputPath.replace(/\.xlsx$/i, ".validation.json"));
const noteScope = options["note-scope"] === "mixed" ? "mixed" : "video";
const taskPath = path.join(runDir, "task.json");
const creatorsPath = path.join(runDir, "creators.json");
const resultsPath = path.join(runDir, "results.json");

await fs.mkdir(runDir, { recursive: true });
let task = await extractDynamicTask(inputPath);
const defaults = Object.fromEntries([
  ["sceneDefault", options["scene-default"]],
  ["contentTypeDefault", options["content-type-default"]],
  ["windowDefault", options["window-default"]],
  ["trafficDefault", options["traffic-default"]],
  ["viewDefault", options["view-default"]],
].filter(([, value]) => value));
if (Object.keys(defaults).length) {
  const resolution = resolveWorkbookColumns(task.columns, defaults);
  const taskContract = createTaskContract({
    columns: resolution.columns,
    creators: task.creators,
    source: task.taskContract?.source || {
      type: "excel",
      sheetName: task.sheetName,
      headerDepth: task.headerDepth,
      headerStartRow: task.headerStartRow,
    },
    version: Number(task.taskContract?.version || 1),
  });
  if (taskContract.unresolvedCount) {
    throw new Error(`仍有 ${taskContract.unresolvedCount} 个字段口径未解决`);
  }
  taskContract.confirmedVersion = taskContract.version;
  task = {
    ...task,
    columns: resolution.columns,
    taskContract,
    scopeGroups: taskContract.scopeGroups,
    unresolved: [],
    unresolvedCount: 0,
    executable: true,
  };
}
if (task.taskContract?.unresolvedCount) {
  throw new Error(`有 ${task.taskContract.unresolvedCount} 个字段口径需要确认后才能采集`);
}
task.collectionPlan = compileCollectionPlan(task.pgyFieldIds, { noteScope });
await writeJson(taskPath, task);
await writeJson(creatorsPath, task.creators);
console.log(`已识别 ${task.creators.length} 位达人、${task.pgyFieldIds.length} 个蒲公英字段、${task.unmatchedColumns.length} 个待证据判断字段；合作笔记口径：${noteScope === "mixed" ? "图文+视频" : "视频"}`);

let storageState = storageStatePath;
if (encryptedStorageStatePath) {
  if (!connectionKeyPath) throw new Error("读取加密蒲公英登录态需要 --connection-key");
  storageState = await loadEncryptedStorageState(
    encryptedStorageStatePath,
    String(await fs.readFile(connectionKeyPath, "utf8")).trim(),
  );
}
const context = storageState
  ? await createBackgroundCollectContext(storageState)
  : await createPgyContext();

try {
  const results = await collectCreators({
    context,
    creators: task.creators,
    runDir,
    config: {
      collectionTemplate: "dynamic",
      fieldIds: task.pgyFieldIds,
      requiredFieldNames: task.collectionPlan.requiredFieldNames,
      noteScope,
      taskContract: task.taskContract,
      jobId: path.basename(runDir),
    },
    onProgress: (event) => {
      if (event.status === "running") {
        console.log(`采集中 ${event.index + 1}/${event.total}：${event.creator.nickname || event.creator.creatorId}`);
      } else {
        console.log(`已完成 ${event.index}/${event.total}：${event.creator.nickname || event.creator.creatorId}（${event.result.dataStatus}）`);
      }
    },
  });
  await writeJson(path.join(runDir, "collected-results.json"), results);
  task = discoverRuntimePgyColumns(task, results);
  await writeJson(taskPath, task);
  const enriched = await enrichUnmatchedExcelFields(results, task, {
    failOpen: true,
    batchSize: 1,
    concurrency: 2,
    maxAttempts: 2,
    timeoutMs: 90000,
  });
  await writeJson(resultsPath, enriched);
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
    runDir,
    outputPath,
    previewPath,
    validationPath,
    creatorCount: task.creators.length,
    filledCount: validation.filled.length,
    blankCount: validation.leftBlank.length,
  }));
} finally {
  await context.close().catch(() => {});
}
