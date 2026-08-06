#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalFieldKey } from "../src/field_contracts.mjs";
import { fillDynamicWorkbook } from "../src/dynamic_workbook.mjs";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    options[token.slice(2)] = argv[index + 1];
    index += 1;
  }
  return options;
}

function required(options, name) {
  if (!options[name]) throw new Error(`缺少参数 --${name}`);
  return path.resolve(options[name]);
}

function visibleLength(value) {
  return Array.from(String(value || "").replace(/\s+/g, "")).length;
}

function compactNumber(value, digits = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return number.toLocaleString("zh-CN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  });
}

function percent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return `${Number((number * 100).toFixed(1))}%`;
}

function columnByLetter(task, letter) {
  const column = (task.columns || []).find((item) => item.letter === letter);
  if (!column) throw new Error(`任务缺少 ${letter} 列`);
  return column;
}

function contractValue(result, column) {
  const key = canonicalFieldKey(column.contract);
  if (!Object.hasOwn(result.contractValues || {}, key)) {
    throw new Error(`第 ${result.rowIndex} 行缺少 ${column.pathLabel} 的合同值`);
  }
  return {
    key: column.pathLabel,
    value: result.contractValues[key],
  };
}

const options = parseArgs(process.argv.slice(2));
const runDir = required(options, "run-dir");
const inputPath = required(options, "input");
const outputPath = required(options, "output");
const task = JSON.parse(await fs.readFile(path.join(runDir, "task.json"), "utf8"));
const results = JSON.parse(await fs.readFile(path.join(runDir, "final-results.json"), "utf8"));

const columns = {
  fullExposure: columnByLetter(task, "M"),
  fullRead: columnByLetter(task, "N"),
  discover: columnByLetter(task, "T"),
  naturalExposure: columnByLetter(task, "AE"),
  naturalRead: columnByLetter(task, "AF"),
  dailyRead: columnByLetter(task, "AH"),
  recentRead: columnByLetter(task, "AN"),
};

const enriched = results.map((result) => {
  const fullExposure = contractValue(result, columns.fullExposure);
  const fullRead = contractValue(result, columns.fullRead);
  const discover = contractValue(result, columns.discover);
  const naturalExposure = contractValue(result, columns.naturalExposure);
  const naturalRead = contractValue(result, columns.naturalRead);
  const dailyRead = contractValue(result, columns.dailyRead);
  const recentRead = contractValue(result, columns.recentRead);
  const sampleCount = Number(result.fields?.["90天合作笔记样本数"]);
  const quote = Number(result.fields?.["报价"]);
  const cpc = quote / Number(naturalRead.value);
  if (!Number.isFinite(sampleCount) || !Number.isFinite(quote) || !Number.isFinite(cpc)) {
    throw new Error(`第 ${result.rowIndex} 行缺少生成审计文本所需的样本数、报价或自然流阅读`);
  }

  const performance = [
    `近90天合作样本${sampleCount}篇：全流量曝光中位数${compactNumber(fullExposure.value)}、阅读中位数${compactNumber(fullRead.value)}`,
    `发现页占比${percent(discover.value)}`,
    `仅自然流曝光${compactNumber(naturalExposure.value)}、阅读${compactNumber(naturalRead.value)}`,
    `30天日常阅读中位数${compactNumber(dailyRead.value)}`,
    `近16篇最高阅读${compactNumber(recentRead.value)}`,
    `视频报价${compactNumber(quote)}元`,
  ].join("；") + "。";

  const recommendation = [
    "若本轮目标重视曝光与阅读，可纳入复核",
    `90天合作全流量阅读中位数${compactNumber(fullRead.value)}`,
    `发现页占比${percent(discover.value)}`,
    `仅自然流阅读${compactNumber(naturalRead.value)}`,
    `报价${compactNumber(quote)}元，CPC约${compactNumber(cpc, 2)}元`,
    `结合内容方向和${sampleCount}篇样本判断，历史数据不保证单次投放`,
  ].join("；") + "。";

  const performanceLength = visibleLength(performance);
  const recommendationLength = visibleLength(recommendation);
  if (performanceLength < 50 || performanceLength > 180) {
    throw new Error(`第 ${result.rowIndex} 行账号数据表现长度 ${performanceLength} 不合格`);
  }
  if (recommendationLength < 80 || recommendationLength > 120) {
    throw new Error(`第 ${result.rowIndex} 行推荐理由长度 ${recommendationLength} 不合格`);
  }

  const decisions = {
    ...(result.llmFieldDecisions || {}),
    "E:账号数据表现": {
      columnKey: "E:账号数据表现",
      supported: true,
      value: performance,
      evidenceKeys: [
        "90天合作笔记样本数",
        fullExposure.key,
        fullRead.key,
        discover.key,
        naturalExposure.key,
        naturalRead.key,
        dailyRead.key,
        recentRead.key,
        "报价",
      ],
      reason: "DeepSeek 已完成可填性判断；其自由文本未通过长度与证据审计，改由程序按同一证据合同格式化",
      status: "AUDITED_DETERMINISTIC_FALLBACK",
    },
    "F:推荐理由": {
      columnKey: "F:推荐理由",
      supported: true,
      value: recommendation,
      evidenceKeys: [
        "90天合作笔记样本数",
        fullRead.key,
        discover.key,
        naturalRead.key,
        "报价",
        "CPC（报价/仅自然流阅读）",
      ],
      reason: "DeepSeek 已完成可填性判断；其自由文本未通过长度与证据审计，改由程序按同一证据合同生成条件式建议",
      status: "AUDITED_DETERMINISTIC_FALLBACK",
    },
  };
  return {
    ...result,
    llmFieldDecisions: decisions,
  };
});

const resultsPath = path.join(runDir, "final-results-audited.json");
await fs.writeFile(resultsPath, `${JSON.stringify(enriched, null, 2)}\n`, "utf8");
const previewPath = outputPath.replace(/\.xlsx$/i, ".preview.svg");
const validationPath = outputPath.replace(/\.xlsx$/i, ".validation.json");
const validation = await fillDynamicWorkbook({
  inputPath,
  task,
  results: enriched,
  outputPath,
  previewPath,
  validationPath,
});

console.log(JSON.stringify({
  ok: true,
  outputPath,
  previewPath,
  validationPath,
  resultsPath,
  creatorCount: enriched.length,
  performanceLengths: enriched.map((result) => visibleLength(result.llmFieldDecisions["E:账号数据表现"].value)),
  recommendationLengths: enriched.map((result) => visibleLength(result.llmFieldDecisions["F:推荐理由"].value)),
  filledCount: validation.filled.length,
  blankCount: validation.leftBlank.length,
}));
