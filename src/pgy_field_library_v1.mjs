import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = path.join(projectRoot, "config", "pgy-field-contracts.v1.json");
const registry = Object.freeze(JSON.parse(fs.readFileSync(registryPath, "utf8")));
const capabilities = Object.freeze(
  registry.capabilities.map((item) => Object.freeze(item)),
);

const preferredResponsePaths = Object.freeze({
  "pgy.creator.fans": "$.data.fansCount",
});

function normalizeLabel(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\r?\n/g, "")
    .replace(/[／|｜]/g, "/")
    .replace(/[（）]/g, (character) => (character === "（" ? "(" : ")"))
    .replace(/[\s:：_\-·，,。.]/g, "")
    .toLowerCase();
}

function rankCapability(item) {
  let rank = 0;
  if (item.surfaceStatus === "pgy_ui_verified") rank += 100;
  if (item.executionStatus === "collectable_scalar") rank += 20;
  if (preferredResponsePaths[item.fieldId] === item.response?.jsonPath) rank += 50;
  return rank;
}

const capabilitiesById = new Map(
  capabilities.map((item) => [item.capabilityId, item]),
);
const capabilitiesByFieldId = new Map();
const capabilitiesByLabel = new Map();
for (const capability of capabilities) {
  const fieldItems = capabilitiesByFieldId.get(capability.fieldId) || [];
  fieldItems.push(capability);
  capabilitiesByFieldId.set(capability.fieldId, fieldItems);
  for (const label of [capability.platformLabel, ...(capability.aliases || [])]) {
    const normalized = normalizeLabel(label);
    if (!normalized) continue;
    const labelItems = capabilitiesByLabel.get(normalized) || [];
    labelItems.push(capability);
    capabilitiesByLabel.set(normalized, labelItems);
  }
}
for (const items of capabilitiesByFieldId.values()) {
  items.sort((a, b) => rankCapability(b) - rankCapability(a));
}

export const PGY_FIELD_LIBRARY_V1 = registry;

export function listFieldCapabilities({
  domain = "",
  surfaceStatus = "",
  outputKind = "",
} = {}) {
  return capabilities.filter((item) => (
    (!domain || item.domain === domain)
    && (!surfaceStatus || item.surfaceStatus === surfaceStatus)
    && (!outputKind || item.response?.outputKind === outputKind)
  ));
}

export function fieldCapabilityById(capabilityId) {
  return capabilitiesById.get(String(capabilityId || "")) || null;
}

export function fieldCapabilitiesByFieldId(fieldId) {
  return [...(capabilitiesByFieldId.get(String(fieldId || "")) || [])];
}

export function matchPlatformFieldLabel(label, { domain = "" } = {}) {
  const matches = capabilitiesByLabel.get(normalizeLabel(label)) || [];
  return matches
    .filter((item) => !domain || item.domain === domain)
    .sort((a, b) => rankCapability(b) - rankCapability(a));
}

export function capabilityForContract(contract = {}) {
  if (contract.capabilityId) {
    return fieldCapabilityById(contract.capabilityId);
  }
  const matches = fieldCapabilitiesByFieldId(contract.fieldId);
  if (!matches.length) return null;
  const expectedDomain = contract.traffic === "natural"
    ? "notesNaturalTraffic"
    : contract.traffic === "all" && ["daily", "cooperation"].includes(contract.scene)
      ? "notesFullTraffic"
      : "";
  return matches.find((item) => !expectedDomain || item.domain === expectedDomain)
    || matches[0];
}

function dimensionValue(capability, dimension, requested) {
  const supported = capability.supportedDimensions?.[dimension] || [];
  if (requested && supported.includes(requested)) return requested;
  return supported.length === 1 ? supported[0] : requested || "";
}

export function instantiateFieldCapability(capabilityOrId, dimensions = {}) {
  const capability = typeof capabilityOrId === "string"
    ? fieldCapabilityById(capabilityOrId)
    : capabilityOrId;
  if (!capability) return null;
  return {
    capabilityId: capability.capabilityId,
    contractVersion: registry.schemaVersion,
    fieldId: capability.fieldId,
    metric: capability.metric,
    statistic: capability.statistic,
    scene: dimensionValue(capability, "scene", dimensions.scene),
    contentType: dimensionValue(
      capability,
      "contentType",
      dimensions.contentType,
    ),
    window: dimensionValue(capability, "window", dimensions.window),
    traffic: dimensionValue(capability, "traffic", dimensions.traffic),
    view: dimensionValue(capability, "view", dimensions.view),
    source: "pgy",
    unit: capability.unit,
    platformLabel: capability.platformLabel,
    uiPathTemplate: capability.uiPathTemplate,
    request: capability.request,
    response: capability.response,
    nullSemantics: capability.nullSemantics,
    surfaceStatus: capability.surfaceStatus,
    executionStatus: capability.executionStatus,
    evidence: capability.evidence,
  };
}

export function enrichFieldContract(contract = {}) {
  const capability = capabilityForContract(contract);
  if (!capability) return { ...contract };
  const instantiated = instantiateFieldCapability(capability, contract);
  const alignedDimension = (dimension) => {
    const original = contract[dimension];
    if (original === undefined || original === null || String(original).trim() === "") {
      return original ?? "";
    }
    const supported = capability.supportedDimensions?.[dimension] || [];
    return supported.length && !supported.includes(original)
      ? instantiated[dimension]
      : original;
  };
  return {
    ...instantiated,
    ...contract,
    capabilityId: capability.capabilityId,
    contractVersion: registry.schemaVersion,
    scene: alignedDimension("scene"),
    contentType: alignedDimension("contentType"),
    window: alignedDimension("window"),
    traffic: alignedDimension("traffic"),
    view: alignedDimension("view"),
    platformLabel: capability.platformLabel,
    uiPathTemplate: capability.uiPathTemplate,
    request: capability.request,
    response: capability.response,
    nullSemantics: capability.nullSemantics,
    surfaceStatus: capability.surfaceStatus,
    executionStatus: capability.executionStatus,
    evidence: capability.evidence,
  };
}

export function validateExecutableFieldContract(
  contract = {},
  { allowObserved = false } = {},
) {
  const required = [
    "fieldId",
    "metric",
    "statistic",
    "scene",
    "contentType",
    "window",
    "traffic",
    "view",
    "source",
    "unit",
  ];
  const missingDimensions = required.filter((key) => (
    contract[key] === undefined
    || contract[key] === null
    || String(contract[key]).trim() === ""
  ));
  const capability = capabilityForContract(contract);
  const errors = [];
  if (!capability) errors.push("字段未进入蒲公英字段合同库V1");
  if (
    capability
    && capability.surfaceStatus !== "pgy_ui_verified"
    && !allowObserved
    && !contract.uiAlignmentConfirmed
  ) {
    errors.push("字段只在接口中观察到，尚未与蒲公英前端名称和路径对齐");
  }
  if (capability) {
    for (const dimension of [
      "scene",
      "contentType",
      "window",
      "traffic",
      "view",
    ]) {
      const supported = capability.supportedDimensions?.[dimension] || [];
      if (
        contract[dimension]
        && supported.length
        && !supported.includes(contract[dimension])
      ) {
        errors.push(
          `${dimension}=${contract[dimension]}不在字段支持范围内`,
        );
      }
    }
    if (!capability.request?.requestId) errors.push("字段缺少确定性请求定义");
    if (!capability.response?.jsonPath) errors.push("字段缺少响应JSON路径");
  }
  return {
    valid: missingDimensions.length === 0 && errors.length === 0,
    missingDimensions,
    errors,
    capability,
  };
}

function tokenizeJsonPath(jsonPath) {
  return String(jsonPath || "")
    .replace(/^\$\./, "")
    .split(".")
    .filter(Boolean)
    .map((token) => ({
      key: token.replace(/\[\]$/, ""),
      array: token.endsWith("[]"),
    }));
}

function readTokens(value, tokens, index = 0) {
  if (index >= tokens.length) return value;
  if (value === null || value === undefined) return undefined;
  const token = tokens[index];
  const next = value[token.key];
  if (!token.array) return readTokens(next, tokens, index + 1);
  if (!Array.isArray(next)) return undefined;
  return next
    .map((item) => readTokens(item, tokens, index + 1))
    .filter((item) => item !== undefined);
}

export function readPgyResponsePath(payload, jsonPath) {
  if (jsonPath === "$") return payload;
  return readTokens(payload, tokenizeJsonPath(jsonPath));
}
