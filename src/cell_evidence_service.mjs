import { canonicalFieldKey } from "./field_contracts.mjs";
import { VALUE_STATUS } from "./value_status.mjs";

function statusForValue(value) {
  if (value === null || value === undefined || String(value).trim() === "") {
    return VALUE_STATUS.NO_SAMPLE;
  }
  return Number(value) === 0 ? VALUE_STATUS.ZERO : VALUE_STATUS.VALUE;
}

function genericPacket({
  evidenceKey,
  value,
  source,
  result,
  extra = {},
}) {
  return {
    evidenceKey,
    value,
    valueStatus: statusForValue(value),
    source,
    capturedAt: extra.capturedAt || "",
    platformDataUpdateDate: result.dataUpdateDate || "",
    evidenceFiles: result.evidenceFiles || [],
    ...extra,
  };
}

export function buildEvidencePacketsForResult(result = {}, creator = {}, sequence = 1, task = null) {
  const packets = {};
  const add = (packet) => {
    if (!packet?.evidenceKey) return;
    packets[packet.evidenceKey] = packet;
  };
  add(genericPacket({
    evidenceKey: "sequenceSuggestion",
    value: sequence,
    source: "task_input",
    result,
  }));
  add(genericPacket({
    evidenceKey: "nickname",
    value: result.nickname || creator.nickname || "",
    source: "pgy_or_task_input",
    result,
  }));
  add(genericPacket({
    evidenceKey: "pgyLink",
    value: result.pgyLink || creator.pgyLink || "",
    source: "task_input",
    result,
  }));

  for (const [key, value] of Object.entries(result.fields || {})) {
    add(genericPacket({
      evidenceKey: key,
      value,
      source: "pgy_page_or_registered_legacy_executor",
      result,
    }));
  }

  for (const column of task?.columns || []) {
    if (!column.contract) continue;
    let contractKey = "";
    try {
      contractKey = canonicalFieldKey(column.contract);
    } catch {
      continue;
    }
    if (!Object.hasOwn(result.contractValues || {}, contractKey)) continue;
    const evidenceKey = column.pathLabel
      || column.displayLabel
      || column.mapping?.name
      || contractKey;
    const provenance = result.contractProvenance?.[contractKey] || {};
    add(genericPacket({
      evidenceKey,
      value: result.contractValues[contractKey],
      source: "pgy_field_contract",
      result,
      extra: {
        ...provenance,
        fieldContractKey: contractKey,
        fieldId: column.contract.fieldId,
        capabilityId: column.contract.capabilityId || provenance.capabilityId || "",
        platformLabel: column.contract.platformLabel || provenance.platformLabel || "",
        uiPathTemplate: column.contract.uiPathTemplate || provenance.uiPathTemplate || [],
        valueStatus: provenance.valueStatus || statusForValue(result.contractValues[contractKey]),
      },
    }));
  }
  return packets;
}

export function evidencePacketList(packetMap = {}) {
  return Object.values(packetMap).filter((packet) => (
    [VALUE_STATUS.VALUE, VALUE_STATUS.ZERO].includes(packet.valueStatus)
  ));
}

export function attachDecisionEvidence(decision = {}, packetMap = {}) {
  const evidencePackets = (decision.evidenceKeys || [])
    .map((key) => packetMap[key])
    .filter(Boolean);
  return {
    ...decision,
    evidencePackets,
    provenance: evidencePackets.map((packet) => ({
      evidenceKey: packet.evidenceKey,
      source: packet.source,
      valueStatus: packet.valueStatus,
      fieldContractKey: packet.fieldContractKey || "",
      fieldId: packet.fieldId || "",
      capabilityId: packet.capabilityId || "",
      requestSignature: packet.requestSignature || "",
      requestId: packet.requestId || "",
      endpoint: packet.endpoint || "",
      capturedAt: packet.capturedAt || "",
      evidenceFiles: packet.evidenceFiles || [],
    })),
  };
}

export function buildCellEvidencePackage({
  rowIndex,
  column,
  decision,
  packetMap = {},
  model = "",
}) {
  const enriched = attachDecisionEvidence(decision, packetMap);
  return {
    rowIndex: Number(rowIndex),
    columnKey: column.key,
    targetLabel: column.pathLabel || column.displayLabel || column.key,
    outputPolicy: column.outputPolicy || null,
    supported: enriched.supported === true,
    value: enriched.value ?? "",
    status: enriched.status || VALUE_STATUS.MODEL_UNSUPPORTED,
    reason: enriched.reason || "",
    generatedBy: enriched.status === "MODEL_ACCEPTED"
      ? model || "model"
      : enriched.status === "DETERMINISTIC_FALLBACK"
        ? "deterministic_evidence_rule"
        : enriched.status === "MANUAL_REQUIRED"
          ? "manual"
          : "model_audit",
    evidenceKeys: enriched.evidenceKeys || [],
    evidencePackets: enriched.evidencePackets,
    provenance: enriched.provenance,
    auditedAt: new Date().toISOString(),
  };
}

export function buildPgyCellEvidencePackages(result = {}, task = null) {
  const packets = buildEvidencePacketsForResult(result, {}, 0, task);
  const packages = {};
  for (const column of task?.columns || []) {
    if (!column.contract || column.contract.source !== "pgy") continue;
    let contractKey = "";
    try {
      contractKey = canonicalFieldKey(column.contract);
    } catch {
      continue;
    }
    const targetKey = column.key || `${column.letter || ""}:${column.pathLabel || column.displayLabel || contractKey}`;
    const evidenceKey = column.pathLabel
      || column.displayLabel
      || column.mapping?.name
      || contractKey;
    const packet = packets[evidenceKey]
      || packets[column.mapping?.name]
      || (Object.hasOwn(result.fields || {}, column.mapping?.name)
        ? genericPacket({
            evidenceKey,
            value: result.fields[column.mapping.name],
            source: "pgy_page_or_registered_legacy_executor",
            result,
          })
        : null);
    packages[targetKey] = {
      rowIndex: Number(result.rowIndex),
      columnKey: targetKey,
      targetLabel: evidenceKey,
      source: "pgy_field_contract",
      fieldContractKey: contractKey,
      fieldId: column.contract.fieldId,
      capabilityId: column.contract.capabilityId || "",
      platformLabel: column.contract.platformLabel || "",
      value: packet?.value ?? null,
      status: packet?.valueStatus || result.contractProvenance?.[contractKey]?.valueStatus || VALUE_STATUS.NO_SAMPLE,
      evidencePackets: packet ? [packet] : [],
      provenance: packet ? attachDecisionEvidence({
        evidenceKeys: [evidenceKey],
      }, packets).provenance : [],
    };
  }
  return packages;
}
