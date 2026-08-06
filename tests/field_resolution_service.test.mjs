import assert from "node:assert/strict";
import test from "node:test";
import {
  fieldCandidateSet,
  resolveColumnWithFieldLibrary,
} from "../src/field_resolution_service.mjs";

test("字段库原生标签可确定性解析且不需要模型", async () => {
  const column = {
    key: "K:粉丝增长率",
    displayLabel: "粉丝增长率",
    pathLabel: "粉丝增长率",
  };
  const resolved = await resolveColumnWithFieldLibrary(column);
  assert.equal(resolved.mapping.source, "pgy");
  assert.equal(resolved.contract.fieldId, "pgy.creator.fans_growth_rate");
  assert.equal(resolved.resolvedBy.includes("pgy_field_library_exact"), true);
});

test("候选工具只能选择字段库白名单中的 capabilityId", async () => {
  const column = {
    key: "M:过去90日タイアップ動画の中央値インプレッション",
    displayLabel: "中央値インプレッション",
    parentLabel: "過去90日 タイアップ 動画 全トラフィック",
    pathLabel: "過去90日 タイアップ 動画 全トラフィック / 中央値インプレッション",
  };
  const candidates = fieldCandidateSet(column);
  assert.ok(candidates.length > 0);
  const selected = candidates.find((item) => item.fieldId === "pgy.note.exposure.median") || candidates[0];
  const resolved = await resolveColumnWithFieldLibrary(column, {
    apiKey: "test-key",
    callQwen: async ({ tools }) => {
      const allowed = tools[0].function.parameters.properties.capabilityId.enum;
      assert.ok(allowed.includes(selected.capabilityId));
      return {
        toolCalls: [{
          name: "select_pgy_field_contract",
          arguments: {
            capabilityId: selected.capabilityId,
            reason: "日文表头与曝光中位数字段一致",
          },
        }],
      };
    },
  });
  assert.equal(resolved.contract.capabilityId, selected.capabilityId);
  assert.equal(resolved.contract.scene, "cooperation");
  assert.equal(resolved.contract.contentType, "video");
  assert.equal(resolved.contract.window, "90d");
  assert.equal(resolved.contract.traffic, "all");
});

test("非蒲公英业务字段不会伪造候选", () => {
  const candidates = fieldCandidateSet({
    key: "E:是否合作",
    displayLabel: "是否合作",
    pathLabel: "是否合作",
  });
  assert.deepEqual(candidates, []);
  assert.deepEqual(fieldCandidateSet({
    key: "AZ:互动率计划比",
    displayLabel: "計画比 %",
    parentLabel: "エンゲージメント率 / 互动率",
    pathLabel: "エンゲージメント率 / 互动率 / 計画比 %",
  }), []);
  assert.deepEqual(fieldCandidateSet({
    key: "A:",
    displayLabel: "",
    pathLabel: "",
  }), []);
});

test("输出策略锁定的计划目标不会被模型候选重新映射", async () => {
  const column = {
    key: "P:总互动/计划目标",
    displayLabel: "计划目标",
    parentLabel: "总互动",
    pathLabel: "总互动 / 计划目标",
    mapping: null,
    contract: null,
    outputPolicy: { mode: "manual" },
  };
  const resolved = await resolveColumnWithFieldLibrary(column, {
    apiKey: "test-key",
    callQwen: async () => {
      throw new Error("不应调用模型");
    },
  });
  assert.equal(resolved.mapping, null);
  assert.equal(resolved.outputPolicy.mode, "manual");
});

test("Qwen 不能借选择候选暗中补齐用户未说明的流量口径", async () => {
  const column = {
    key: "M:曝光中位数",
    displayLabel: "曝光中位数",
    pathLabel: "90天合作笔记 / 图文+视频 / 曝光中位数",
  };
  const resolved = await resolveColumnWithFieldLibrary(column, {
    defaults: {
      sceneDefault: "cooperation",
      contentTypeDefault: "all",
      windowDefault: "90d",
    },
    apiKey: "test-key",
    callQwen: async ({ tools }) => ({
      toolCalls: [{
        name: "select_pgy_field_contract",
        arguments: {
          capabilityId: tools[0].function.parameters.properties.capabilityId.enum[0],
          reason: "选择曝光中位数字段候选",
        },
      }],
    }),
  });
  assert.equal(resolved.contract.traffic, "");
  assert.ok(resolved.missingDimensions.includes("traffic"));
});
