import assert from "node:assert/strict";
import test from "node:test";
import { canonicalFieldKey } from "../src/field_contracts.mjs";
import {
  buildEvidenceForResult,
  enrichUnmatchedExcelFields,
} from "../src/evidence_enrichment_service.mjs";

const dailyImageContract = {
  fieldId: "pgy.note.exposure.median",
  metric: "exposure",
  statistic: "median",
  scene: "daily",
  contentType: "image",
  window: "30d",
  traffic: "all",
  view: "scale",
  source: "pgy",
  unit: "count",
};

const metricLabel = "30天日常笔记 / 图文全流量曝光中位数";

test("模型证据包含动态字段合同值而不局限于美德乐字段名", () => {
  const result = {
    rowIndex: 2,
    fields: { 报价: 1000 },
    contractValues: {
      [canonicalFieldKey(dailyImageContract)]: 1200,
    },
  };
  const task = {
    columns: [{
      pathLabel: metricLabel,
      contract: dailyImageContract,
    }],
  };
  const evidence = buildEvidenceForResult(result, { rowIndex: 2 }, 1, task);
  assert.equal(evidence[metricLabel], 1200);
  assert.equal(evidence.报价, 1000);
});

test("任意动态口径可生成基于现有证据的推荐理由", async () => {
  const recommendation = "该达人30天日常图文全流量曝光中位数为1200次，若本次目标重视该口径可纳入初筛，并结合内容样本、预算边界与其他候选人的同口径数据进行比较，建议先做小规模验证；以上仅为历史数据，不保证单次投放结果。";
  const task = {
    creators: [{ rowIndex: 2, nickname: "测试达人" }],
    columns: [{
      pathLabel: metricLabel,
      contract: dailyImageContract,
    }],
    unmatchedColumns: [{
      key: "E:推荐理由",
      displayLabel: "推荐理由",
      pathLabel: "推荐理由",
      llmPolicy: "evidence_only",
      outputPolicy: { mode: "llm_evidence" },
    }],
  };
  const [enriched] = await enrichUnmatchedExcelFields([{
    rowIndex: 2,
    nickname: "测试达人",
    fields: {},
    contractValues: {
      [canonicalFieldKey(dailyImageContract)]: 1200,
    },
    contractProvenance: {
      [canonicalFieldKey(dailyImageContract)]: {
        valueStatus: "VALUE",
        requestSignature: "GET|/api/solar/kol/data_v3/notes_rate|advertiseSwitch=1",
        requestId: "notes.full.scale",
        endpoint: "/api/solar/kol/data_v3/notes_rate",
        capturedAt: "2026-07-31T00:00:00.000Z",
        evidenceFiles: ["raw/creator/response.json"],
      },
    },
  }], task, {
    apiKey: "test-key",
    callDeepSeek: async () => ({
      rows: [{
        rowIndex: 2,
        decisions: [{
          columnKey: "E:推荐理由",
          supported: true,
          value: recommendation,
          evidenceKeys: [metricLabel],
          reason: "引用已采集的完整口径指标",
        }],
      }],
    }),
  });
  assert.equal(enriched.llmFieldDecisions["E:推荐理由"].value, recommendation);
  assert.equal(enriched.llmFieldDecisions["E:推荐理由"].status, "MODEL_ACCEPTED");
  assert.equal(
    enriched.llmFieldDecisions["E:推荐理由"].provenance[0].requestSignature,
    "GET|/api/solar/kol/data_v3/notes_rate|advertiseSwitch=1",
  );
  assert.equal(
    enriched.cellEvidencePackages["E:推荐理由"].evidencePackets[0].fieldContractKey,
    canonicalFieldKey(dailyImageContract),
  );
  const pgyPackage = Object.values(enriched.cellEvidencePackages)
    .find((item) => item.source === "pgy_field_contract");
  assert.equal(pgyPackage.value, 1200);
  assert.equal(pgyPackage.status, "VALUE");
});

test("模型返回空内容时按批次降级留空，不阻断 Excel 导出", async () => {
  const task = {
    creators: Array.from({ length: 5 }, (_, index) => ({
      rowIndex: index + 2,
      nickname: `达人${index + 1}`,
    })),
    columns: [],
    unmatchedColumns: [{
      key: "E:推荐理由",
      displayLabel: "推荐理由",
      pathLabel: "推荐理由",
      llmPolicy: "evidence_only",
      outputPolicy: { mode: "llm_evidence" },
    }],
  };
  const warnings = [];
  let calls = 0;
  const enriched = await enrichUnmatchedExcelFields(
    task.creators.map((creator) => ({ ...creator, fields: {}, contractValues: {} })),
    task,
    {
      apiKey: "test-key",
      failOpen: true,
      batchSize: 2,
      maxAttempts: 1,
      callDeepSeek: async () => {
        calls += 1;
        throw new Error("响应内容为空");
      },
      onWarning: (warning) => warnings.push(warning),
    },
  );
  assert.equal(calls, 3);
  assert.equal(warnings.length, 3);
  assert.equal(enriched.length, 5);
  assert.ok(enriched.every((row) => (
    row.llmFieldDecisions["E:推荐理由"].status === "MODEL_UNAVAILABLE"
    && row.llmFieldDecisions["E:推荐理由"].value === ""
  )));
});

test("模型按单元格验收，推荐理由不合格不连带清空可证明字段", async () => {
  const task = {
    creators: [{ rowIndex: 2, nickname: "测试达人" }],
    columns: [],
    unmatchedColumns: [
      {
        key: "B:序号",
        displayLabel: "序号",
        pathLabel: "序号",
        llmPolicy: "evidence_only",
        outputPolicy: { mode: "llm_evidence" },
      },
      {
        key: "E:推荐理由",
        displayLabel: "推荐理由",
        pathLabel: "推荐理由",
        llmPolicy: "evidence_only",
        outputPolicy: { mode: "llm_evidence" },
      },
    ],
  };
  const warnings = [];
  const [enriched] = await enrichUnmatchedExcelFields(
    [{ rowIndex: 2, nickname: "测试达人", fields: {}, contractValues: {} }],
    task,
    {
      apiKey: "test-key",
      callDeepSeek: async () => ({
        rows: [{
          rowIndex: 2,
          decisions: [
            {
              columnKey: "B:序号",
              supported: true,
              value: 1,
              evidenceKeys: ["sequenceSuggestion"],
              reason: "按输入顺序",
            },
            {
              columnKey: "E:推荐理由",
              supported: true,
              value: "缺少完整证据。",
              evidenceKeys: ["sequenceSuggestion"],
              reason: "测试不合格内容",
            },
          ],
        }],
      }),
      onWarning: (warning) => warnings.push(warning),
    },
  );
  assert.equal(enriched.llmFieldDecisions["B:序号"].value, 1);
  assert.equal(enriched.llmFieldDecisions["E:推荐理由"].value, "");
  assert.equal(enriched.llmFieldDecisions["E:推荐理由"].status, "MODEL_REJECTED");
  assert.ok(warnings.some((warning) => warning.code === "MODEL_FIELD_REJECTED"));
});

test("模型不可用但存在平台表现证据时使用确定性推荐理由降级", async () => {
  const task = {
    creators: [{ rowIndex: 2, nickname: "测试达人" }],
    columns: [{
      pathLabel: metricLabel,
      contract: dailyImageContract,
    }],
    unmatchedColumns: [{
      key: "E:推荐理由",
      displayLabel: "推荐理由",
      pathLabel: "推荐理由",
      llmPolicy: "evidence_only",
      outputPolicy: { mode: "llm_evidence" },
    }],
  };
  const [enriched] = await enrichUnmatchedExcelFields([{
    rowIndex: 2,
    nickname: "测试达人",
    fields: {},
    contractValues: {
      [canonicalFieldKey(dailyImageContract)]: 1200,
    },
  }], task, {
    apiKey: "test-key",
    failOpen: true,
    maxAttempts: 1,
    callDeepSeek: async () => {
      throw new Error("响应内容为空");
    },
  });
  const decision = enriched.llmFieldDecisions["E:推荐理由"];
  assert.equal(decision.status, "DETERMINISTIC_FALLBACK");
  assert.match(decision.value, /30天日常笔记/);
  assert.match(decision.value, /历史数据不保证单次投放/);
  assert.ok(Array.from(decision.value.replace(/\s+/g, "")).length >= 80);
  assert.ok(Array.from(decision.value.replace(/\s+/g, "")).length <= 120);
});
