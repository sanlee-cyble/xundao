import assert from "node:assert/strict";
import test from "node:test";
import { callModelWithFallback } from "../src/model_gateway.mjs";
import { qwenToolCall } from "../src/qwen_service.mjs";

test("主模型失败后调用备用模型", async () => {
  const calls = [];
  const result = await callModelWithFallback({
    primary: "qwen",
    fallback: "deepseek",
    attempts: 1,
    providers: {
      qwen: async () => {
        calls.push("qwen");
        throw new Error("timeout");
      },
      deepseek: async () => {
        calls.push("deepseek");
        return { ok: true };
      },
    },
    request: { purpose: "field_resolution" },
  });
  assert.deepEqual(calls, ["qwen", "deepseek"]);
  assert.deepEqual(result, { ok: true });
});

test("Qwen 只能返回白名单工具并解析结构化参数", async () => {
  const result = await qwenToolCall({
    apiKey: "test-key",
    messages: [{ role: "user", content: "解析" }],
    tools: [{
      type: "function",
      function: { name: "resolve_fields", parameters: { type: "object" } },
    }],
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            tool_calls: [{
              id: "call-1",
              function: { name: "resolve_fields", arguments: "{\"traffic\":\"all\"}" },
            }],
          },
        }],
      }),
    }),
  });
  assert.deepEqual(result.toolCalls[0].arguments, { traffic: "all" });
});

test("Qwen 返回越权工具时失败", async () => {
  await assert.rejects(() => qwenToolCall({
    apiKey: "test-key",
    messages: [],
    tools: [{
      type: "function",
      function: { name: "resolve_fields", parameters: { type: "object" } },
    }],
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            tool_calls: [{
              id: "call-1",
              function: { name: "delete_job", arguments: "{}" },
            }],
          },
        }],
      }),
    }),
  }), /未授权工具/);
});
