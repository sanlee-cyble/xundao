import assert from "node:assert/strict";
import test from "node:test";
import {
  interpretScopeReply,
  interpretTaskIntent,
} from "../src/agent_interpretation_service.mjs";

test("规则明确时不调用 Qwen", async () => {
  let called = false;
  const result = await interpretTaskIntent({
    text: "寻找 20 位母婴达人",
    apiKey: "test-key",
    callQwen: async () => {
      called = true;
      return {};
    },
  });
  assert.equal(result.intent, "finder");
  assert.equal(called, false);
});

test("Qwen 意图候选必须通过阶段一致性校验", async () => {
  await assert.rejects(
    () => interpretTaskIntent({
      text: "帮我完成这件事",
      apiKey: "test-key",
      callQwen: async () => ({
        toolCalls: [{
          name: "route_task_intent",
          arguments: { intent: "workflow", stages: ["collect", "finder"], reason: "错误顺序" },
        }],
      }),
    }),
    /必须先寻找再采集/,
  );
});

test("Qwen 只能补当前缺失的口径维度", async () => {
  const defaults = await interpretScopeReply({
    text: "都要",
    unresolvedDimensions: ["contentType"],
    apiKey: "test-key",
    callQwen: async () => ({
      toolCalls: [{
        name: "apply_scope_decision",
        arguments: { dimension: "contentType", value: "all", reason: "用户表示不区分" },
      }],
    }),
  });
  assert.deepEqual(defaults, { contentTypeDefault: "all" });

  await assert.rejects(
    () => interpretScopeReply({
      text: "全流量",
      unresolvedDimensions: ["contentType"],
      apiKey: "test-key",
      callQwen: async () => ({
        toolCalls: [{
          name: "apply_scope_decision",
          arguments: { dimension: "traffic", value: "all", reason: "越权维度" },
        }],
      }),
    }),
    /非缺失口径维度/,
  );
});
