import { groupFieldContracts, validateFieldContract } from "./field_contracts.mjs";
import { validateTaskContractExecution } from "./field_execution_gate.mjs";

export function createTaskContract({ columns = [], creators = [], source = {}, version = 1 } = {}) {
  const contracts = columns.map((item) => item.contract).filter(Boolean);
  const dimensionUnresolved = columns
    .map((item) => {
      if (Array.isArray(item.missingDimensions) && item.missingDimensions.length > 0) {
        return { ...item, missingDimensions: [...item.missingDimensions] };
      }
      if (!item.contract && item.requiresResolution) {
        return { ...item, missingDimensions: item.missingDimensions || ["fieldId"] };
      }
      if (!item.contract) return null;
      const validation = validateFieldContract(item.contract);
      return validation.valid ? null : { ...item, missingDimensions: validation.missingDimensions };
    })
    .filter(Boolean);
  const provisional = {
    version,
    source,
    creators,
    columns,
    scopeGroups: groupFieldContracts(contracts),
  };
  const executionValidation = validateTaskContractExecution(provisional);
  const unresolvedByKey = new Map(
    dimensionUnresolved.map((item) => [item.key || item.letter, item]),
  );
  for (const issue of executionValidation.issues) {
    const key = issue.columnKey;
    const existing = unresolvedByKey.get(key);
    unresolvedByKey.set(key, {
      ...(existing || columns.find((column) => (column.key || column.letter) === key) || {}),
      missingDimensions: [
        ...new Set([
          ...(existing?.missingDimensions || []),
          ...(issue.missingDimensions || []),
        ]),
      ],
      executionErrors: [...(issue.errors || [])],
      capabilityId: issue.capabilityId || existing?.contract?.capabilityId || "",
    });
  }
  const unresolved = [...unresolvedByKey.values()];
  return {
    ...provisional,
    strictExecution: true,
    executionValidation,
    unresolved,
    unresolvedCount: unresolved.length,
    confirmedVersion: 0,
  };
}
