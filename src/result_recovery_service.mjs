import fs from "node:fs/promises";
import path from "node:path";
import { canonicalFieldKey } from "./field_contracts.mjs";
import { checkpointsForCreator, readCheckpoints } from "./collection_checkpoint.mjs";
import {
  compileTaskCollectionPlan,
  contractProvenanceForRequest,
  extractContractValues,
} from "./collection_plan.mjs";
import { extractFieldsFromApi, parseDetailText, ROOT } from "./pgy_collect_core.mjs";

function mergeFields(target, incoming) {
  const maxFields = new Set(["近16篇最高阅读量", "近16篇最高点赞量", "近16篇最高收藏量"]);
  for (const [name, value] of Object.entries(incoming || {})) {
    if (maxFields.has(name) && Number.isFinite(Number(target[name])) && Number.isFinite(Number(value))) {
      target[name] = Math.max(Number(target[name]), Number(value));
    } else {
      target[name] = value;
    }
  }
}

async function findCreatorDirectory(rawDir, creatorId) {
  const entries = await fs.readdir(rawDir, { withFileTypes: true }).catch(() => []);
  const entry = entries.find((item) => item.isDirectory() && item.name.includes(creatorId));
  return entry ? path.join(rawDir, entry.name) : "";
}

function requestRecordMatches(record, request) {
  if (String(record.response?.status || "")[0] !== "2") return false;
  if (String(record.request?.method || "GET").toUpperCase() !== request.method) return false;
  let url;
  try {
    url = new URL(record.request?.url || "");
  } catch {
    return false;
  }
  if (url.pathname !== request.endpoint) return false;
  let body = {};
  try {
    body = JSON.parse(record.request?.postData || "{}");
  } catch {
    body = {};
  }
  return Object.entries(request.params || {}).every(([key, value]) => (
    String(url.searchParams.get(key) ?? body[key] ?? "") === String(value)
  ));
}

async function recoverCreator({ creator, rawDir, task, checkpoints, jobId }) {
  const creatorId = creator.creatorId || new URL(creator.pgyLink).pathname.split("/").filter(Boolean).at(-1);
  const creatorDir = await findCreatorDirectory(rawDir, creatorId);
  if (!creatorDir) {
    return {
      ...creator,
      creatorId,
      dataStatus: "失败",
      errorReason: "未找到该达人的原始证据目录",
      fields: {},
      contractValues: {},
      missingFields: [],
      evidenceFiles: [],
    };
  }

  const responseDir = path.join(creatorDir, "responses");
  const responseFiles = (await fs.readdir(responseDir).catch(() => []))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const fields = {};
  const evidenceFiles = [];
  const responseRecords = [];
  for (const filename of responseFiles) {
    const filePath = path.join(responseDir, filename);
    const record = JSON.parse(await fs.readFile(filePath, "utf8"));
    mergeFields(fields, extractFieldsFromApi(
      record.request?.url || "",
      record.body || {},
      {
        postData: record.request?.postData || "",
        collectionTemplate: "dynamic",
        noteScope: "mixed",
      },
    ));
    responseRecords.push(record);
    evidenceFiles.push(path.relative(ROOT, filePath));
  }

  const pageTextPath = path.join(creatorDir, "page_text.txt");
  const rawText = await fs.readFile(pageTextPath, "utf8").catch(() => "");
  const parsed = parseDetailText(rawText);
  mergeFields(fields, parsed.fields);
  fields["蒲公英链接"] = creator.pgyLink;
  fields["小红书主页链接"] ||= creatorId
    ? `https://www.xiaohongshu.com/user/profile/${creatorId}`
    : "";

  const creatorCheckpoints = checkpointsForCreator(checkpoints, jobId, creatorId);
  const contractValues = {};
  const contractProvenance = {};
  for (const checkpoint of Object.values(creatorCheckpoints)) {
    if (checkpoint.status === "COMPLETED") {
      Object.assign(contractValues, checkpoint.contractValues || {});
      Object.assign(contractProvenance, checkpoint.contractProvenance || {});
    }
  }
  const plan = compileTaskCollectionPlan(task.taskContract, creatorId);
  for (const request of plan.requests) {
    const record = responseRecords.find((item) => requestRecordMatches(item, request));
    if (!record) continue;
    const values = extractContractValues(request, record.body || {});
    Object.assign(contractValues, values);
    Object.assign(contractProvenance, contractProvenanceForRequest(request, values, {
      ok: true,
      status: Number(record.response?.status || 200),
      transport: "raw-evidence-recovery",
    }));
  }

  const missingFields = [
    ...(task.columns || [])
      .filter((column) => column.contract?.scene === "creator" && column.mapping?.name)
      .filter((column) => {
        try {
          if (Object.hasOwn(contractValues, canonicalFieldKey(column.contract))) return false;
        } catch {
          // Legacy creator fields continue to use the display-name result map.
        }
        const value = fields[column.mapping.name];
        return value === undefined || value === null || value === "";
      })
      .map((column) => column.mapping.name)
      .filter((name, index, values) => values.indexOf(name) === index),
    ...(task.taskContract?.scopeGroups || [])
      .filter((group) => (
        group.scene !== "creator"
        || group.request?.requestId
        || group.contracts?.some((contract) => contract.request?.requestId)
      ))
      .flatMap((group) => group.contracts || [])
      .map(canonicalFieldKey)
      .filter((key) => !Object.hasOwn(contractValues, key)),
  ];

  return {
    ...creator,
    creatorId,
    dataStatus: missingFields.length ? "部分缺失" : "成功",
    errorReason: missingFields.length ? `缺少字段：${missingFields.join("、")}` : "",
    fields,
    contractValues,
    contractProvenance: Object.fromEntries(
      Object.entries(contractProvenance).map(([key, provenance]) => [
        key,
        {
          ...provenance,
          evidenceFiles: [
            ...(rawText ? [path.relative(ROOT, pageTextPath)] : []),
            ...evidenceFiles,
          ],
          platformDataUpdateDate: parsed.dataUpdateDate || "",
        },
      ]),
    ),
    missingFields,
    dataUpdateDate: parsed.dataUpdateDate,
    metricScope: {
      label: `动态字段合同第 ${task.taskContract?.version || 1} 版（从原始证据恢复）`,
      requests: Object.values(creatorCheckpoints).map((checkpoint) => ({
        id: `${creatorId}:${checkpoint.groupId}`,
        ok: checkpoint.status === "COMPLETED",
        status: checkpoint.status === "COMPLETED" ? 200 : 0,
        resumed: true,
        error: checkpoint.error || "",
      })).concat(plan.requests
        .filter((request) => responseRecords.some((record) => requestRecordMatches(record, request)))
        .map((request) => ({
          id: `${creatorId}:${request.groupId}:raw-evidence`,
          ok: true,
          status: 200,
          resumed: true,
          recoveredFromEvidence: true,
        }))),
    },
    evidenceFiles: [
      ...(rawText ? [path.relative(ROOT, pageTextPath)] : []),
      ...evidenceFiles,
    ],
    rawTextFile: rawText ? path.relative(ROOT, pageTextPath) : "",
  };
}

export async function recoverCollectedResults({ runDir, creators, task, jobId = path.basename(runDir) }) {
  const rawDir = path.join(runDir, "raw");
  const checkpoints = await readCheckpoints(path.join(runDir, "checkpoints.json"));
  const results = [];
  for (const creator of creators) {
    results.push(await recoverCreator({
      creator,
      rawDir,
      task,
      checkpoints,
      jobId,
    }));
  }
  return results;
}
