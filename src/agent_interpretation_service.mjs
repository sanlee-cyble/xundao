import { routeIntent } from "./intent_router.mjs";
import { qwenToolCall } from "./qwen_service.mjs";

const INTENTS = new Set(["collect", "finder", "workflow"]);
const DIMENSIONS = Object.freeze({
  scene: {
    key: "sceneDefault",
    values: new Set(["cooperation", "daily"]),
  },
  contentType: {
    key: "contentTypeDefault",
    values: new Set(["all", "video", "image"]),
  },
  window: {
    key: "windowDefault",
    values: new Set(["90d", "30d"]),
  },
  traffic: {
    key: "trafficDefault",
    values: new Set(["all", "natural"]),
  },
  view: {
    key: "viewDefault",
    values: new Set(["scale", "cost"]),
  },
});

const INTENT_TOOL = {
  type: "function",
  function: {
    name: "route_task_intent",
    description: "当确定性规则无法判断时，返回用户任务意图候选；不执行任务。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["intent", "stages", "reason"],
      properties: {
        intent: { type: "string", enum: ["collect", "finder", "workflow"] },
        stages: {
          type: "array",
          items: { type: "string", enum: ["finder", "collect"] },
          minItems: 1,
          maxItems: 2,
        },
        reason: { type: "string" },
      },
    },
  },
};

const SCOPE_TOOL = {
  type: "function",
  function: {
    name: "apply_scope_decision",
    description: "把用户对一个缺失口径维度的回答转换为候选值；不直接修改任务。",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["dimension", "value", "reason"],
      properties: {
        dimension: { type: "string", enum: Object.keys(DIMENSIONS) },
        value: {
          type: "string",
          enum: [
            "cooperation", "daily",
            "all", "video", "image",
            "90d", "30d",
            "natural",
            "scale", "cost",
          ],
        },
        reason: { type: "string" },
      },
    },
  },
};

function validateIntentCandidate(args = {}) {
  if (!INTENTS.has(args.intent)) throw new Error("Qwen 意图候选无效");
  const stages = Array.isArray(args.stages) ? args.stages : [];
  if (!stages.length || stages.some((item) => !["finder", "collect"].includes(item))) {
    throw new Error("Qwen 任务阶段候选无效");
  }
  if (args.intent === "workflow" && stages.join("|") !== "finder|collect") {
    throw new Error("两阶段任务必须先寻找再采集");
  }
  if (args.intent !== "workflow" && (stages.length !== 1 || stages[0] !== args.intent)) {
    throw new Error("单阶段任务与意图不一致");
  }
  return {
    intent: args.intent,
    stages,
    confidence: "model_candidate_validated",
    reason: String(args.reason || ""),
  };
}

export async function interpretTaskIntent({
  text,
  hasExcel = false,
  requestedIntent = "",
  apiKey = process.env.QWEN_API_KEY || "",
  callQwen = qwenToolCall,
} = {}) {
  const deterministic = routeIntent({ text, hasExcel, requestedIntent });
  if (deterministic.intent !== "unknown" || !apiKey) return deterministic;
  const result = await callQwen({
    apiKey,
    messages: [
      {
        role: "system",
        content: "你只判断寻达任务是采集数据、寻找达人或先寻找再采集。必须调用白名单工具，不执行搜索、采集或写入。",
      },
      { role: "user", content: String(text || "") },
    ],
    tools: [INTENT_TOOL],
  });
  const call = result.toolCalls.find((item) => item.name === "route_task_intent");
  if (!call) throw new Error("Qwen 未返回意图工具候选");
  return validateIntentCandidate(call.arguments);
}

export async function interpretScopeReply({
  text,
  unresolvedDimensions = [],
  apiKey = process.env.QWEN_API_KEY || "",
  callQwen = qwenToolCall,
} = {}) {
  if (!apiKey) return {};
  const allowedDimensions = new Set(unresolvedDimensions.filter((item) => DIMENSIONS[item]));
  if (!allowedDimensions.size) return {};
  const result = await callQwen({
    apiKey,
    messages: [
      {
        role: "system",
        content: `你只把用户回答转换为一个待确认口径候选。允许的缺失维度：${[...allowedDimensions].join("、")}。必须调用白名单工具，不得修改其他维度。`,
      },
      { role: "user", content: String(text || "") },
    ],
    tools: [SCOPE_TOOL],
  });
  const call = result.toolCalls.find((item) => item.name === "apply_scope_decision");
  if (!call) throw new Error("Qwen 未返回口径工具候选");
  const definition = DIMENSIONS[call.arguments.dimension];
  if (!definition || !allowedDimensions.has(call.arguments.dimension)) {
    throw new Error("Qwen 尝试修改非缺失口径维度");
  }
  if (!definition.values.has(call.arguments.value)) {
    throw new Error("Qwen 返回的口径值无效");
  }
  return { [definition.key]: call.arguments.value };
}
