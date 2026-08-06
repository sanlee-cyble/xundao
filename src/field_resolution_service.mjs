import { validateFieldContract } from "./field_contracts.mjs";
import {
  instantiateFieldCapability,
  listFieldCapabilities,
  matchPlatformFieldLabel,
} from "./pgy_field_library_v1.mjs";
import { qwenToolCall } from "./qwen_service.mjs";

function normalize(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[（）]/g, (character) => (character === "（" ? "(" : ")"))
    .replace(/[\s/／|｜:：_\-·，,。.()[\]]/g, "")
    .toLowerCase();
}

function labelFor(column = {}) {
  return [
    column.parentLabel,
    column.pathLabel,
    column.displayLabel,
    column.topLabel,
    column.childLabel,
  ].filter(Boolean).join(" / ");
}

function semanticMetric(label) {
  const definitions = [
    ["video_full_view", /完播|完視聴|fullview|completion/i],
    ["picture_3s_view", /3\s*(?:秒|sec).*(?:阅读|閲覧|view)/i],
    ["exposure", /曝光|インプレッション|impressions?/i],
    ["read", /阅读|閲覧|reads?|views?/i],
    ["interaction", /互动|エンゲージメント|interactions?|engagement/i],
    ["like", /点赞|いいね|likes?/i],
    ["collect", /收藏|保存|セーブ|collects?|saves?/i],
    ["comment", /评论|コメント|comments?/i],
    ["share", /分享|シェア|shares?/i],
    ["fans", /粉丝|ファン|followers?/i],
    ["quote", /报价|价格|一口价|費用|price|quote/i],
    ["cpm", /\bcpm\b/i],
    ["cpv", /\bcpv\b/i],
    ["cpuv", /\bcpuv\b/i],
    ["cpe", /\bcpe\b/i],
  ];
  return definitions.find(([, pattern]) => pattern.test(label))?.[0] || "";
}

function semanticStatistic(label) {
  if (/中位|中央値|median/i.test(label)) return "median";
  if (/最高|max(?:imum)?/i.test(label)) return "max";
  if (/占比|比例|率|share|ratio|rate/i.test(label)) return "rate";
  if (/数量|数|count/i.test(label)) return "count";
  return "";
}

function dimensionHints(label, defaults = {}) {
  const hints = {
    scene: defaults.sceneDefault || "",
    contentType: defaults.contentTypeDefault || "",
    window: defaults.windowDefault || "",
    traffic: defaults.trafficDefault || "",
    view: defaults.viewDefault || "",
  };
  if (/日常|通常投稿|daily|non[-\s]?sponsored/i.test(label)) hints.scene = "daily";
  else if (/合作|タイアップ|コラボ|sponsored|cooperation/i.test(label)) hints.scene = "cooperation";
  if (/图文\s*[+＋及和]\s*视频|画像\s*[+＋&／/]\s*動画|all\s*(?:content|post)|mixed/i.test(label)) {
    hints.contentType = "all";
  } else if (/视频|動画|video/i.test(label)) hints.contentType = "video";
  else if (/图文|画像|静止画|image|photo/i.test(label)) hints.contentType = "image";
  if (/90\s*(?:天|日|days?)/i.test(label)) hints.window = "90d";
  else if (/30\s*(?:天|日|days?)/i.test(label)) hints.window = "30d";
  if (/仅?自然流|オーガニック|organic|natural/i.test(label)) hints.traffic = "natural";
  else if (/全流量|総流量|全トラフィック|all\s*traffic|total\s*traffic/i.test(label)) hints.traffic = "all";
  if (/按成本|cost/i.test(label)) hints.view = "cost";
  else if (/按规模|scale/i.test(label)) hints.view = "scale";
  return hints;
}

function characterBigrams(value) {
  const input = normalize(value);
  if (input.length < 2) return new Set(input ? [input] : []);
  return new Set(Array.from({ length: input.length - 1 }, (_, index) => input.slice(index, index + 2)));
}

function overlapScore(left, right) {
  const a = characterBigrams(left);
  const b = characterBigrams(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap / Math.max(a.size, b.size);
}

function candidateScore(column, capability, defaults = {}) {
  const label = labelFor(column);
  const normalizedLabel = normalize(label);
  const candidateLabels = [capability.platformLabel, ...(capability.aliases || [])];
  const normalizedCandidates = candidateLabels.map(normalize).filter(Boolean);
  let score = 0;
  if (normalizedCandidates.some((item) => item === normalizedLabel)) score += 240;
  if (normalizedLabel && normalizedCandidates.some((item) => (
    normalizedLabel.includes(item) || item.includes(normalizedLabel)
  ))) score += 70;
  score += Math.round(Math.max(0, ...candidateLabels.map((item) => overlapScore(label, item))) * 60);
  const metric = semanticMetric(label);
  if (metric && (
    capability.metric === metric
    || capability.fieldId.includes(metric)
    || normalize(capability.platformLabel).includes(normalize(metric))
  )) score += 90;
  const statistic = semanticStatistic(label);
  if (statistic && capability.statistic === statistic) score += 25;
  const hints = dimensionHints(label, defaults);
  for (const [dimension, value] of Object.entries(hints)) {
    if (!value) continue;
    const supported = capability.supportedDimensions?.[dimension] || [];
    score += supported.includes(value) ? 8 : -30;
  }
  if (capability.surfaceStatus === "pgy_ui_verified") score += 12;
  if (capability.executionStatus === "collectable_scalar") score += 8;
  return score;
}

export function fieldCandidateSet(column, {
  defaults = {},
  limit = 8,
  minimumScore = 70,
} = {}) {
  const combined = labelFor(column);
  if (
    !normalize(combined)
    || /実績|实际结果|實際結果|計画比|计划比|計劃比|计划达成|達成率|达成率|配信リンク|发布链接/i.test(combined)
  ) {
    return [];
  }
  const exact = [];
  for (const label of [
    column.pathLabel,
    column.displayLabel,
    column.childLabel,
    column.topLabel,
  ].filter(Boolean)) {
    for (const capability of matchPlatformFieldLabel(label)) {
      if (!exact.some((item) => item.capabilityId === capability.capabilityId)) {
        exact.push(capability);
      }
    }
  }
  const pool = exact.length
    ? exact
    : listFieldCapabilities({ outputKind: "scalar" });
  return pool
    .map((capability) => ({
      capability,
      score: candidateScore(column, capability, defaults),
    }))
    .filter((item) => item.score >= minimumScore || exact.length > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Number(limit) || 8))
    .map(({ capability, score }) => ({
      capabilityId: capability.capabilityId,
      fieldId: capability.fieldId,
      platformLabel: capability.platformLabel,
      uiPathTemplate: capability.uiPathTemplate,
      domain: capability.domain,
      metric: capability.metric,
      statistic: capability.statistic,
      supportedDimensions: capability.supportedDimensions,
      surfaceStatus: capability.surfaceStatus,
      executionStatus: capability.executionStatus,
      exact: exact.some((item) => item.capabilityId === capability.capabilityId),
      score,
    }));
}

function materializeCandidate(
  column,
  candidate,
  dimensions,
  resolvedBy,
  ambiguousDimensions = [],
) {
  const contract = instantiateFieldCapability(candidate.capabilityId, dimensions);
  for (const dimension of ambiguousDimensions) contract[dimension] = "";
  const validation = validateFieldContract(contract);
  return {
    ...column,
    mapping: {
      id: candidate.fieldId,
      name: candidate.platformLabel,
      source: "pgy",
      unit: contract?.unit || "",
      generic: true,
    },
    contract,
    missingDimensions: validation.missingDimensions,
    requiresResolution: validation.missingDimensions.length > 0,
    resolvedBy: [...new Set([...(column.resolvedBy || []), resolvedBy])],
    fieldCandidateAudit: {
      capabilityId: candidate.capabilityId,
      platformLabel: candidate.platformLabel,
      score: candidate.score,
      surfaceStatus: candidate.surfaceStatus,
    },
  };
}

function ambiguousCandidateDimensions(candidates, hints) {
  return ["scene", "contentType", "window", "traffic", "view"].filter((dimension) => {
    if (hints[dimension]) return false;
    const values = new Set(
      candidates.flatMap((candidate) => candidate.supportedDimensions?.[dimension] || []),
    );
    return values.size > 1;
  });
}

function candidateTool(candidates) {
  return {
    type: "function",
    function: {
      name: "select_pgy_field_contract",
      description: "只从字段库候选中选择与 Excel 表头含义一致的蒲公英字段；不执行采集或写入。",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["capabilityId", "reason"],
        properties: {
          capabilityId: {
            type: "string",
            enum: candidates.map((item) => item.capabilityId),
          },
          reason: { type: "string" },
        },
      },
    },
  };
}

export async function resolveColumnWithFieldLibrary(column, {
  defaults = {},
  apiKey = process.env.QWEN_API_KEY || "",
  callQwen = qwenToolCall,
} = {}) {
  if (["manual", "llm_evidence", "llm_restricted"].includes(column.outputPolicy?.mode)) {
    return column;
  }
  if (column.contract || column.mapping) return column;
  const candidates = fieldCandidateSet(column, { defaults });
  if (!candidates.length) return column;
  const hints = dimensionHints(labelFor(column), defaults);
  const ambiguousDimensions = ambiguousCandidateDimensions(candidates, hints);
  const exactCandidates = candidates.filter((item) => item.exact);
  if (exactCandidates.length === 1) {
    return materializeCandidate(
      column,
      exactCandidates[0],
      hints,
      "pgy_field_library_exact",
      ambiguousDimensions,
    );
  }
  if (!apiKey) {
    return {
      ...column,
      fieldCandidates: candidates,
    };
  }
  const result = await callQwen({
    apiKey,
    messages: [
      {
        role: "system",
        content: [
          "你只负责把一个 Excel 表头映射到给定的蒲公英字段库候选。",
          "只能调用白名单工具并选择候选 capabilityId；不能创造字段、口径、数值或接口。",
          "若候选都不等价，不要调用工具。",
        ].join(""),
      },
      {
        role: "user",
        content: JSON.stringify({
          header: labelFor(column),
          knownDimensions: hints,
          candidates,
        }),
      },
    ],
    tools: [candidateTool(candidates)],
  });
  const call = result.toolCalls.find((item) => item.name === "select_pgy_field_contract");
  if (!call) {
    return {
      ...column,
      fieldCandidates: candidates,
    };
  }
  const selected = candidates.find((item) => item.capabilityId === call.arguments.capabilityId);
  if (!selected) throw new Error("Qwen 选择了字段库候选之外的字段");
  const materialized = materializeCandidate(
    column,
    selected,
    hints,
    "qwen_candidate_validated",
    ambiguousDimensions,
  );
  return {
    ...materialized,
    fieldCandidateAudit: {
      ...materialized.fieldCandidateAudit,
      modelReason: String(call.arguments.reason || ""),
    },
  };
}

export async function resolveColumnsWithFieldLibrary(columns = [], options = {}) {
  const resolved = new Array(columns.length);
  const warnings = [];
  let cursor = 0;
  async function worker() {
    while (cursor < columns.length) {
      const index = cursor;
      cursor += 1;
      const column = columns[index];
      try {
        resolved[index] = await resolveColumnWithFieldLibrary(column, options);
      } catch (error) {
        warnings.push({
          columnKey: column.key || column.letter || "",
          label: column.pathLabel || column.displayLabel || "",
          error: error.message,
        });
        resolved[index] = column;
      }
    }
  }
  const concurrency = Math.max(1, Math.min(Number(options.concurrency || 3), 6));
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(columns.length, 1)) }, () => worker()),
  );
  return { columns: resolved, warnings };
}
