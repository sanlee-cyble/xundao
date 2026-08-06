const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_MODEL = "qwen3.7-max";

function toolName(tool) {
  return tool?.function?.name || tool?.name || "";
}

export function normalizeQwenToolCalls(body, tools) {
  const allowed = new Set(tools.map(toolName).filter(Boolean));
  const calls = body?.choices?.[0]?.message?.tool_calls || [];
  return calls.map((call) => {
    const name = String(call?.function?.name || "");
    if (!allowed.has(name)) throw new Error(`Qwen 返回了未授权工具：${name || "空"}`);
    let args = {};
    try {
      args = JSON.parse(call?.function?.arguments || "{}");
    } catch {
      throw new Error(`Qwen 工具参数不是合法 JSON：${name}`);
    }
    if (!args || Array.isArray(args) || typeof args !== "object") {
      throw new Error(`Qwen 工具参数必须是对象：${name}`);
    }
    return { id: String(call.id || ""), name, arguments: args };
  });
}

export async function qwenToolCall({
  apiKey = process.env.QWEN_API_KEY || "",
  baseUrl = process.env.QWEN_API_BASE || DEFAULT_BASE_URL,
  model = process.env.QWEN_MODEL || DEFAULT_MODEL,
  messages,
  tools,
  timeoutMs = Number(process.env.MODEL_TIMEOUT_MS || 90000),
  fetchImpl = fetch,
}) {
  if (!apiKey) throw new Error("缺少 QWEN_API_KEY");
  if (!Array.isArray(tools) || !tools.length) throw new Error("Qwen 调用缺少工具白名单");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, tools, tool_choice: "auto", stream: false }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message || `Qwen HTTP ${response.status}`);
    return {
      body,
      content: String(body?.choices?.[0]?.message?.content || ""),
      toolCalls: normalizeQwenToolCalls(body, tools),
      model,
    };
  } finally {
    clearTimeout(timer);
  }
}
