import { groupFieldContracts, validateFieldContract } from "./field_contracts.mjs";
import { contractByFieldId, matchFieldLabel } from "./field_registry.mjs";
import {
  enrichFieldContract,
  instantiateFieldCapability,
  matchPlatformFieldLabel,
} from "./pgy_field_library_v1.mjs";
import { outputPolicyForLabel } from "./output_policy.mjs";

const NOTE_METRICS = Object.freeze([
  ["video_full_view", /(?:视频|動画|video).*(?:完播|完整观看|完視聴|完全視聴|full[\s_-]*view|completion)/i],
  ["picture_3s_view", /(?:图文|图片|画像|静止画|image|photo).*3\s*(?:秒|sec).*(?:阅读|观看|閲覧|view)/i],
  ["sample", /笔记数|投稿数|ノート数|note\s*count|post\s*count/i],
  ["exposure", /曝光|インプレッション|impressions?/i],
  ["read", /阅读|閲覧|reads?|views?/i],
  ["interaction", /互动|エンゲージメント|interactions?|engagements?/i],
  ["like", /点赞|赞量|いいね|likes?/i],
  ["collect", /收藏|保存|セーブ|collects?|saves?/i],
  ["comment", /评论|コメント|comments?/i],
  ["share", /分享|シェア|shares?/i],
  ["cpm", /\bcpm\b/i],
  ["cpv", /\bcpv\b/i],
  ["cpuv", /\bcpuv\b/i],
  ["cpe", /\bcpe\b/i],
]);

function combinedLabel(column) {
  return [
    column.parentLabel,
    column.pathLabel,
    column.displayLabel,
    column.topLabel,
    column.childLabel,
  ].filter(Boolean).join(" / ");
}

function dimensionFromColumn(column, resolver) {
  const labels = [
    column.parentLabel,
    column.childLabel,
    column.displayLabel,
    column.topLabel,
    column.pathLabel,
  ].filter(Boolean);
  for (const label of [...new Set(labels)]) {
    const value = resolver(label);
    if (value) return value;
  }
  return "";
}

function explicitScene(label) {
  if (/日常|非合作|通常投稿|通常ノート|非タイアップ|daily|organic\s*(?:post|note)|non[-\s]?sponsored/i.test(label)) {
    return "daily";
  }
  if (/合作|タイアップ|コラボ|案件投稿|cooperation|commercial|sponsored/i.test(label)) {
    return "cooperation";
  }
  return "";
}

function explicitContentType(label) {
  if (
    /图文\s*[+＋及和]\s*视频|全部笔记|不限笔记类型|图文视频|画像\s*[+＋&／/]\s*動画|全投稿形式|all\s*(?:content|post|note)\s*types?|mixed/i
      .test(label)
  ) return "all";
  if (/视频|動画|video/i.test(label)) return "video";
  if (/图文|图片|画像|静止画|image|photo/i.test(label)) return "image";
  return "";
}

function explicitWindow(label) {
  if (/近?\s*16\s*篇/.test(label)) return "recent16";
  if (/90\s*(天|日|days?)|近三个月|過去\s*90\s*日|last\s*90\s*days?/i.test(label)) return "90d";
  if (/30\s*(天|日|days?)|近一个月|過去\s*30\s*日|last\s*30\s*days?/i.test(label)) return "30d";
  return "";
}

function explicitTraffic(label) {
  if (/仅?自然流|自然流量|オーガニック流量|自然流入|organic\s*traffic|natural\s*traffic/i.test(label)) {
    return "natural";
  }
  if (/全流量|含投流|全部流量|全トラフィック|総流量|all\s*traffic|total\s*traffic/i.test(label)) {
    return "all";
  }
  return "";
}

function inferredMetric(label) {
  for (const [metric, pattern] of NOTE_METRICS) {
    if (pattern.test(label)) return metric;
  }
  return "";
}

function statisticFor(label, metric) {
  if (/中位|中央値|median/i.test(label)) return "median";
  if (/最高|max(?:imum)?/i.test(label)) return "max";
  if (/比例|占比|比率|率|rate|ratio|share/i.test(label)) return "rate";
  if (metric === "sample") return "count";
  if (metric) return "value";
  return "";
}

function genericFieldId(metric, statistic) {
  if (metric === "sample") return "pgy.note.sample.count";
  return metric ? `pgy.note.${metric}.${statistic || "value"}` : "";
}

function baseMapping(column) {
  if (column.mapping?.id) return column.mapping;
  const match = matchFieldLabel(column.displayLabel, column.parentLabel);
  return match ? {
    id: match.id,
    name: match.name,
    source: match.source,
    unit: match.unit || "",
  } : null;
}

function resolveNoteColumn(column, base, defaults) {
  const label = combinedLabel(column);
  const metric = base?.metric || inferredMetric(label) || "";
  const statistic = base?.statistic || statisticFor(label, metric) || "value";
  const scene = dimensionFromColumn(column, explicitScene) || defaults.sceneDefault || base?.scene || "";
  const contentType = dimensionFromColumn(column, explicitContentType)
    || defaults.contentTypeDefault
    || (base?.window === "recent16" ? base?.contentType : "")
    || "";
  const window = dimensionFromColumn(column, explicitWindow)
    || (/自然流/.test(label) ? defaults.naturalWindowDefault : "")
    || defaults.windowDefault
    || base?.window
    || "";
  const traffic = dimensionFromColumn(column, explicitTraffic)
    || defaults.trafficDefault
    || (/自然流/.test(label) ? "natural" : "")
    || (base?.traffic === "original" ? "original" : "")
    || (scene && base?.traffic === "all" ? "all" : "")
    || ((base?.traffic === "natural" && /自然/.test(label)) ? "natural" : "");
  const contract = enrichFieldContract({
    ...base,
    fieldId: genericFieldId(metric, statistic) || base?.fieldId || "",
    metric,
    statistic,
    scene,
    contentType,
    window,
    traffic,
    view: defaults.viewDefault || base?.view || "scale",
    source: "pgy",
    unit: base?.unit || "count",
    legacyFieldId: base?.legacyFieldId,
  });
  const validation = validateFieldContract(contract);
  const mapping = baseMapping(column) || {
    id: contract.fieldId,
    name: column.pathLabel || column.displayLabel,
    source: "pgy",
    unit: contract.unit === "ratio" ? "%" : "次",
    generic: true,
  };
  return {
    ...column,
    mapping,
    contract,
    missingDimensions: validation.missingDimensions,
    requiresResolution: true,
    resolvedBy: [
      base ? "field_registry" : "header_semantics",
      Object.keys(defaults).length ? "task_defaults" : "",
    ].filter(Boolean),
  };
}

function resolvePlatformCapabilityColumn(column, defaults = {}) {
  const labels = [
    column.pathLabel,
    column.displayLabel,
    column.childLabel,
    column.topLabel,
  ].filter(Boolean);
  const matches = [];
  for (const label of [...new Set(labels)]) {
    for (const capability of matchPlatformFieldLabel(label)) {
      if (!matches.some((item) => item.capabilityId === capability.capabilityId)) {
        matches.push(capability);
      }
    }
  }
  if (!matches.length) return null;
  const label = combinedLabel(column);
  const requested = {
    scene: dimensionFromColumn(column, explicitScene) || defaults.sceneDefault || "",
    contentType: dimensionFromColumn(column, explicitContentType)
      || defaults.contentTypeDefault
      || "",
    window: dimensionFromColumn(column, explicitWindow)
      || defaults.windowDefault
      || "",
    traffic: dimensionFromColumn(column, explicitTraffic)
      || defaults.trafficDefault
      || "",
    view: defaults.viewDefault || (/按成本|cost/i.test(label) ? "cost" : ""),
  };
  const compatible = matches.find((capability) => (
    Object.entries(requested).every(([dimension, value]) => (
      !value
      || !(capability.supportedDimensions?.[dimension] || []).length
      || capability.supportedDimensions[dimension].includes(value)
    ))
  )) || matches[0];
  const contract = instantiateFieldCapability(compatible, requested);
  const validation = validateFieldContract(contract);
  return {
    ...column,
    mapping: {
      id: compatible.fieldId,
      name: compatible.platformLabel,
      source: "pgy",
      unit: compatible.unit || "",
      generic: true,
    },
    contract,
    missingDimensions: validation.missingDimensions,
    requiresResolution: validation.missingDimensions.length > 0,
    resolvedBy: ["pgy_platform_label"],
  };
}

export function resolveColumn(column, defaults = {}) {
  const label = combinedLabel(column);
  const outputPolicy = outputPolicyForLabel(column.pathLabel || column.displayLabel || label);
  if (["manual", "llm_evidence", "llm_restricted"].includes(outputPolicy.mode)) {
    return {
      ...column,
      mapping: null,
      contract: null,
      missingDimensions: [],
      requiresResolution: false,
      outputPolicy,
      resolvedBy: ["output_policy"],
    };
  }
  const mapping = baseMapping(column);
  if (mapping && mapping.source !== "pgy") {
    return {
      ...column,
      mapping,
      contract: null,
      missingDimensions: [],
      requiresResolution: false,
      resolvedBy: ["field_registry"],
    };
  }
  const base = column.contract || (mapping ? contractByFieldId(mapping.id) : null);
  const looksLikeNoteMetric = Boolean(inferredMetric(label))
    && /中位|中央値|median|90|30|自然流|日常|合作|タイアップ|コラボ|daily|sponsored|近\s*16\s*篇|完播|完視聴|completion|3\s*(?:秒|sec)/i
      .test(label);
  const isNoteContract = base && ["cooperation", "daily", "all"].includes(base.scene)
    && base.view !== "profile";

  if (isNoteContract || looksLikeNoteMetric) return resolveNoteColumn(column, base, defaults);
  if (base) {
    return {
      ...column,
      mapping,
      contract: base,
      missingDimensions: [],
      requiresResolution: false,
      resolvedBy: ["field_registry"],
    };
  }
  const platformCapability = resolvePlatformCapabilityColumn(column, defaults);
  if (platformCapability) return platformCapability;
  return {
    ...column,
    mapping,
    contract: null,
    missingDimensions: [],
    requiresResolution: false,
    resolvedBy: [],
  };
}

export function resolveWorkbookColumns(columns, defaults = {}) {
  const resolvedColumns = columns.map((column) => resolveColumn(column, defaults));
  const unresolved = resolvedColumns.filter((item) => item.missingDimensions.length > 0);
  const contracts = resolvedColumns.map((item) => item.contract).filter(Boolean);
  return {
    columns: resolvedColumns,
    unresolved,
    scopeGroups: groupFieldContracts(contracts),
  };
}
