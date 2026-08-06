import { validateFieldContract } from "./field_contracts.mjs";
import { validateExecutableFieldContract } from "./pgy_field_library_v1.mjs";

const REGISTERED_DETERMINISTIC_EXECUTORS = Object.freeze([
  {
    id: "input.pgy_profile",
    matches: (contract) => contract.fieldId === "pgy.creator.pgy_profile",
    description: "由用户 Excel 或输入链接直接提供",
  },
  {
    id: "derived.xhs_profile",
    matches: (contract) => contract.fieldId === "pgy.creator.xhs_profile",
    description: "由已确认的达人 ID 确定性生成或从主页链接读取",
  },
  {
    id: "derived.fans_w",
    matches: (contract) => contract.fieldId === "pgy.creator.fans_w",
    description: "由蒲公英粉丝数按万为单位确定性换算",
  },
  {
    id: "legacy.creator_profile",
    matches: (contract) => new Set([
      "pgy.creator.total_engagement",
      "pgy.creator.age_25_plus_rate",
      "pgy.creator.top3_regions",
    ]).has(contract.fieldId),
    description: "由已登记的达人主页接口或页面解析器读取",
  },
  {
    id: "derived.like_collect_median",
    matches: (contract) => contract.fieldId === "pgy.note.like_collect.median",
    description: "由同一口径逐篇点赞与收藏数据确定性计算中位数",
  },
  {
    id: "legacy.recent16",
    matches: (contract) => (
      contract.window === "recent16"
      && contract.view === "list"
      && ["read", "like", "collect"].includes(contract.metric)
      && contract.statistic === "max"
    ),
    description: "由近 16 篇笔记明细的已登记请求确定性计算",
  },
]);

export function registeredDeterministicExecutor(contract = {}) {
  return REGISTERED_DETERMINISTIC_EXECUTORS.find((item) => item.matches(contract)) || null;
}

export function validateContractExecution(contract = {}, options = {}) {
  const structural = validateFieldContract(contract);
  if (!structural.valid) {
    return {
      valid: false,
      missingDimensions: structural.missingDimensions,
      errors: [],
      capability: null,
      executor: null,
    };
  }
  if (contract.source !== "pgy") {
    return {
      valid: true,
      missingDimensions: [],
      errors: [],
      capability: null,
      executor: { id: `source.${contract.source || "unknown"}` },
    };
  }
  const deterministic = registeredDeterministicExecutor(contract);
  if (deterministic) {
    return {
      valid: true,
      missingDimensions: [],
      errors: [],
      capability: null,
      executor: deterministic,
    };
  }
  const execution = validateExecutableFieldContract(contract, options);
  return {
    ...execution,
    executor: execution.valid
      ? {
          id: execution.capability?.request?.requestId || "pgy.capability",
          description: "蒲公英字段合同库 V1 确定性请求",
        }
      : null,
  };
}

export function validateTaskContractExecution(taskContract = {}, options = {}) {
  const issues = [];
  for (const column of taskContract.columns || []) {
    if (!column.contract) {
      if (column.requiresResolution) {
        issues.push({
          columnKey: column.key || column.letter || "",
          label: column.pathLabel || column.displayLabel || column.letter || "未命名字段",
          missingDimensions: column.missingDimensions?.length
            ? [...column.missingDimensions]
            : ["fieldId"],
          errors: [],
        });
      }
      continue;
    }
    const validation = validateContractExecution(column.contract, options);
    if (validation.valid) continue;
    issues.push({
      columnKey: column.key || column.letter || "",
      label: column.pathLabel || column.displayLabel || column.letter || "未命名字段",
      missingDimensions: validation.missingDimensions || [],
      errors: validation.errors || [],
      capabilityId: validation.capability?.capabilityId || column.contract.capabilityId || "",
    });
  }
  return {
    valid: issues.length === 0,
    issues,
    issueCount: issues.length,
  };
}

export function assertTaskContractExecutable(taskContract = {}, options = {}) {
  const validation = validateTaskContractExecution(taskContract, options);
  if (validation.valid) return validation;
  const detail = validation.issues.slice(0, 5).map((issue) => {
    const reasons = [
      ...(issue.missingDimensions?.length
        ? [`缺少维度：${issue.missingDimensions.join("、")}`]
        : []),
      ...(issue.errors || []),
    ];
    return `${issue.label}（${reasons.join("；") || "未通过执行校验"}）`;
  });
  const overflow = validation.issueCount > detail.length
    ? `，另有 ${validation.issueCount - detail.length} 个字段`
    : "";
  const error = new Error(`字段合同尚不可执行：${detail.join("；")}${overflow}`);
  error.code = "FIELD_CONTRACT_NOT_EXECUTABLE";
  error.validation = validation;
  throw error;
}
