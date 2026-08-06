const DIMENSION_LABELS = Object.freeze({
  fieldId: "对应的蒲公英原生字段",
  scene: "笔记属性（合作笔记或日常笔记）",
  contentType: "内容类型（图文、视频或图文+视频）",
  window: "时间周期",
  traffic: "流量范围（全流量或仅自然流量）",
  view: "数据视图",
});

const OPTIONS = Object.freeze({
  fieldId: [],
  scene: ["合作笔记", "日常笔记"],
  contentType: ["图文+视频", "视频", "图文"],
  window: ["近90日", "近30日"],
  traffic: ["全流量", "仅自然流量"],
  view: ["按规模", "按成本"],
});

function columnLabel(column) {
  return column.pathLabel || column.displayLabel || column.letter || "未命名字段";
}

function compactColumnLabels(columns) {
  const labels = [...new Set(columns.map(columnLabel))];
  if (labels.length <= 3) return labels.join("、");
  return `${labels.slice(0, 2).join("、")}等 ${labels.length} 个字段`;
}

export function buildClarification(taskContract, { maxQuestions = 5 } = {}) {
  const grouped = new Map();
  const executionIssues = [];
  for (const item of taskContract?.unresolved || []) {
    for (const dimension of item.missingDimensions || []) {
      if (!grouped.has(dimension)) grouped.set(dimension, []);
      grouped.get(dimension).push(item);
    }
    if (!(item.missingDimensions || []).length && item.executionErrors?.length) {
      executionIssues.push(item);
    }
  }
  const limit = Math.max(1, Math.min(Number(maxQuestions) || 5, 5));
  const questions = Array.from(grouped.entries())
    .slice(0, limit)
    .map(([dimension, columns], index) => {
      return {
        id: `clarify-${index + 1}`,
        dimension,
        prompt: `${compactColumnLabels(columns)}缺少${DIMENSION_LABELS[dimension] || dimension}，这批字段应按哪个口径采集？`,
        options: OPTIONS[dimension] || [],
        recommended: OPTIONS[dimension]?.[0] || "",
        affectedColumns: columns.map((item) => item.letter).filter(Boolean),
        affectedLabels: [...new Set(columns.map(columnLabel))],
      };
    });
  if (executionIssues.length && questions.length < limit) {
    questions.push({
      id: `clarify-${questions.length + 1}`,
      dimension: "execution",
      prompt: `${compactColumnLabels(executionIssues)}尚未完成蒲公英前端字段与请求路径对齐，当前不能安全采集；请删除这些列，或由管理员完成字段对齐后重试。`,
      options: [],
      recommended: "",
      affectedColumns: executionIssues.map((item) => item.letter).filter(Boolean),
      blocking: true,
    });
  }
  const contractCount = (taskContract?.columns || []).filter((item) => item.contract).length;
  const resolvedCount = contractCount - (taskContract?.unresolvedCount || 0);
  const recommendation = questions
    .filter((question) => question.recommended)
    .map((question) => question.recommended)
    .join("、");
  return {
    summary: taskContract?.unresolvedCount
      ? `我已识别 ${resolvedCount} 个明确字段，还有 ${taskContract.unresolvedCount} 个字段的取数口径需要确认。`
      : `我已识别全部 ${resolvedCount} 个字段，取数口径完整，可以进入确认。`,
    questions,
    recommendation,
  };
}
