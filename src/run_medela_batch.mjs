#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {
  collectCreators,
  createBackgroundCollectContext,
  createPgyContext,
} from "./pgy_collect_core.mjs";
import { writeJson } from "./common.mjs";

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : "";
}

const creatorsPath = path.resolve(option("creators") || "");
const resultsPath = path.resolve(option("results") || "");
const runDir = path.resolve(option("run-dir") || path.dirname(resultsPath));
if (!option("creators") || !option("results")) {
  throw new Error("usage: node src/run_medela_batch.mjs --creators <json> --results <json> [--run-dir <dir>] [--storage-state <json>]");
}

const creators = JSON.parse(await fs.readFile(creatorsPath, "utf8"));
const limit = Number(option("limit"));
const offset = Math.max(0, Number(option("offset")) || 0);
const selectedCreators = Number.isInteger(limit) && limit > 0
  ? creators.slice(offset, offset + limit)
  : creators.slice(offset);
if (!selectedCreators.length) throw new Error("指定的 --offset/--limit 未匹配到达人");
await fs.mkdir(runDir, { recursive: true });
const storageStatePath = option("storage-state") ? path.resolve(option("storage-state")) : "";
const context = storageStatePath
  ? await createBackgroundCollectContext(storageStatePath)
  : await createPgyContext();
try {
  const results = await collectCreators({
    context,
    creators: selectedCreators,
    runDir,
    config: { collectionTemplate: "medela" },
    onProgress(event) {
      if (event.status === "running") {
        console.log(`[${event.index + 1}/${event.total}] 开始 ${event.creator.nickname}`);
      } else {
        const detail = event.result.errorReason ? `（${event.result.errorReason}）` : "";
        console.log(`[${event.index}/${event.total}] 完成 ${event.creator.nickname}: ${event.result.dataStatus}${detail}`);
      }
    },
  });
  await writeJson(resultsPath, results);
  const summary = results.map((item) => ({
    rowIndex: item.rowIndex,
    nickname: item.nickname,
    dataStatus: item.dataStatus,
    missingFields: item.missingFields || [],
    dataUpdateDate: item.dataUpdateDate || "",
  }));
  console.log(JSON.stringify({ ok: true, resultsPath, count: results.length, summary }, null, 2));
} finally {
  await context.close().catch(() => {});
}
