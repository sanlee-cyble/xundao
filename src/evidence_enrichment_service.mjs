import { LLM_FIELD_POLICY } from "./field_registry.mjs";
import { canonicalFieldKey } from "./field_contracts.mjs";
import { deepSeekJson } from "./recommendation_service.mjs";
import {
  attachDecisionEvidence,
  buildCellEvidencePackage,
  buildEvidencePacketsForResult,
  buildPgyCellEvidencePackages,
} from "./cell_evidence_service.mjs";
import { VALUE_STATUS } from "./value_status.mjs";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-pro";

function visibleLength(value) {
  return Array.from(String(value || "").replace(/\s+/g, "")).length;
}

export function buildEvidenceForResult(result, creator, sequence, task) {
  const fields = result.fields || {};
  const contractEvidence = {};
  for (const column of task?.columns || []) {
    if (!column.contract) continue;
    try {
      const key = canonicalFieldKey(column.contract);
      if (!Object.hasOwn(result.contractValues || {}, key)) continue;
      const label = column.pathLabel || column.displayLabel || column.mapping?.name || key;
      contractEvidence[label] = result.contractValues[key];
    } catch {
      // Unresolved legacy contracts are intentionally excluded from model evidence.
    }
  }
  const evidence = {
    rowIndex: Number(result.rowIndex || creator.rowIndex),
    sequenceSuggestion: sequence,
    nickname: result.nickname || creator.nickname || "",
    pgyLink: result.pgyLink || creator.pgyLink || "",
    ...fields,
    ...contractEvidence,
  };
  const quote = Number(fields["报价"]);
  const naturalReadEntry = Object.entries(evidence).find(([key, value]) => (
    /自然流/.test(key)
    && /阅读/.test(key)
    && Number(value) > 0
  ));
  const naturalRead = Number(fields["预估合作笔记自然流阅读（90天）"] || naturalReadEntry?.[1]);
  if (Number.isFinite(quote) && naturalRead > 0) {
    evidence["CPC（报价/仅自然流阅读）"] = Number((quote / naturalRead).toFixed(4));
  }
  return evidence;
}

function normalizePayload(payload) {
  const rows = Array.isArray(payload) ? payload : payload?.rows;
  if (!Array.isArray(rows)) throw new Error("DeepSeek 未返回 rows 数组");
  return rows.map((row) => ({
    rowIndex: Number(row.rowIndex),
    decisions: (Array.isArray(row.decisions) ? row.decisions : []).map((decision) => ({
      columnKey: String(decision.columnKey || ""),
      supported: decision.supported === true,
      value: decision.value ?? "",
      evidenceKeys: Array.isArray(decision.evidenceKeys)
        ? decision.evidenceKeys.map((key) => String(key))
        : [],
      reason: String(decision.reason || "").trim(),
    })),
  }));
}

function validateDecisions(rows, results, task, evidenceRows) {
  const problems = [];
  const expectedColumns = task.unmatchedColumns.map((column) => column.key);
  const protectedLabels = new Set(LLM_FIELD_POLICY.protected);
  const unsupportedClaims = /粉丝粘性|转化能力|购买力|品牌契合|性价比|优质达人|爆款能力|稳定性强|值得合作|建议合作|高转化|低成本|侧面反映|自然流量潜力/;
  for (const result of results) {
    const rowIndex = Number(result.rowIndex);
    const returned = rows.find((row) => row.rowIndex === rowIndex);
    const evidenceRow = evidenceRows.find((row) => row.rowIndex === rowIndex) || {};
    const evidence = evidenceRow.evidence || {};
    const evidencePackets = evidenceRow.evidencePackets || {};
    if (!returned) {
      problems.push(`第 ${rowIndex} 行未返回`);
      continue;
    }
    for (const column of task.unmatchedColumns) {
      const decision = returned.decisions.find((item) => item.columnKey === column.key);
      if (!decision) {
        problems.push(`第 ${rowIndex} 行缺少 ${column.key}`);
        continue;
      }
      if (protectedLabels.has(column.displayLabel) && decision.supported) {
        problems.push(`第 ${rowIndex} 行 ${column.displayLabel} 属于业务事实，不能由表现数据推断`);
      }
      const evidenceProfile = column.outputPolicy?.evidenceProfile || "";
      if (
        !decision.supported
        && (evidenceProfile === "content_tags" || column.displayLabel === "达人类型")
        && String(evidence["内容标签"] || "").trim()
      ) {
        problems.push(`第 ${rowIndex} 行已有内容标签，达人类型应据此填写`);
      }
      if (
        !decision.supported
        && (evidenceProfile === "content_tags" || column.displayLabel === "内容方向")
        && (String(evidence["内容标签"] || "").trim() || String(evidence["内容特征标签"] || "").trim())
      ) {
        problems.push(`第 ${rowIndex} 行已有内容或特征标签，内容方向应据此填写`);
      }
      if (!decision.supported) continue;
      if (decision.value === null || decision.value === undefined || String(decision.value).trim() === "") {
        problems.push(`第 ${rowIndex} 行 ${column.displayLabel} 声称可填但值为空`);
      }
      if (!decision.evidenceKeys.length) problems.push(`第 ${rowIndex} 行 ${column.displayLabel} 缺少 evidenceKeys`);
      for (const key of decision.evidenceKeys) {
        if (!Object.hasOwn(evidence, key)) problems.push(`第 ${rowIndex} 行 ${column.displayLabel} 引用了不存在的证据 ${key}`);
        const packet = evidencePackets[key];
        if (!packet) {
          problems.push(`第 ${rowIndex} 行 ${column.displayLabel} 缺少证据包 ${key}`);
        } else if (![VALUE_STATUS.VALUE, VALUE_STATUS.ZERO].includes(packet.valueStatus)) {
          problems.push(`第 ${rowIndex} 行 ${column.displayLabel} 引用了不可用证据 ${key}（${packet.valueStatus}）`);
        }
      }
      const content = String(decision.value || "");
      if (unsupportedClaims.test(content)) problems.push(`第 ${rowIndex} 行 ${column.displayLabel} 包含现有数据无法证明的判断`);
      if (evidenceProfile === "recommendation" || column.displayLabel === "推荐理由") {
        const length = visibleLength(content);
        if (length < 80 || length > 120) problems.push(`第 ${rowIndex} 行推荐理由为 ${length} 字，应为 80-120 字`);
        if (!content.includes("历史")) problems.push(`第 ${rowIndex} 行推荐理由缺少历史数据风险提示`);
        const evidenceKeys = Object.keys(evidence);
        for (const term of ["全流量", "自然流"]) {
          if (evidenceKeys.some((key) => key.includes(term)) && !content.includes(term)) {
            problems.push(`第 ${rowIndex} 行已有${term}证据但推荐理由未区分口径`);
          }
        }
        const quote = Number(evidence["报价"]);
        if (Number.isFinite(quote) && !content.includes(`报价${quote}元`)) {
          problems.push(`第 ${rowIndex} 行推荐理由未使用报价原值 ${quote} 元`);
        }
        if (Object.hasOwn(evidence, "CPC（报价/仅自然流阅读）") && !content.includes("CPC")) {
          problems.push(`第 ${rowIndex} 行已有 CPC 证据但推荐理由未引用`);
        }
        const hasTraffic = Object.entries(evidence).some(([key, value]) => (
          /流量来源|发现页|搜索页|关注页|博主个人页|附近页/.test(key)
          && Number.isFinite(Number(value))
        ));
        if (hasTraffic && (!content.includes("%") || !/(发现页|搜索页|关注页|博主个人页|附近页)/.test(content))) {
          problems.push(`第 ${rowIndex} 行有流量来源证据，推荐理由必须引用至少一个页面占比`);
        }
      }
      if (evidenceProfile === "performance_summary" || column.displayLabel === "账号数据表现") {
        const length = visibleLength(content);
        if (length < 50 || length > 180) problems.push(`第 ${rowIndex} 行账号数据表现为 ${length} 字，应为 50-180 字`);
      }
      if (/无合作记录|无合作笔记历史/.test(content)) {
        const sampleCount = Number(evidence["90天合作笔记样本数"]);
        if (sampleCount !== 0 || !decision.evidenceKeys.includes("90天合作笔记样本数")) {
          problems.push(`第 ${rowIndex} 行 ${column.displayLabel} 把0值写成无合作记录，但未引用目标口径样本数`);
        }
      }
    }
    for (const decision of returned.decisions) {
      if (!expectedColumns.includes(decision.columnKey)) problems.push(`第 ${rowIndex} 行返回未知列 ${decision.columnKey}`);
    }
  }
  return problems;
}

function forcePolicy(rows, task) {
  const columnByKey = new Map(task.unmatchedColumns.map((column) => [column.key, column]));
  return rows.map((row) => ({
    ...row,
    decisions: row.decisions.map((decision) => {
      const column = columnByKey.get(decision.columnKey);
      if (!column || column.llmPolicy !== "protected") return decision;
      return {
        ...decision,
        supported: false,
        value: "",
        evidenceKeys: [],
        reason: "合作、合作方式和授权属于业务事实，蒲公英表现数据不能证明",
      };
    }),
  }));
}

function sanitizeModelRows(rows, results, task, evidenceRows) {
  const warnings = [];
  const sanitized = results.map((result) => {
    const rowIndex = Number(result.rowIndex);
    const returned = rows.find((row) => row.rowIndex === rowIndex);
    const decisions = task.unmatchedColumns.map((column) => {
      const decision = returned?.decisions.find((item) => item.columnKey === column.key);
      if (!decision) {
        const reason = `第 ${rowIndex} 行缺少 ${column.key}`;
        warnings.push(reason);
        return {
          columnKey: column.key,
          supported: false,
          value: "",
          evidenceKeys: [],
          reason,
          status: "MODEL_REJECTED",
        };
      }
      const problems = validateDecisions(
        [{ rowIndex, decisions: [decision] }],
        [result],
        { ...task, unmatchedColumns: [column] },
        evidenceRows.filter((item) => item.rowIndex === rowIndex),
      );
      if (!problems.length) {
        const packetMap = evidenceRows.find((item) => item.rowIndex === rowIndex)?.evidencePackets || {};
        return attachDecisionEvidence({
          ...decision,
          status: "MODEL_ACCEPTED",
        }, packetMap);
      }
      warnings.push(...problems);
      return {
        columnKey: column.key,
        supported: false,
        value: "",
        evidenceKeys: [],
        reason: problems.join("；"),
        status: "MODEL_REJECTED",
      };
    });
    return { rowIndex, decisions };
  });
  return { rows: sanitized, warnings };
}

function manualDecisions(task) {
  return task.unmatchedColumns
    .filter((column) => column.outputPolicy?.mode === "manual" || column.llmPolicy === "protected")
    .map((column) => ({
      columnKey: column.key,
      supported: false,
      value: "",
      evidenceKeys: [],
      reason: "该字段属于合作或授权业务事实，必须由媒介同学人工确认",
      status: "MANUAL_REQUIRED",
    }));
}

function evidenceValueText(key, value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return String(value || "").trim();
  if (/报价/.test(key)) return `${numeric}元`;
  if (/CPC/.test(key)) return numeric.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  if (/(比例|占比|来源|发现页|搜索页|关注页|个人页|附近页)/.test(key)) {
    const percent = Math.abs(numeric) <= 1 ? numeric * 100 : numeric;
    return `${Number(percent.toFixed(1))}%`;
  }
  return String(Number(numeric.toFixed(2)));
}

function performanceEvidenceEntries(evidence = {}) {
  const ignored = /^(rowIndex|sequenceSuggestion|nickname|pgyLink|蒲公英链接|小红书主页链接|达人名称)$/;
  const priority = [
    /CPC/,
    /自然流.*阅读/,
    /自然流.*曝光/,
    /全流量.*阅读/,
    /全流量.*曝光/,
    /(?:近?\s*90|90\s*天|90\s*日).*(?:阅读|互动|曝光)/,
    /粉丝/,
    /报价/,
    /阅读中位数/,
    /曝光中位数/,
    /(发现页|搜索页|关注页|个人页|附近页)/,
    /(点赞|收藏|赞藏)/,
  ];
  return Object.entries(evidence)
    .filter(([key, value]) => (
      !ignored.test(key)
      && value !== null
      && value !== undefined
      && String(value).trim() !== ""
      && !["内容标签", "内容特征标签"].includes(key)
    ))
    .map(([key, value], index) => ({
      key,
      value,
      index,
      priority: priority.findIndex((pattern) => pattern.test(key)),
    }))
    .sort((left, right) => {
      const leftPriority = left.priority < 0 ? priority.length : left.priority;
      const rightPriority = right.priority < 0 ? priority.length : right.priority;
      return leftPriority - rightPriority || left.index - right.index;
    });
}

function compactEvidenceLabel(key) {
  return String(key || "")
    .replace(/\s*\/\s*/g, "·")
    .replace(/预估合作笔记/g, "合作笔记")
    .replace(/[（）]/g, (character) => character === "（" ? "(" : ")")
    .trim();
}

function deterministicNarrative(label, evidence, evidenceProfile = "") {
  const entries = performanceEvidenceEntries(evidence);
  if (!entries.length) return null;
  const isRecommendation = evidenceProfile === "recommendation" || label === "推荐理由";
  const isPerformance = evidenceProfile === "performance_summary" || label === "账号数据表现";
  const phrases = entries.slice(0, isRecommendation ? 2 : 4).map((entry) => (
    `${compactEvidenceLabel(entry.key)}为${evidenceValueText(entry.key, entry.value)}`
  ));
  if (isPerformance) {
    const value = `当前任务已采集：${phrases.join("，")}。以上仅陈述本次口径下的历史数据，未采集指标及合作、授权事实不作推断。`;
    return {
      value: visibleLength(value) > 180 ? `${value.slice(0, 176)}。` : value,
      evidenceKeys: entries.slice(0, phrases.length).map((entry) => entry.key),
    };
  }
  if (isRecommendation) {
    let used = phrases;
    let value = `该达人历史数据中，${used.join("，")}。若本次目标重视上述口径，可纳入同口径候选比较，并结合内容样本、预算和品牌要求人工复核；历史数据不保证单次投放结果。`;
    while (visibleLength(value) > 120 && used.length > 1) {
      used = used.slice(0, -1);
      value = `该达人历史数据中，${used.join("，")}。若本次目标重视上述口径，可纳入同口径候选比较，并结合内容样本、预算和品牌要求人工复核；历史数据不保证单次投放结果。`;
    }
    if (visibleLength(value) < 80) {
      value = value.replace("人工复核", "人工复核，并优先进行小规模内容验证");
    }
    if (visibleLength(value) > 120) return null;
    return {
      value,
      evidenceKeys: entries.slice(0, used.length).map((entry) => entry.key),
    };
  }
  return null;
}

export function buildDeterministicRecommendation(result, {
  creator = {},
  sequence = 1,
  task = null,
} = {}) {
  const evidence = buildEvidenceForResult(result, creator, sequence, task);
  return deterministicNarrative("推荐理由", evidence, "recommendation")?.value || "";
}

function deterministicFallbackDecision(column, evidence) {
  const label = column.displayLabel;
  const evidenceProfile = column.outputPolicy?.evidenceProfile || "";
  if (label === "序号" && Number(evidence.sequenceSuggestion) > 0) {
    return {
      columnKey: column.key,
      supported: true,
      value: Number(evidence.sequenceSuggestion),
      evidenceKeys: ["sequenceSuggestion"],
      reason: "按本次输入中的达人顺序填写",
      status: "DETERMINISTIC_FALLBACK",
    };
  }
  if (evidenceProfile === "content_tags" || label === "达人类型" || label === "内容方向") {
    const sourceKeys = ["内容标签", "内容特征标签"]
      .filter((key) => String(evidence[key] || "").trim());
    if (!sourceKeys.length) return null;
    const value = sourceKeys
      .map((key) => String(evidence[key]).trim())
      .filter((item, index, values) => values.indexOf(item) === index)
      .join("、")
      .slice(0, 80);
    return {
      columnKey: column.key,
      supported: true,
      value,
      evidenceKeys: sourceKeys,
      reason: "依据蒲公英返回的内容标签填写，不扩展推断",
      status: "DETERMINISTIC_FALLBACK",
    };
  }
  const narrative = deterministicNarrative(label, evidence, evidenceProfile);
  if (!narrative) return null;
  return {
    columnKey: column.key,
    supported: true,
    value: narrative.value,
    evidenceKeys: narrative.evidenceKeys,
    reason: "模型不可用或输出未通过审计，改用确定性证据摘要",
    status: "DETERMINISTIC_FALLBACK",
  };
}

function unavailableDecisions(task, reason) {
  return task.unmatchedColumns.map((column) => ({
    columnKey: column.key,
    supported: false,
    value: "",
    evidenceKeys: [],
    reason,
    status: "MODEL_UNAVAILABLE",
  }));
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => run()),
  );
  return results;
}

export async function enrichUnmatchedExcelFields(results, task, options = {}) {
  results = results.map((result) => ({
    ...result,
    cellEvidencePackages: {
      ...(result.cellEvidencePackages || {}),
      ...buildPgyCellEvidencePackages(result, task),
    },
  }));
  if (!task?.unmatchedColumns?.length) return results;
  const failOpen = options.failOpen === true;
  const protectedKeys = new Set(manualDecisions(task).map((item) => item.columnKey));
  const modelTask = {
    ...task,
    unmatchedColumns: task.unmatchedColumns.filter((column) => !protectedKeys.has(column.key)),
  };
  const fixedManualDecisions = manualDecisions(task);
  if (!modelTask.unmatchedColumns.length) {
    return results.map((result, index) => {
      const creator = (task.creators || []).find((item) => Number(item.rowIndex) === Number(result.rowIndex)) || {};
      const packetMap = buildEvidencePacketsForResult(result, creator, index + 1, task);
      const decisions = fixedManualDecisions.map((decision) => attachDecisionEvidence(decision, packetMap));
      const columnByKey = new Map(task.unmatchedColumns.map((column) => [column.key, column]));
      return {
        ...result,
        llmFieldDecisions: Object.fromEntries(decisions.map((decision) => [decision.columnKey, decision])),
        cellEvidencePackages: {
          ...(result.cellEvidencePackages || {}),
          ...Object.fromEntries(decisions.map((decision) => [
            decision.columnKey,
            buildCellEvidencePackage({
              rowIndex: result.rowIndex,
              column: columnByKey.get(decision.columnKey),
              decision,
              packetMap,
            }),
          ])),
        },
        llmModel: "",
      };
    });
  }
  const apiKey = options.apiKey || process.env.DEEPSEEK_API_KEY || "";
  if (!apiKey && !failOpen) {
    throw new Error("动态 Excel 存在非蒲公英字段，需要配置 DEEPSEEK_API_KEY 才能执行证据判断");
  }
  const baseUrl = options.baseUrl || process.env.DEEPSEEK_API_BASE || DEFAULT_BASE_URL;
  const model = options.model || process.env.DEEPSEEK_MODEL || DEFAULT_MODEL;
  const evidenceRows = results.map((result, index) => {
    const creator = (task.creators || []).find((item) => Number(item.rowIndex) === Number(result.rowIndex)) || {};
    const sequence = Math.max(
      1,
      (task.creators || []).findIndex((item) => Number(item.rowIndex) === Number(result.rowIndex)) + 1,
    );
    const evidence = buildEvidenceForResult(result, creator, sequence || index + 1, task);
    const evidencePackets = buildEvidencePacketsForResult(
      result,
      creator,
      sequence || index + 1,
      task,
    );
    if (Object.hasOwn(evidence, "CPC（报价/仅自然流阅读）")) {
      evidencePackets["CPC（报价/仅自然流阅读）"] = {
        evidenceKey: "CPC（报价/仅自然流阅读）",
        value: evidence["CPC（报价/仅自然流阅读）"],
        valueStatus: Number(evidence["CPC（报价/仅自然流阅读）"]) === 0
          ? VALUE_STATUS.ZERO
          : VALUE_STATUS.VALUE,
        source: "deterministic_formula",
        formula: "报价/仅自然流阅读",
        dependencies: ["报价"],
        evidenceFiles: result.evidenceFiles || [],
        platformDataUpdateDate: result.dataUpdateDate || "",
      };
    }
    return {
      rowIndex: Number(result.rowIndex),
      currentValues: creator.currentValues || {},
      evidence,
      evidencePackets,
    };
  });
  const targetColumns = modelTask.unmatchedColumns.map((column) => ({
    columnKey: column.key,
    field: column.displayLabel,
    headerPath: column.pathLabel,
    policy: column.llmPolicy,
    evidenceProfile: column.outputPolicy?.evidenceProfile || "",
  }));
  const system = [
    "你是品牌媒介数据审计员。任务不是尽量填满表格，而是逐格判断现有证据是否足以支持填写。",
    "只能使用输入 evidence 中存在的键和值；不得使用常识、外部资料或对达人身份、受众、转化、合作关系的猜测。",
    "policy=protected 的是否合作、合作方式、授权情况一律 unsupported，因为表现数据不能证明业务事实。",
    "序号只可依据 sequenceSuggestion；达人类型、内容方向只可依据内容标签、内容特征标签或明确昵称；不能凭印象扩展。",
    "只要 evidence 中内容标签非空，达人类型必须据此填写；只要内容标签或内容特征标签至少一项非空，内容方向必须据此填写。",
    "账号数据表现写 50-180 个中文字符，只陈述 evidence 中实际存在且带完整口径的客观数值与缺失项，不使用“高、低、优秀、性价比、稳定、潜力、侧面反映”等无比较基准词。",
    "只有 evidence 中“90天合作笔记样本数”为0时，才可写近90天目标口径无样本；不要扩大成达人从未合作。",
    "推荐理由写 80-120 个中文字符，必须是条件式建议，只引用本行 evidence 实际存在的指标，并出现“历史数据不保证单次投放”或同义风险提示。",
    "evidence 同时存在全流量与自然流字段时必须明确区分；存在报价时逐字引用报价原值；存在“CPC（报价/仅自然流阅读）”时必须引用 CPC。",
    "有曝光来源数据时引用至少一个页面及百分比；任务没有采集曝光来源时，不得把未请求字段写成数据缺失。",
    "若证据不足，supported=false、value为空，并简述缺什么；宁可留空，绝不能补猜。",
    "表头可能是中文、日文或英文；先按 headerPath 理解字段语义，但 value 采用该字段明确要求的语言，未明确时使用中文。",
    "每个 evidenceKeys 必须逐字来自对应 evidence 对象的键。",
    "只返回 JSON：{\"rows\":[{\"rowIndex\":3,\"decisions\":[{\"columnKey\":\"B:序号\",\"supported\":true,\"value\":1,\"evidenceKeys\":[\"sequenceSuggestion\"],\"reason\":\"...\"}]}]}。每行必须覆盖全部目标列。",
  ].join("");
  const batchSize = Math.max(1, Number(options.batchSize || 4));
  const batches = [];
  for (let index = 0; index < results.length; index += batchSize) {
    batches.push({
      results: results.slice(index, index + batchSize),
      evidenceRows: evidenceRows.slice(index, index + batchSize),
    });
  }

  const batchOutcomes = apiKey
    ? await mapWithConcurrency(
        batches,
        Number(options.concurrency || 2),
        async (batch) => {
          const messages = [
            { role: "system", content: system },
            {
              role: "user",
              content: `目标列：${JSON.stringify(targetColumns)}\n逐行证据及证据包：${JSON.stringify(batch.evidenceRows)}`,
            },
          ];
          let normalized = [];
          let problems = [];
          let auditWarnings = [];
          const maxAttempts = Math.max(1, Number(options.maxAttempts || 2));
          for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            try {
              const payload = await (options.callDeepSeek || deepSeekJson)({
                apiKey,
                baseUrl,
                model,
                messages,
                maxTokens: Number(options.maxTokens || 16000),
                timeoutMs: Number(options.timeoutMs || 45000),
                onCall: options.onCall,
              });
              const parsed = forcePolicy(normalizePayload(payload), modelTask);
              const audited = sanitizeModelRows(
                parsed,
                batch.results,
                modelTask,
                batch.evidenceRows,
              );
              normalized = audited.rows;
              auditWarnings = audited.warnings;
              problems = [];
            } catch (error) {
              normalized = [];
              problems = [`响应解析失败：${error.message}`];
            }
            if (!problems.length) break;
            if (normalized.length) {
              messages.push({ role: "assistant", content: JSON.stringify({ rows: normalized }) });
            }
            messages.push({
              role: "user",
              content: `上次结果未通过审计：${problems.join("；")}。请完整重写本批次全部 rows，输出紧凑 JSON，保留证据约束，不能省略任何目标列。`,
            });
          }
          return {
            normalized,
            problems,
            auditWarnings,
            results: batch.results,
          };
        },
      )
    : batches.map((batch) => ({
        normalized: [],
        problems: ["未配置 DeepSeek API Key"],
        auditWarnings: [],
        results: batch.results,
      }));

  const failedOutcomes = batchOutcomes.filter((outcome) => outcome.problems.length);
  if (failedOutcomes.length && !failOpen) {
    const problems = failedOutcomes.flatMap((outcome) => outcome.problems);
    throw new Error(`DeepSeek 非蒲公英字段审计失败：${problems.join("；")}`);
  }
  const normalized = batchOutcomes.flatMap((outcome) => (
    outcome.problems.length ? [] : outcome.normalized
  ));
  const failedRows = new Map();
  for (const outcome of failedOutcomes) {
    const reason = `模型补充暂不可用：${outcome.problems.join("；")}`;
    for (const result of outcome.results) failedRows.set(Number(result.rowIndex), reason);
    options.onWarning?.({
      code: "MODEL_ENRICHMENT_UNAVAILABLE",
      message: reason,
      rowIndexes: outcome.results.map((result) => Number(result.rowIndex)),
    });
  }
  for (const outcome of batchOutcomes.filter((item) => item.auditWarnings?.length)) {
    options.onWarning?.({
      code: "MODEL_FIELD_REJECTED",
      message: `模型返回中有 ${outcome.auditWarnings.length} 个字段未通过证据校验，已逐格留空`,
      rowIndexes: outcome.results.map((result) => Number(result.rowIndex)),
      details: outcome.auditWarnings,
    });
  }
  return results.map((result) => {
    const row = normalized.find((item) => item.rowIndex === Number(result.rowIndex));
    const unavailableReason = failedRows.get(Number(result.rowIndex));
    const evidence = evidenceRows.find((item) => item.rowIndex === Number(result.rowIndex))?.evidence || {};
    const packetMap = evidenceRows.find((item) => item.rowIndex === Number(result.rowIndex))?.evidencePackets || {};
    const modelDecisions = row?.decisions || (unavailableReason
        ? unavailableDecisions(modelTask, unavailableReason)
        : []);
    const decisions = [
      ...modelTask.unmatchedColumns.map((column) => {
        const decision = modelDecisions.find((item) => item.columnKey === column.key);
        if (decision?.supported) return decision;
        return deterministicFallbackDecision(column, evidence) || decision || {
          columnKey: column.key,
          supported: false,
          value: "",
          evidenceKeys: [],
          reason: "现有证据不足，保持空白",
          status: "MODEL_UNSUPPORTED",
        };
      }),
      ...fixedManualDecisions,
    ].map((decision) => attachDecisionEvidence(decision, packetMap));
    const fallbackCount = decisions.filter((decision) => decision.status === "DETERMINISTIC_FALLBACK").length;
    const columnByKey = new Map(task.unmatchedColumns.map((column) => [column.key, column]));
    const cellEvidencePackages = Object.fromEntries(decisions.map((decision) => [
      decision.columnKey,
      buildCellEvidencePackage({
        rowIndex: result.rowIndex,
        column: columnByKey.get(decision.columnKey) || {
          key: decision.columnKey,
          displayLabel: decision.columnKey,
        },
        decision,
        packetMap,
        model: row ? model : "",
      }),
    ]));
    return {
      ...result,
      llmFieldDecisions: Object.fromEntries(decisions.map((decision) => [decision.columnKey, decision])),
      cellEvidencePackages: {
        ...(result.cellEvidencePackages || {}),
        ...cellEvidencePackages,
      },
      llmModel: row ? model : "",
      ...(unavailableReason ? {
        llmWarning: fallbackCount
          ? `${unavailableReason}；已用确定性证据规则补充 ${fallbackCount} 个字段`
          : unavailableReason,
      } : {}),
    };
  });
}
