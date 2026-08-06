const PGY_LINK_PATTERN = /https?:\/\/[^\s]*(?:pgy|ad\.xiaohongshu|xiaohongshu)[^\s]*/i;
const FINDER_PATTERN = /(?:寻找|找|筛选|推荐|搜)(?:出|到)?\s*\d*\s*(?:位|个)?[^，。；;\n]*(?:达人|博主|KOL)/i;
const COLLECT_PATTERN = /(?:采集|取数|回填|数据表现|曝光|阅读|蒲公英链接|Excel|表格)/i;

export function routeIntent({ hasExcel = false, text = "", requestedIntent = "" } = {}) {
  const value = String(text || "").trim();
  if (hasExcel) return { intent: "collect", stages: ["collect"], confidence: "deterministic" };
  const hasFinder = FINDER_PATTERN.test(value);
  const hasCollect = COLLECT_PATTERN.test(value) || PGY_LINK_PATTERN.test(value);
  const staged = hasFinder && hasCollect && /(?:先|然后|再|之后)/.test(value);
  if (staged) return {
    intent: "workflow",
    stages: ["finder", "collect"],
    confidence: "deterministic",
  };
  if (PGY_LINK_PATTERN.test(value)) return {
    intent: "collect",
    stages: ["collect"],
    confidence: "deterministic",
  };
  if (hasFinder) return { intent: "finder", stages: ["finder"], confidence: "deterministic" };
  if (hasCollect) return { intent: "collect", stages: ["collect"], confidence: "deterministic" };
  if (["collect", "finder"].includes(requestedIntent)) {
    return { intent: requestedIntent, stages: [requestedIntent], confidence: "user_selected" };
  }
  return {
    intent: "unknown",
    stages: [],
    confidence: "needs_model_or_clarification",
  };
}
