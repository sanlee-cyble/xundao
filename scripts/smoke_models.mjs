#!/usr/bin/env node
import assert from "node:assert/strict";
import { qwenToolCall } from "../src/qwen_service.mjs";
import { deepSeekJson } from "../src/recommendation_service.mjs";

const startedAt = Date.now();
const qwen = await qwenToolCall({
  messages: [
    {
      role: "system",
      content: "这是寻达模型连通性检查。必须调用 health_check 工具并返回 status=ok，不要输出其他内容。",
    },
    { role: "user", content: "执行检查" },
  ],
  tools: [{
    type: "function",
    function: {
      name: "health_check",
      description: "返回模型连通状态",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["status"],
        properties: {
          status: { type: "string", enum: ["ok"] },
        },
      },
    },
  }],
});
const qwenCall = qwen.toolCalls.find((call) => call.name === "health_check");
assert.equal(qwenCall?.arguments?.status, "ok");
const qwenDurationMs = Date.now() - startedAt;

const deepSeekStartedAt = Date.now();
const deepSeek = await deepSeekJson({
  apiKey: process.env.DEEPSEEK_API_KEY || "",
  baseUrl: process.env.DEEPSEEK_API_BASE,
  model: process.env.DEEPSEEK_MODEL,
  messages: [
    {
      role: "system",
      content: "这是寻达模型连通性检查。只返回 JSON 对象 {\"status\":\"ok\"}。",
    },
    { role: "user", content: "执行检查" },
  ],
  maxTokens: 128,
});
assert.equal(deepSeek?.status, "ok");

console.log(JSON.stringify({
  ok: true,
  qwen: {
    model: qwen.model,
    toolCall: qwenCall.name,
    durationMs: qwenDurationMs,
  },
  deepSeek: {
    model: process.env.DEEPSEEK_MODEL || "deepseek-v4-pro",
    jsonStatus: deepSeek.status,
    durationMs: Date.now() - deepSeekStartedAt,
  },
}));
