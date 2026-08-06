import { canonicalFieldKey } from "./field_contracts.mjs";
import { readPgyResponsePath } from "./pgy_field_library_v1.mjs";
import { validateContractExecution } from "./field_execution_gate.mjs";
import { VALUE_STATUS } from "./value_status.mjs";

const SCENE = Object.freeze({ daily: 0, cooperation: 1 });
const CONTENT_TYPE = Object.freeze({ image: 1, video: 2, all: 3 });
const WINDOW = Object.freeze({ "30d": 1, "90d": 2 });
const TRAFFIC = Object.freeze({ natural: 0, all: 1 });

function requestTemplateValue(value, context) {
  if (typeof value !== "string") return value;
  const exact = value.match(/^\{([^}]+)\}$/);
  if (exact) return context[exact[1]] ?? value;
  return value.replace(/\{([^}]+)\}/g, (_, key) => String(context[key] ?? ""));
}

function compileCapabilityRequest(group, creatorId, requestSpec) {
  const context = {
    creatorId,
    sceneCode: SCENE[group.scene],
    contentTypeCode: CONTENT_TYPE[group.contentType],
    windowCode: WINDOW[group.window],
    trafficCode: TRAFFIC[group.traffic],
    pageNumber: 1,
  };
  const endpoint = requestTemplateValue(
    requestSpec.endpointTemplate,
    context,
  );
  const template = requestSpec.method === "POST"
    ? requestSpec.bodyTemplate || {}
    : requestSpec.queryTemplate || {};
  const params = Object.fromEntries(
    Object.entries(template).map(([key, value]) => [
      key,
      requestTemplateValue(value, context),
    ]),
  );
  return {
    id: `${creatorId}:${group.id}`,
    groupId: group.id,
    requestId: requestSpec.requestId,
    endpoint,
    method: requestSpec.method,
    params,
    expectedFieldIds: group.contracts.map((item) => item.fieldId),
    contracts: group.contracts,
  };
}

export function requestSignature(request) {
  return [
    request.method,
    request.endpoint,
    ...Object.entries(request.params || {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`),
  ].join("|");
}

export function compileScopeRequest(group, creatorId) {
  if (group.window === "recent16") {
    return {
      id: `${creatorId}:${group.id}`,
      groupId: group.id,
      endpoint: "/api/solar/kol/data_v2/notes_detail",
      method: "GET",
      params: {
        userId: creatorId,
        advertiseSwitch: 1,
        orderType: 1,
        pageNumber: 1,
        pageSize: 16,
        noteType: 4,
        isThirdPlatform: 0,
      },
      expectedFieldIds: group.contracts.map((item) => item.fieldId),
      contracts: group.contracts,
    };
  }
  const requestSpec = group.request
    || group.contracts?.find((item) => item.request)?.request;
  if (
    requestSpec
    && !["notes.full.scale", "notes.natural.scale"].includes(
      requestSpec.requestId,
    )
  ) {
    return compileCapabilityRequest(group, creatorId, requestSpec);
  }
  if (!(group.scene in SCENE)) throw new Error(`不支持的笔记属性：${group.scene}`);
  if (!(group.contentType in CONTENT_TYPE)) throw new Error(`不支持的内容类型：${group.contentType}`);
  if (!(group.window in WINDOW)) throw new Error(`不支持的时间周期：${group.window}`);
  if (!(group.traffic in TRAFFIC)) throw new Error(`不支持的流量范围：${group.traffic}`);
  const params = {
    userId: creatorId,
    business: SCENE[group.scene],
    noteType: CONTENT_TYPE[group.contentType],
    dateType: WINDOW[group.window],
    advertiseSwitch: TRAFFIC[group.traffic],
  };
  return {
    id: `${creatorId}:${group.id}`,
    groupId: group.id,
    endpoint: group.traffic === "natural"
      ? "/api/pgy/kol/data/core_data"
      : "/api/solar/kol/data_v3/notes_rate",
    method: group.traffic === "natural" ? "POST" : "GET",
    params,
    expectedFieldIds: group.contracts.map((item) => item.fieldId),
    contracts: group.contracts,
  };
}

export function compileTaskCollectionPlan(taskContract, creatorId) {
  const requests = [];
  const signatures = new Set();
  for (const group of taskContract.scopeGroups || []) {
    if (taskContract.strictExecution === true) {
      for (const contract of group.contracts || []) {
        const validation = validateContractExecution(contract);
        if (!validation.valid) {
          const reasons = [
            ...(validation.missingDimensions?.length
              ? [`缺少维度：${validation.missingDimensions.join("、")}`]
              : []),
            ...(validation.errors || []),
          ];
          throw new Error(
            `字段合同不可执行：${contract.platformLabel || contract.fieldId || "未命名字段"}（${reasons.join("；")}）`,
          );
        }
      }
    }
    const hasCapabilityRequest = Boolean(
      group.request?.requestId
      || group.contracts?.some((item) => item.request?.requestId),
    );
    if (group.scene === "creator" && !hasCapabilityRequest) continue;
    const request = compileScopeRequest(group, creatorId);
    const signature = requestSignature(request);
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    requests.push({ ...request, signature });
  }
  return { creatorId, requests };
}

export function contractProvenanceForRequest(request, values = {}, outcome = {}) {
  const capturedAt = outcome.capturedAt || new Date().toISOString();
  return Object.fromEntries((request.contracts || []).map((contract) => {
    const key = canonicalFieldKey(contract);
    const hasValue = Object.hasOwn(values, key);
    const value = hasValue ? values[key] : null;
    const status = !outcome.ok
      ? VALUE_STATUS.COLLECTION_FAILED
      : !hasValue
        ? VALUE_STATUS.NO_SAMPLE
        : Number(value) === 0
          ? VALUE_STATUS.ZERO
          : VALUE_STATUS.VALUE;
    return [key, {
      source: "pgy",
      fieldContractKey: key,
      fieldId: contract.fieldId,
      capabilityId: contract.capabilityId || "",
      platformLabel: contract.platformLabel || "",
      uiPathTemplate: contract.uiPathTemplate || [],
      surfaceStatus: contract.surfaceStatus || "",
      requestSignature: request.signature || requestSignature(request),
      requestId: request.requestId || contract.request?.requestId || "",
      endpoint: request.endpoint,
      method: request.method,
      params: request.params || {},
      transport: outcome.transport || "",
      httpStatus: Number(outcome.status || 0),
      valueStatus: status,
      capturedAt,
      error: outcome.error || "",
    }];
  }));
}

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function ratio(value) {
  const number = finite(value);
  if (number === null) return null;
  return number > 1 ? number / 100 : number;
}

function median(values) {
  const clean = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const middle = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[middle] : (clean[middle - 1] + clean[middle]) / 2;
}

function noteRateValue(contract, data) {
  const direct = {
    sample: data.noteNumber,
    exposure: data.impMedian,
    read: data.readMedian,
    interaction: data.interactionMedian,
    interaction_rate: data.interactionRate,
    video_full_view: data.videoFullViewRate,
    picture_3s_view: data.picture3sViewRate,
    like: data.likeMedian,
    collect: data.collectMedian,
    comment: data.commentMedian,
    share: data.shareMedian,
    hundred_like: data.hundredLikePercent,
    thousand_like: data.thousandLikePercent,
  };
  if (contract.metric === "like_collect") {
    return median((Array.isArray(data.notes) ? data.notes : []).map((note) => {
      const like = finite(note.likeNum);
      const collect = finite(note.collectNum);
      return like === null || collect === null ? Number.NaN : like + collect;
    }));
  }
  if (contract.metric.startsWith("traffic_")) {
    const traffic = {
      traffic_discover: data.pagePercentVo?.impHomefeedPercent,
      traffic_search: data.pagePercentVo?.impSearchPercent,
      traffic_follow: data.pagePercentVo?.impFollowPercent,
      traffic_profile: data.pagePercentVo?.impDetailPercent,
      traffic_nearby: data.pagePercentVo?.impNearbyPercent,
      traffic_other: data.pagePercentVo?.impOtherPercent,
      read_traffic_discover: data.pagePercentVo?.readHomefeedPercent,
      read_traffic_search: data.pagePercentVo?.readSearchPercent,
      read_traffic_follow: data.pagePercentVo?.readFollowPercent,
      read_traffic_profile: data.pagePercentVo?.readDetailPercent,
      read_traffic_nearby: data.pagePercentVo?.readNearbyPercent,
      read_traffic_other: data.pagePercentVo?.readOtherPercent,
    };
    return finite(traffic[contract.metric]);
  }
  if (contract.metric.startsWith("read_traffic_")) {
    const traffic = {
      read_traffic_discover: data.pagePercentVo?.readHomefeedPercent,
      read_traffic_search: data.pagePercentVo?.readSearchPercent,
      read_traffic_follow: data.pagePercentVo?.readFollowPercent,
      read_traffic_profile: data.pagePercentVo?.readDetailPercent,
      read_traffic_nearby: data.pagePercentVo?.readNearbyPercent,
      read_traffic_other: data.pagePercentVo?.readOtherPercent,
    };
    return finite(traffic[contract.metric]);
  }
  if (contract.metric === "interaction" && contract.statistic === "rate") {
    return ratio(data.interactionRate);
  }
  return contract.statistic === "rate"
    ? ratio(direct[contract.metric])
    : finite(direct[contract.metric]);
}

function naturalValue(contract, data) {
  const values = {
    exposure: data?.sumData?.imp,
    read: data?.sumData?.read,
    interaction: data?.sumData?.engage,
    cpm: data?.sumData?.cpm,
    cpv: data?.sumData?.cpv,
    cpuv: data?.sumData?.cpuv,
    cpe: data?.sumData?.cpe,
  };
  return finite(values[contract.metric]);
}

function recentValue(contract, data) {
  const notes = Array.isArray(data?.list) ? data.list.slice(0, 16) : [];
  const property = {
    read: "readNum",
    like: "likeNum",
    collect: "collectNum",
  }[contract.metric];
  if (!property) return null;
  const values = notes.map((item) => finite(item[property])).filter((value) => value !== null);
  return values.length ? Math.max(...values) : null;
}

export function extractContractValues(request, payload) {
  const values = {};
  const data = payload?.data || {};
  for (const contract of request.contracts || []) {
    let value = null;
    if (contract.response?.jsonPath) {
      const rawValue = readPgyResponsePath(payload, contract.response.jsonPath);
      if (rawValue !== undefined && rawValue !== null) {
        if (contract.response.outputKind === "scalar") {
          value = contract.unit === "ratio" || contract.unit === "ratio_native"
            ? ratio(rawValue)
            : ["count", "people", "currency_cny", "ten_thousand_people"].includes(contract.unit)
              ? finite(rawValue)
              : rawValue;
        } else {
          value = rawValue;
        }
      }
    }
    if (value === null && request.endpoint.includes("/notes_rate")) {
      value = noteRateValue(contract, data);
    } else if (value === null && request.endpoint.includes("/core_data")) {
      value = naturalValue(contract, data);
    } else if (value === null && request.endpoint.includes("/notes_detail")) {
      value = recentValue(contract, data);
    }
    if (value !== null) values[canonicalFieldKey(contract)] = value;
  }
  return values;
}
