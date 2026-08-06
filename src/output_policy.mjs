const POLICY = new Map([
  ["下单价", { mode: "formula", formulaId: "order_price" }],
  ["实际花费", { mode: "formula", formulaId: "actual_spend" }],
  ["CPC", { mode: "formula", formulaId: "cpc_natural_read" }],
  ["推荐理由", { mode: "llm_evidence", evidenceProfile: "recommendation" }],
  ["账号数据表现", { mode: "llm_evidence", evidenceProfile: "performance_summary" }],
  ["数据表现", { mode: "llm_evidence", evidenceProfile: "performance_summary" }],
  ["达人类型", { mode: "llm_restricted", evidenceProfile: "content_tags" }],
  ["内容方向", { mode: "llm_restricted", evidenceProfile: "content_tags" }],
  ["是否合作", { mode: "manual" }],
  ["合作方式", { mode: "manual" }],
  ["授权情况", { mode: "manual" }],
]);

function normalized(value) {
  return String(value || "")
    .replace(/\r?\n/g, "")
    .replace(/\s*\/\s*/g, "/")
    .replace(/[（）]/g, (character) => character === "（" ? "(" : ")")
    .replace(/\s+/g, "")
    .toLowerCase();
}

export function outputPolicyForLabel(label) {
  const raw = String(label || "").trim();
  const exact = POLICY.get(raw);
  if (exact) return exact;
  const value = normalized(raw);
  if (
    /起用理由|推荐理由|recommendation(?:reason|rationale)|selectionreason/.test(value)
  ) {
    return { mode: "llm_evidence", evidenceProfile: "recommendation" };
  }
  if (/账号数据表现|数据表现|表现评价|performance(?:summary|evaluation)/.test(value)) {
    return { mode: "llm_evidence", evidenceProfile: "performance_summary" };
  }
  if (/达人类型|内容方向|kolカテゴリ|kolcategory|creatorcategory|contentdirection/.test(value)) {
    return { mode: "llm_restricted", evidenceProfile: "content_tags" };
  }
  if (
    /是否起用|採用可否|起用可否|whether.*(?:hire|use|select)/
      .test(value)
    || /合作方式|授权情况|起用歴|合作历史|cooperationhistory|authorization/.test(value)
    || /年度|季度|代理店|代理商|メディア|媒体|投稿予定|投稿日程|产品|商品|发布链接/.test(value)
    || /(?:計画|计划)\/?(?:目標|目标)|(?:実績|实际)\/?(?:結果|结果)|計画比|计划比/.test(value)
  ) {
    return { mode: "manual" };
  }
  return { mode: "source_or_unsupported" };
}
