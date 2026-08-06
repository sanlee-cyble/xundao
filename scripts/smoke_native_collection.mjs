#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {
  collectCreatorPlan,
  createBackgroundCollectContext,
  verifyPgyLoginState,
} from "../src/pgy_collect_core.mjs";
import { loadEncryptedStorageState } from "../src/pgy_connection_service.mjs";

function optionsFrom(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    options[token.slice(2)] = argv[index + 1];
    index += 1;
  }
  return options;
}

const options = optionsFrom(process.argv.slice(2));
const sourceRun = path.resolve(options["source-run"] || "");
const outputDir = path.resolve(options.output || "");
if (!options["source-run"] || !options.output) {
  throw new Error("usage: smoke_native_collection --source-run <run-dir> --output <dir> [--scope-ids scope-2,scope-5]");
}
const task = JSON.parse(await fs.readFile(path.join(sourceRun, "task.json"), "utf8"));
const creators = JSON.parse(await fs.readFile(path.join(sourceRun, "creators.json"), "utf8"));
const creator = creators[Number(options["creator-index"] || 0)];
if (!creator?.pgyLink) throw new Error("测试达人缺少蒲公英链接");
const requestedScopeIds = new Set(
  String(options["scope-ids"] || "scope-2,scope-4,scope-5").split(",").filter(Boolean),
);
const originalContract = task.taskContract || task;
const scopeGroups = (originalContract.scopeGroups || []).filter((group) => (
  group.scene === "creator" || requestedScopeIds.has(group.id)
));
const taskContract = {
  ...originalContract,
  confirmedVersion: originalContract.version,
  unresolvedCount: 0,
  scopeGroups,
};
const encryptedStatePath = path.resolve(
  options["encrypted-state"] || "data/pgy-profiles/user-local-admin/connection-state.enc",
);
const keyPath = path.resolve(options["key-file"] || "data/.pgy-connection.key");
const secret = String(await fs.readFile(keyPath, "utf8")).trim();
const storageState = await loadEncryptedStorageState(encryptedStatePath, secret);
await fs.mkdir(outputDir, { recursive: true });
const context = await createBackgroundCollectContext(storageState);

try {
  const login = await verifyPgyLoginState(context);
  if (!login.authenticated) throw new Error(login.reason);
  const result = await collectCreatorPlan(context, creator, outputDir, taskContract, {
    collectionTemplate: "dynamic",
    jobId: `native-smoke-${Date.now()}`,
    noteScope: "mixed",
  });
  const requests = result.metricScope?.requests || [];
  const failed = requests.filter((request) => !request.ok);
  if (failed.length) {
    throw new Error(`原生口径烟雾测试失败：${failed.map((item) => `${item.id}:${item.error}`).join("；")}`);
  }
  const report = {
    ok: true,
    creator: result.nickname || result.creatorId,
    dataStatus: result.dataStatus,
    contractValueCount: Object.keys(result.contractValues || {}).length,
    requestCount: requests.length,
    requests,
    outputDir,
  };
  await fs.writeFile(
    path.join(outputDir, "smoke-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await context.close().catch(() => {});
}
