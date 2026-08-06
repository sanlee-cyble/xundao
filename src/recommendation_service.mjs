const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-pro";

function visibleLength(value) {
  return Array.from(String(value || "").replace(/\s+/g, "")).length;
}

function stripCodeFence(value) {
  return String(value || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function messageText(message = {}) {
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => (
      typeof part === "string"
        ? part
        : typeof part?.text === "string"
          ? part.text
          : typeof part?.content === "string"
            ? part.content
            : ""
    )).join("").trim();
  }
  return "";
}

function compactCreator(result) {
  const fields = result.fields || {};
  return {
    rowIndex: result.rowIndex,
    nickname: result.nickname,
    dataStatus: result.dataStatus,
    missingFields: result.missingFields || [],
    dataUpdateDate: result.dataUpdateDate || "",
    metrics: {
      followersWan: fields["粉丝数（w）"],
      videoCooperationAllTrafficExposureMedian90d: fields["合作笔记曝光中位数（90天）"],
      videoCooperationAllTrafficReadMedian90d: fields["合作笔记阅读中位数（90天）"],
      videoOrganicExposure90d: fields["预估合作笔记自然流曝光（90天）"],
      videoOrganicRead90d: fields["预估合作笔记自然流阅读（90天）"],
      trafficSources: {
        discover: fields["曝光来源-发现页"],
        search: fields["曝光来源-搜索页"],
        follow: fields["曝光来源-关注页"],
        creatorProfile: fields["曝光来源-博主个人页"],
        nearby: fields["曝光来源-附近页"],
        other: fields["曝光来源-其他"],
      },
      videoQuote: fields["报价"],
      cpc: Number(fields["预估合作笔记自然流阅读（90天）"]) > 0
        ? Number(fields["报价"]) / Number(fields["预估合作笔记自然流阅读（90天）"])
        : null,
    },
  };
}

function normalizeReasons(payload) {
  const items = Array.isArray(payload) ? payload : payload?.recommendations;
  if (!Array.isArray(items)) throw new Error("DeepSeek 未返回 recommendations 数组");
  return items.map((item) => ({
    rowIndex: Number(item.rowIndex),
    recommendationReason: String(item.recommendationReason || "").trim(),
  }));
}

function validateReasons(reasons, results) {
  const expectedRows = new Set(results.map((item) => Number(item.rowIndex)));
  const problems = [];
  const unsupported = /粉丝粘性|内容质量|性价比|稳定性存疑|互动效率|转化能力|表现突出|表现较好|(?:较|偏)(?:高|低)|风险大|成本中等|规模小|流量来源单一|数据缺失严重|搜索仅/;
  for (const rowIndex of expectedRows) {
    const source = results.find((item) => Number(item.rowIndex) === rowIndex);
    const reason = reasons.find((item) => item.rowIndex === rowIndex)?.recommendationReason || "";
    const length = visibleLength(reason);
    const sourceFields = source?.fields || {};
    const trafficValues = [
      sourceFields["曝光来源-发现页"],
      sourceFields["曝光来源-搜索页"],
      sourceFields["曝光来源-关注页"],
      sourceFields["曝光来源-博主个人页"],
      sourceFields["曝光来源-附近页"],
      sourceFields["曝光来源-其他"],
    ];
    const hasTrafficSource = trafficValues.some((value) => value !== "" && value !== null && value !== undefined && Number.isFinite(Number(value)));
    const hasCpc = Number(sourceFields["预估合作笔记自然流阅读（90天）"]) > 0
      && Number.isFinite(Number(sourceFields["报价"]));
    if (!reason) problems.push(`第 ${rowIndex} 行缺少推荐理由`);
    if (reason && (length < 80 || length > 120)) problems.push(`第 ${rowIndex} 行长度为 ${length} 字，应为 80-120 字`);
    if (unsupported.test(reason)) problems.push(`第 ${rowIndex} 行包含无法由输入字段直接证明的判断`);
    for (const requiredTerm of ["视频", "粉丝", "全流量", "自然流", "曝光", "阅读", "报价", "CPC"]) {
      if (reason && !reason.includes(requiredTerm)) problems.push(`第 ${rowIndex} 行缺少必要数据维度：${requiredTerm}`);
    }
    if (hasTrafficSource && reason && !reason.includes("%")) {
      problems.push(`第 ${rowIndex} 行缺少流量来源百分比`);
    }
    if (!hasTrafficSource && reason && !/流量来源(?:暂无数据|数据缺失)/.test(reason)) {
      problems.push(`第 ${rowIndex} 行必须如实说明流量来源暂无数据`);
    }
    if (!hasCpc && reason && !reason.includes("CPC无法计算")) {
      problems.push(`第 ${rowIndex} 行必须如实说明 CPC 无法计算`);
    }
    const expectedQuote = Number(source?.fields?.["报价"]);
    if (Number.isFinite(expectedQuote) && !reason.includes(`报价${expectedQuote}元`)) {
      problems.push(`第 ${rowIndex} 行报价未使用 videoQuote 原值 ${expectedQuote} 元`);
    }
  }
  for (const reason of reasons) {
    if (!expectedRows.has(reason.rowIndex)) problems.push(`返回了未知行 ${reason.rowIndex}`);
  }
  return problems;
}

export async function deepSeekJson({
  apiKey,
  baseUrl,
  model,
  messages,
  maxTokens = 4096,
  timeoutMs = Number(process.env.MODEL_TIMEOUT_MS || 90000),
  fetchImpl = fetch,
  onCall = () => {},
}) {
  const endpoint = `${String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: model || DEFAULT_MODEL,
        messages,
        thinking: { type: "disabled" },
        reasoning_effort: "low",
        response_format: { type: "json_object" },
        max_tokens: maxTokens,
        stream: false,
      }),
    });
    const responseText = typeof response.text === "function" ? await response.text() : "";
    const body = responseText
      ? JSON.parse(responseText)
      : typeof response.json === "function"
        ? await response.json().catch(() => ({}))
        : {};
    if (!response.ok) {
      const message = body?.error?.message || body?.message || `HTTP ${response.status}`;
      throw new Error(`DeepSeek 推荐理由生成失败：${message}`);
    }
    const choice = body?.choices?.[0] || {};
    const content = messageText(choice.message)
      || String(choice.text || body?.output_text || "").trim();
    if (!content) {
      const finishReason = choice.finish_reason || body?.finish_reason || "unknown";
      const completionTokens = body?.usage?.completion_tokens ?? body?.usage?.output_tokens ?? "unknown";
      throw new Error(
        `DeepSeek 推荐理由生成失败：响应内容为空（finish_reason=${finishReason}，completion_tokens=${completionTokens}）`,
      );
    }
    const parsed = JSON.parse(stripCodeFence(content));
    onCall({ status: "succeeded", model: model || DEFAULT_MODEL, durationMs: Date.now() - startedAt });
    return parsed;
  } catch (error) {
    onCall({
      status: "failed",
      model: model || DEFAULT_MODEL,
      durationMs: Date.now() - startedAt,
      error: error.message,
    });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function generateRecommendationReasons(results, options = {}) {
  const apiKey = options.apiKey || process.env.DEEPSEEK_API_KEY || "";
  if (!apiKey) throw new Error("美德乐模板需要配置 DEEPSEEK_API_KEY，系统不会用静态文案替代大模型推荐理由");
  const baseUrl = options.baseUrl || process.env.DEEPSEEK_API_BASE || DEFAULT_BASE_URL;
  const model = options.model || process.env.DEEPSEEK_MODEL || DEFAULT_MODEL;
  const creators = results.map(compactCreator);
  const system = [
    "你是品牌投放数据分析师，只能依据输入的蒲公英客观数据撰写推荐理由。",
    "不要推断粉丝粘性、人群画像、内容质量、品牌契合度、转化能力或稳定性，也不要使用“性价比、表现突出、较高、较低、偏高、偏低、风险大”等无明确基准的定性结论。",
    "每位博主写 80-120 个中文字符，必须明确这是“视频合作”口径，并同时出现粉丝、全流量曝光/阅读中位数、仅自然流阅读、报价和 CPC。流量来源有数据时必须引用至少一个百分比；若流量来源为空，必须写“流量来源暂无数据”，禁止虚构百分比。",
    "CPC 的唯一计算口径是报价除以仅自然流阅读；若自然流阅读为0或为空，必须写“CPC无法计算”，禁止将其写成0或推断成本水平。",
    "“报价”只能逐字引用 metrics.videoQuote 原值，格式为“报价X元”，禁止对该数值加价、换算或引用其他成本字段。",
    "决策建议只能写成条件式，例如“若重视搜索承接可关注”“建议先小规模验证”，并明确中位数与流量占比是历史快照、不能保证单次投放结果。",
    "若数据缺失，必须直说缺失会限制判断。",
    "仅返回 JSON 对象，格式为 {\"recommendations\":[{\"rowIndex\":3,\"recommendationReason\":\"...\"}]}，不要 Markdown。",
  ].join("");
  const user = `请为以下博主生成推荐理由。百分比字段为 0-1 小数，金额为人民币，所有数值仅代表本次输入快照：\n${JSON.stringify(creators)}`;
  const messages = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  let payload = null;
  let reasons = [];
  let problems = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    payload = await deepSeekJson({ apiKey, baseUrl, model, messages, onCall: options.onCall });
    reasons = normalizeReasons(payload);
    problems = validateReasons(reasons, results);
    if (!problems.length) break;
    messages.push(
      { role: "assistant", content: JSON.stringify(payload) },
      {
        role: "user",
        content: `上一次结果未通过校验：${problems.join("；")}。请完整重写全部 recommendations，并严格满足 80-120 字及客观性要求。`,
      },
    );
  }
  if (problems.length) throw new Error(`DeepSeek 推荐理由校验失败：${problems.join("；")}`);
  return results.map((result) => ({
    ...result,
    recommendationReason: reasons.find((item) => item.rowIndex === Number(result.rowIndex))?.recommendationReason || "",
    recommendationModel: model,
  }));
}
