#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { writeJson } from "./common.mjs";
import {
  discoverRuntimePgyColumns,
  extractDynamicTask,
  fillDynamicWorkbook,
} from "./dynamic_workbook.mjs";
import { enrichUnmatchedExcelFields } from "./evidence_enrichment_service.mjs";
import { recoverCollectedResults } from "./result_recovery_service.mjs";

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
const rawRunDir = required(options, "raw-run-dir");
const previewPath = path.resolve(options.preview || outputPath.replace(/\.xlsx$/i, ".preview.svg"));
const validationPath = path.resolve(options.validation || outputPath.replace(/\.xlsx$/i, ".validation.json"));
const resultsPath = path.resolve(options.results || path.join(rawRunDir, "results.json"));
let task = options.task
  ? JSON.parse(await fs.readFile(path.resolve(options.task), "utf8"))
  : await extractDynamicTask(inputPath);
const recovered = await recoverCollectedResults({
  runDir: rawRunDir,
  creators: task.creators,
  task,
});
await writeJson(path.join(rawRunDir, "collected-results.json"), recovered);
console.log(`已从原始接口证据恢复 ${recovered.length} 位达人，无需重新访问蒲公英`);
task = discoverRuntimePgyColumns(task, recovered);
const enriched = options["skip-model"] === "true"
  ? recovered
  : await enrichUnmatchedExcelFields(recovered, task, {
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
  outputPath,
  previewPath,
  validationPath,
  resultsPath,
  creatorCount: enriched.length,
  filledCount: validation.filled.length,
  blankCount: validation.leftBlank.length,
}));
