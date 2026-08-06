#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalFieldKey } from "../src/field_contracts.mjs";
import {
  extractDynamicTask,
  fillDynamicWorkbook,
} from "../src/dynamic_workbook.mjs";

const inputPath = process.env.XUNDAO_WORKBOOK_SMOKE_INPUT;
if (!inputPath) throw new Error("请设置 XUNDAO_WORKBOOK_SMOKE_INPUT");

function sampleValue(column, creator, index) {
  const fieldId = column.mapping?.id || column.contract?.fieldId || "";
  if (fieldId === "pgy.creator.name") return creator.nickname || `达人${index + 1}`;
  if (fieldId === "pgy.creator.pgy_profile") return creator.pgyLink;
  if (fieldId === "pgy.creator.xhs_profile") {
    return `https://www.xiaohongshu.com/user/profile/${creator.creatorId}`;
  }
  if (fieldId.includes("quote") || column.contract?.unit === "currency_cny") return 1000 + index * 100;
  if (column.contract?.unit === "ratio") return Number((0.12 + index * 0.03).toFixed(2));
  if (fieldId === "pgy.creator.fans_w") return 8.5 + index;
  return 1200 + index * 100;
}

const task = await extractDynamicTask(path.resolve(inputPath));
assert.ok(task.creators.length > 0, "应识别至少一位达人");
const results = task.creators.map((creator, index) => {
  const fields = {};
  const contractValues = {};
  const llmFieldDecisions = {};
  for (const column of task.columns) {
    if (column.mapping?.source === "pgy") {
      const value = sampleValue(column, creator, index);
      fields[column.mapping.name] = value;
      if (column.contract) {
        try {
          contractValues[canonicalFieldKey(column.contract)] = value;
        } catch {
          // An ambiguous test-table column is deliberately left to the display-name fallback.
        }
      }
    } else if (!column.mapping && column.displayLabel) {
      llmFieldDecisions[column.key] = {
        supported: false,
        value: "",
        evidenceKeys: [],
        reason: "便携工作簿冒烟测试不生成业务判断",
      };
    }
  }
  return {
    ...creator,
    dataStatus: "成功",
    fields,
    contractValues,
    llmFieldDecisions,
  };
});

const runDir = await fs.mkdtemp(path.join(os.tmpdir(), "xundao-workbook-smoke-"));
const outputPath = path.join(runDir, "output.xlsx");
const previewPath = path.join(runDir, "output-preview.svg");
const validationPath = path.join(runDir, "output-validation.json");
const validation = await fillDynamicWorkbook({
  inputPath: path.resolve(inputPath),
  results,
  outputPath,
  previewPath,
  validationPath,
});

assert.ok(validation.filled.length > 0, "应至少回填一个单元格");
assert.deepEqual(validation.errorInspection, []);
await Promise.all([
  fs.access(outputPath),
  fs.access(previewPath),
  fs.access(validationPath),
]);
console.log(JSON.stringify({
  ok: true,
  creatorCount: task.creators.length,
  pgyFieldCount: task.pgyFieldIds.length,
  scopeGroupCount: task.taskContract.scopeGroups.length,
  filledCount: validation.filled.length,
  blankCount: validation.leftBlank.length,
  formulaCount: validation.formulaInspection.length,
  formulaErrorCount: validation.errorInspection.length,
  outputPath,
  previewPath,
  validationPath,
}));
