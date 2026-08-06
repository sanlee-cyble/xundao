const REQUIRED_DIMENSIONS = Object.freeze([
  "fieldId",
  "metric",
  "scene",
  "contentType",
  "window",
  "traffic",
  "view",
  "source",
  "unit",
]);

export function validateFieldContract(contract = {}) {
  const missingDimensions = REQUIRED_DIMENSIONS.filter((key) => {
    const value = contract[key];
    return value === undefined || value === null || String(value).trim() === "";
  });
  return { valid: missingDimensions.length === 0, missingDimensions };
}

export function canonicalFieldKey(contract) {
  const validation = validateFieldContract(contract);
  if (!validation.valid) {
    throw new Error(`字段合同缺少维度：${validation.missingDimensions.join("、")}`);
  }
  return [
    contract.fieldId,
    contract.scene,
    contract.contentType,
    contract.window,
    contract.traffic,
    contract.view,
  ].join("|");
}

export function scopeGroupKey(contract) {
  const parts = [
    contract.scene,
    contract.contentType,
    contract.window,
    contract.traffic,
    contract.view,
  ];
  const requestId = contract.request?.requestId || contract.requestId || "";
  if (requestId) parts.push(requestId);
  return parts.join("|");
}

export function groupFieldContracts(contracts = []) {
  const groups = new Map();
  for (const contract of contracts) {
    const validation = validateFieldContract(contract);
    if (!validation.valid) continue;
    const key = scopeGroupKey(contract);
    const group = groups.get(key) || {
      id: `scope-${groups.size + 1}`,
      key,
      scene: contract.scene,
      contentType: contract.contentType,
      window: contract.window,
      traffic: contract.traffic,
      view: contract.view,
      requestId: contract.request?.requestId || contract.requestId || "",
      request: contract.request || null,
      contracts: [],
    };
    group.contracts.push(contract);
    groups.set(key, group);
  }
  return Array.from(groups.values());
}
