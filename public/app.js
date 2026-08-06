const fallbackCategories = [
  ["全部", []],
  ["运动健身", ["减脂塑形", "滑雪", "滑板", "水上活动", "运动其他", "足球", "篮球", "跑步", "游泳"]],
];

const FALLBACK_TEMPLATES = [
  {
    id: "fuji",
    label: "富士模板",
    description: "原有达人表现字段，支持候选池和 Excel 回填。",
    fields: [
      { name: "粉丝数", group: "基础信息", default: true },
      { name: "总互动数", group: "基础信息", default: true },
      { name: "图文报价", group: "报价", default: true },
      { name: "视频报价", group: "报价", default: true },
      { name: "阅读中位数", group: "表现数据", default: true },
      { name: "互动中位数", group: "表现数据", default: true },
      { name: "视频完播率", group: "表现数据", default: true },
      { name: "图文3秒阅读率", group: "表现数据", default: false },
      { name: "预估阅读单价", group: "成本", default: false },
      { name: "预估互动单价", group: "成本", default: false },
      { name: "活跃粉丝占比", group: "粉丝画像", default: false },
      { name: "阅读粉丝占比", group: "粉丝画像", default: false },
      { name: "互动粉丝占比", group: "粉丝画像", default: false },
      { name: "下单粉丝占比", group: "粉丝画像", default: false },
      { name: "25岁以上粉丝占比", group: "粉丝画像", default: true },
      { name: "粉丝地域分布前3位", group: "粉丝画像", default: true },
    ],
  },
  {
    id: "medela",
    label: "美德乐模板",
    description: "视频合作笔记近 90 天全流量中位数、仅自然流数据、成本公式与推荐理由。",
    fields: [
      { name: "小红书主页链接", group: "基础信息", default: true },
      { name: "粉丝数（w）", group: "基础信息", default: true },
      { name: "合作笔记曝光中位数（90天）", group: "合作表现", default: true },
      { name: "曝光来源-发现页", group: "曝光来源", default: true },
      { name: "曝光来源-搜索页", group: "曝光来源", default: true },
      { name: "曝光来源-关注页", group: "曝光来源", default: true },
      { name: "曝光来源-博主个人页", group: "曝光来源", default: true },
      { name: "曝光来源-附近页", group: "曝光来源", default: true },
      { name: "曝光来源-其他", group: "曝光来源", default: true },
      { name: "合作笔记阅读中位数（90天）", group: "合作表现", default: true },
      { name: "预估合作笔记自然流曝光（90天）", group: "合作表现", default: true },
      { name: "预估合作笔记自然流阅读（90天）", group: "合作表现", default: true },
      { name: "报价", group: "成本", default: true },
      { name: "下单价", group: "成本", default: true, derived: true },
      { name: "实际花费", group: "成本", default: true, derived: true },
      { name: "CPC", group: "成本", default: true, derived: true },
      { name: "推荐理由", group: "决策辅助", default: true, generated: true },
    ],
  },
];

let templates = FALLBACK_TEMPLATES;
let FIELD_LIBRARY = templates[0].fields;
let defaultFields = FIELD_LIBRARY.filter((field) => field.default).map((field) => field.name);

const state = {
  categories: [],
  candidates: [],
  selected: new Set(),
  selectedCandidates: new Map(),
  selectedFields: new Set(defaultFields),
  savedTemplates: [],
  templateId: "fuji",
  activeScreen: "workbench",
  collectJobId: "",
  collectJob: null,
  records: [],
  pollTimer: null,
  searchState: "idle",
  searchWithinResults: false,
  filtersCollapsed: false,
  resultSearchQuery: "",
  lastSearchInput: "",
  batchIndex: 0,
  searchRequestId: 0,
  currentTask: "待输入关键词",
  lastSavedAt: "",
  poolSaveTimer: null,
  restoringPool: false,
  analytics: null,
  analyticsError: "",
  analyticsAccess: null,
  analyticsToken: window.localStorage?.getItem("xundao_analytics_token") || "",
  sessionId: window.localStorage?.getItem("xundao_session_id") || "",
};

if (!state.sessionId) {
  state.sessionId = `session-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
  window.localStorage?.setItem("xundao_session_id", state.sessionId);
}

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));
const API_BASE = window.location.protocol === "file:" ? "http://localhost:8731" : "";

function setText(selector, value) {
  const node = $(selector);
  if (node) node.textContent = value;
}

function setConnectionState({ connected = false, error = false, text = "" } = {}) {
  const badge = $("#connectionBadge");
  if (badge) {
    badge.classList.toggle("is-connected", connected);
    badge.classList.toggle("is-error", error);
  }
  setText("#connectionText", text);
}

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function candidateId(item) {
  return String(item.creatorId || item.userId || item.id || item.redId || item.name || item.nickname || "");
}

function numberValue(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(numberValue(value));
}

function formatCompact(value) {
  const numeric = numberValue(value);
  if (!numeric) return "0";
  if (numeric >= 10000) return `${(numeric / 10000).toFixed(1)}万`;
  return formatNumber(numeric);
}

function formatCurrency(value) {
  const numeric = numberValue(value);
  return numeric ? `¥${formatNumber(numeric)}` : "¥0";
}

function candidatePrice(item) {
  return numberValue(item.lowerPrice || item.price || item.picturePrice || item.videoPrice);
}

function metricText(value) {
  const numeric = numberValue(value);
  return numeric ? formatNumber(numeric) : "-";
}

function totalInteractionText(item) {
  const numeric = numberValue(item.totalInteraction || item.likeCollectCount || item.likeCollectNum || item.likeAndCollectCount || item.totalLikeCollectCount);
  if (numeric) return formatNumber(numeric);
  if (item.totalInteractionStatus === "loading") return "读取中";
  return "-";
}

function statusText(status) {
  return {
    uploaded: "待采集",
    running: "采集中",
    done: "已完成",
    failed: "失败",
  }[status] || "待处理";
}

function statusClass(status) {
  return {
    uploaded: "muted",
    running: "running",
    done: "ready",
    failed: "failed",
  }[status] || "muted";
}

function taskStateText(stateValue) {
  return {
    PARSING: "解析中",
    NEEDS_CLARIFICATION: "待澄清",
    READY_TO_CONFIRM: "待确认",
    CONFIRMED: "已确认",
    COLLECTING: "采集中",
    VALIDATING: "校验中",
    EXPORTING: "导出中",
    COMPLETED: "已完成",
    FAILED: "失败",
  }[stateValue] || "待处理";
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2600);
}

async function postJson(url, body = {}) {
  const response = await fetch(apiUrl(url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.message || "请求失败");
  return data;
}

async function getJson(url) {
  const response = await fetch(apiUrl(url));
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.message || "请求失败");
  return data;
}

function analyticsHeaders() {
  return state.analyticsToken ? { "x-analytics-token": state.analyticsToken } : {};
}

function percentText(value) {
  return `${Number(value || 0).toFixed(1).replace(".0", "")}%`;
}

function durationText(value) {
  const ms = Number(value || 0);
  if (!ms) return "0s";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60000)}min`;
}

function compactProperties(value) {
  const text = JSON.stringify(value || {});
  return text.length > 130 ? `${text.slice(0, 130)}...` : text;
}

function fanBucket(item) {
  const fans = numberValue(item?.fans || item?.fansNum);
  if (!fans) return "未知";
  if (fans < 300) return "路人";
  if (fans < 5000) return "素人";
  if (fans < 50000) return "初级达人";
  if (fans < 500000) return "腰部达人";
  return "头部达人";
}

function track(eventName, properties = {}, extra = {}) {
  fetch(apiUrl("/api/analytics/track"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      eventName,
      sessionId: state.sessionId,
      page: state.activeScreen,
      properties,
      ...extra,
    }),
  }).catch(() => {});
}

function candidatePoolPayload() {
  return {
    name: `${filtersFromForm().keyword || "当前"}候选池`,
    filters: filtersFromForm(),
    candidates: selectedItems(),
  };
}

async function saveCandidatePool() {
  if (state.restoringPool) return;
  const candidates = selectedItems();
  if (!candidates.length) {
    await fetch(apiUrl("/api/candidate-pool/current"), { method: "DELETE" }).catch(() => {});
    return;
  }
  await postJson("/api/candidate-pool/current", candidatePoolPayload());
  track("candidate_pool_save", {
    candidateCount: candidates.length,
    budget: candidates.reduce((sum, item) => sum + candidatePrice(item), 0),
  });
  markSaved();
}

function scheduleCandidatePoolSave() {
  if (state.restoringPool) return;
  window.clearTimeout(state.poolSaveTimer);
  state.poolSaveTimer = window.setTimeout(() => {
    saveCandidatePool().catch(() => {});
  }, 450);
}

async function restoreCandidatePool() {
  try {
    const data = await getJson("/api/candidate-pool/current");
    const candidates = data.pool?.candidates || [];
    if (!candidates.length) return;
    state.restoringPool = true;
    clearSelectedCandidates();
    candidates.forEach(addSelectedCandidate);
    state.restoringPool = false;
    markSaved();
    showToast(`已恢复候选池：${candidates.length} 位达人`);
  } catch {
    state.restoringPool = false;
  }
}

function selectedItems() {
  return Array.from(state.selectedCandidates.values());
}

function candidateById(id) {
  return state.candidates.find((item) => candidateId(item) === id) || state.selectedCandidates.get(id);
}

function addSelectedCandidate(item) {
  const id = candidateId(item);
  if (!id) return;
  state.selected.add(id);
  state.selectedCandidates.set(id, item);
}

function removeSelectedCandidate(id) {
  state.selected.delete(id);
  state.selectedCandidates.delete(id);
}

function clearSelectedCandidates() {
  state.selected.clear();
  state.selectedCandidates.clear();
}

function syncSelectedCandidatesFromCurrentResults() {
  let changed = false;
  state.candidates.forEach((item) => {
    const id = candidateId(item);
    if (!id || !state.selected.has(id)) return;
    state.selectedCandidates.set(id, { ...(state.selectedCandidates.get(id) || {}), ...item });
    changed = true;
  });
  if (changed) scheduleCandidatePoolSave();
}

function selectedFieldNames() {
  return Array.from(state.selectedFields);
}

function selectedStrategies() {
  const checked = $$("input[name='strategyOption']:checked").map((input) => input.value);
  return checked.length ? checked : ["综合推荐"];
}

function filtersFromForm() {
  const keywordParts = $("#keywordInput").value.trim().split(/\s+/).filter(Boolean);
  const limit = Number.parseInt($("#resultLimitSelect")?.value || "50", 10) || 50;
  return {
    keyword: keywordParts[0] || "",
    strategies: selectedStrategies(),
    strategy: selectedStrategies().join("，"),
    expandedKeywords: keywordParts.slice(1).join("，"),
    fanRange: $("#fanRangeSelect").value,
    category: $("#categorySelect").value,
    subcategory: $("#subcategorySelect").value,
    match: "不限",
    cooperationType: $("#cooperationTypeSelect").value,
    priceRange: $("#priceRangeSelect").value,
    bloggerGender: $("#bloggerGenderSelect").value,
    fanGender: $("#fanGenderSelect").value,
    sort: $("#sortSelect").value,
    pageSize: 20,
    maxPages: Math.ceil(limit / 20),
    limit,
    batchIndex: state.batchIndex,
  };
}

function resultMatches(item, query) {
  const text = [
    item.nickname,
    item.name,
    item.redId,
    item.location,
    item.recommendationReason,
    item.qualitySignal,
    item.categoryText,
    item.primaryCategory,
  ].filter(Boolean).join(" ").toLowerCase();
  return text.includes(query.toLowerCase());
}

function visibleCandidates() {
  const query = state.resultSearchQuery.trim();
  return query ? state.candidates.filter((item) => resultMatches(item, query)) : state.candidates;
}

function markSaved() {
  state.lastSavedAt = new Date().toLocaleTimeString();
  renderTopStatus();
}

function setFilterCollapsed(collapsed) {
  state.filtersCollapsed = collapsed;
  $(".filter-panel")?.classList.toggle("is-collapsed", collapsed);
  const button = $("#toggleFilterPanel");
  if (button) {
    button.setAttribute("aria-expanded", String(!collapsed));
    button.setAttribute("aria-label", collapsed ? "展开检索条件" : "收起检索条件");
  }
}

function renderSearchMode() {
  const hasResults = state.candidates.length > 0;
  $("#filterForm")?.classList.toggle("has-results", hasResults);
  $("#filterForm")?.classList.toggle("is-result-mode", state.searchWithinResults);
  const toggle = $("#resultModeToggle");
  if (toggle) toggle.checked = state.searchWithinResults;
  const input = $("#keywordInput");
  if (input) {
    input.placeholder = state.searchWithinResults
      ? "在当前结果中输入昵称、账号或推荐理由"
      : "请输入关键词，比如网球 网球服";
  }
}

function searchCurrentResults() {
  if (!state.candidates.length) {
    state.searchWithinResults = false;
    renderSearchMode();
    showToast("请先完成一次达人检索");
    return;
  }
  state.resultSearchQuery = $("#keywordInput").value.trim();
  const matchedCount = visibleCandidates().length;
  $("#resultMeta").textContent = state.resultSearchQuery
    ? `当前结果筛选 · 匹配 ${formatNumber(matchedCount)} 位候选`
    : `当前结果筛选 · 共 ${formatNumber(state.candidates.length)} 位候选`;
  track("finder_result_filter", {
    queryLength: state.resultSearchQuery.length,
    matchedCount,
    total: state.candidates.length,
  });
  renderAll();
}

function switchScreen(screenId) {
  state.activeScreen = screenId;
  document.body.dataset.activeScreen = screenId;
  $$(".screen").forEach((screen) => {
    screen.classList.toggle("is-active", screen.id === screenId);
  });
  $$("[data-screen]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.screen === screenId);
  });
  track("page_view", { screen: screenId });
  window.dispatchEvent(new CustomEvent("xundao:screen", { detail: { screenId } }));
  if (screenId === "records") refreshRecords().catch((error) => showToast(error.message));
  if (screenId === "analytics") refreshAnalytics().catch((error) => {
    state.analyticsError = error.message;
    renderAnalytics();
  });
}

function normalizeCategories(categories) {
  return (categories || fallbackCategories).map((item) => {
    if (Array.isArray(item)) return { name: item[0], children: item[1] || [] };
    return { name: item.name, children: item.children || [] };
  });
}

function renderCategories() {
  $("#categorySelect").innerHTML = state.categories
    .map((item) => `<option value="${escapeHtml(item.name)}">${escapeHtml(item.name)}</option>`)
    .join("");
  $("#categorySelect").value = state.categories.some((item) => item.name === "全部") ? "全部" : state.categories[0]?.name || "";
  renderSubcategories();
}

function renderSubcategories() {
  const category = $("#categorySelect").value;
  const hit = state.categories.find((item) => item.name === category);
  const subcategories = hit?.children || [];
  $("#subcategorySelect").innerHTML = ["不限", ...subcategories]
    .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
    .join("");
}

function renderTopStatus() {
  const selected = state.selected.size;
  const queue = state.collectJob?.progress?.total || state.collectJob?.creators?.length || 0;
  setText("#selectedTopCount", String(selected));
  setText("#queueTopCount", String(queue));
  setText("#currentTaskText", state.currentTask);
  setText("#lastSavedText", state.lastSavedAt || "未保存");
}

function renderSummary() {
  const filters = filtersFromForm();
  state.currentTask = filters.keyword ? `${filters.keyword}达人检索` : "待输入关键词";
  renderTopStatus();
}

function emptyRow(message, detail = "", actionLabel = "") {
  return `
    <tr>
      <td colspan="10" class="empty-cell">
        <strong>${escapeHtml(message)}</strong>
        ${detail ? `<p>${escapeHtml(detail)}</p>` : ""}
        ${actionLabel ? `<button class="primary-action empty-action" data-empty-focus="keyword" type="button">${escapeHtml(actionLabel)}</button>` : ""}
      </td>
    </tr>
  `;
}

function bindEmptyActions() {
  $$("[data-empty-focus='keyword']").forEach((button) => {
    button.addEventListener("click", () => $("#keywordInput").focus());
  });
}

function tooltipNode() {
  let node = $("#reasonTooltip");
  if (!node) {
    node = document.createElement("div");
    node.id = "reasonTooltip";
    node.className = "reason-tooltip";
    document.body.appendChild(node);
  }
  return node;
}

function positionReasonTooltip(target) {
  const tooltip = tooltipNode();
  const rect = target.getBoundingClientRect();
  const margin = 10;
  const width = Math.min(420, window.innerWidth - margin * 2);
  tooltip.style.maxWidth = `${width}px`;
  const measured = tooltip.getBoundingClientRect();
  const left = Math.min(Math.max(rect.left, margin), window.innerWidth - measured.width - margin);
  const below = rect.bottom + 8;
  const top = below + measured.height > window.innerHeight - margin
    ? Math.max(rect.top - measured.height - 8, margin)
    : below;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function showReasonTooltip(target) {
  const reason = target.dataset.reason || "";
  if (!reason) return;
  const tooltip = tooltipNode();
  tooltip.textContent = reason;
  tooltip.classList.add("show");
  positionReasonTooltip(target);
}

function hideReasonTooltip() {
  $("#reasonTooltip")?.classList.remove("show");
}

function bindReasonTooltips() {
  $$(".reason-cell").forEach((cell) => {
    cell.addEventListener("mouseenter", () => showReasonTooltip(cell));
    cell.addEventListener("mouseleave", hideReasonTooltip);
    cell.addEventListener("focusin", () => showReasonTooltip(cell));
    cell.addEventListener("focusout", hideReasonTooltip);
  });
}

function renderRows() {
  const rows = visibleCandidates();
  if (state.searchState === "searching") {
    $("#candidateRows").innerHTML = emptyRow("正在检索达人", "通常需要一点时间，请稍候。");
    return;
  }
  if (state.searchState === "error") {
    $("#candidateRows").innerHTML = emptyRow("检索失败", "请先完成账号授权，或放宽筛选条件后重试。");
    return;
  }
  if (state.candidates.length === 0) {
    const first = state.searchState === "idle";
    $("#candidateRows").innerHTML = emptyRow(
      first ? "输入关键词后开始检索" : "当前条件没有匹配达人",
      first ? "建议先用较宽条件检索，再从结果表筛选候选。" : "建议放宽粉丝范围、取消细分类目或降低命中笔记要求。",
      first ? "输入关键词开始检索" : "",
    );
    bindEmptyActions();
    return;
  }
  if (rows.length === 0) {
    $("#candidateRows").innerHTML = emptyRow("当前结果中没有匹配项", "请调整筛选条件，或点击“换一批”。");
    return;
  }

  $("#candidateRows").innerHTML = rows
    .map((item) => {
      const id = candidateId(item);
      const checked = state.selected.has(id);
      const detailUrl = item.pgyLink || item.detailUrl || "";
      const reason = item.recommendationReason || item.qualitySignal || "待人工判断";
      return `
        <tr class="${checked ? "is-selected" : ""}">
          <td class="creator-cell">
            <input type="checkbox" class="row-check" aria-label="选择 ${escapeHtml(item.nickname || item.name)}" data-id="${escapeHtml(id)}" ${checked ? "checked" : ""} />
            <span class="creator-name">
              <strong>${escapeHtml(item.nickname || item.name || "-")}</strong>
              <span>${escapeHtml(item.location || id)}</span>
            </span>
          </td>
          <td>
            <span class="copy-row">${escapeHtml(item.redId || "-")}<button class="mini-btn copy-btn" data-copy="${escapeHtml(item.redId || "")}" type="button">复制</button></span>
          </td>
          <td class="number">${formatNumber(item.fans || item.fansNum)}</td>
          <td class="number">${totalInteractionText(item)}</td>
          <td class="number">${item.picturePrice ? formatCurrency(item.picturePrice) : "-"}</td>
          <td class="number">${item.videoPrice ? formatCurrency(item.videoPrice) : "-"}</td>
          <td class="number">${metricText(item.readMedian)}</td>
          <td class="number">${metricText(item.interactionMedian)}</td>
          <td class="reason-cell" tabindex="0" data-reason="${escapeHtml(reason)}"><span class="reason-text">${escapeHtml(reason)}</span></td>
          <td><button class="mini-btn detail-btn" data-url="${escapeHtml(detailUrl)}" type="button">主页</button></td>
        </tr>
      `;
    })
    .join("");

  $$(".row-check").forEach((input) => {
    input.addEventListener("change", () => {
      const item = candidateById(input.dataset.id);
      if (input.checked && item) addSelectedCandidate(item);
      else removeSelectedCandidate(input.dataset.id);
      if (item) {
        track(input.checked ? "creator_select" : "creator_unselect", {
          source: "result_row",
          batchIndex: state.batchIndex,
          fanBucket: fanBucket(item),
          category: item.primaryCategory || item.categoryText || "",
          hasPicturePrice: Boolean(item.picturePrice),
          hasVideoPrice: Boolean(item.videoPrice),
          selectedCount: state.selectedCandidates.size,
        });
      }
      renderAll();
      scheduleCandidatePoolSave();
    });
  });

  $$(".copy-btn").forEach((button) => {
    button.addEventListener("click", async () => {
      const value = button.dataset.copy || "";
      await navigator.clipboard?.writeText(value).catch(() => {});
      showToast(value ? `已复制小红书号：${value}` : "没有可复制的小红书号");
    });
  });

  $$(".detail-btn").forEach((button) => {
    button.addEventListener("click", () => {
      if (!button.dataset.url) return showToast("当前候选缺少达人主页链接");
      window.open(button.dataset.url, "_blank", "noopener,noreferrer");
    });
  });

  bindReasonTooltips();
}

function categoryMix(items) {
  const counts = new Map();
  for (const item of items) {
    const label = (item.primaryCategory || item.categoryText || "未分类").split("；")[0];
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([label, count]) => `${label} ${count}`)
    .join(" · ");
}

function renderPool() {
  const items = selectedItems();
  const selectedCount = items.length;
  const budget = items.reduce((sum, item) => sum + candidatePrice(item), 0);
  const averageFans = selectedCount
    ? Math.round(items.reduce((sum, item) => sum + numberValue(item.fans || item.fansNum), 0) / selectedCount)
    : 0;
  const averagePrice = selectedCount ? Math.round(budget / selectedCount) : 0;

  $("#selectedCountInline").textContent = String(selectedCount);
  $("#nextBatchBtn").disabled = state.searchState === "searching" || !filtersFromForm().keyword;
  $("#poolReadyCount").textContent = String(selectedCount);
  $("#poolBudget").textContent = formatCurrency(budget);
  $("#poolAverageFans").textContent = formatCompact(averageFans);
  $("#poolAveragePrice").textContent = formatCurrency(averagePrice);
  $("#poolMeta").textContent = selectedCount ? `${selectedCount} 位候选达人` : "等待选择达人";
  $("#poolCategoryMix").textContent = selectedCount ? categoryMix(items) : "暂无类目分布";
  $("#poolRisk").textContent = selectedCount
    ? budget ? `最低报价合计约 ${formatCurrency(budget)}，建议采集表现数据后再确认投放名单。` : "部分达人缺少公开报价，建议进入主页核对。"
    : "请选择达人后查看预算和风险提示。";
  $("#finder")?.classList.toggle("has-selection", selectedCount > 0);
  $(".candidate-pool")?.classList.toggle("is-empty", selectedCount === 0);
  $("#addToCollector").disabled = selectedCount === 0;
  $("#pushToCollector").disabled = selectedCount === 0;
  const toggleAll = $("#toggleAll");
  if (toggleAll) {
    toggleAll.checked = selectedCount > 0 && selectedCount === state.candidates.length;
    toggleAll.indeterminate = selectedCount > 0 && selectedCount < state.candidates.length;
  }
  const selectAllRows = $("#selectAllRows");
  if (selectAllRows) {
    const visible = visibleCandidates();
    const selectedVisibleCount = visible.filter((item) => state.selected.has(candidateId(item))).length;
    selectAllRows.checked = visible.length > 0 && selectedVisibleCount === visible.length;
    selectAllRows.indeterminate = selectedVisibleCount > 0 && selectedVisibleCount < visible.length;
    selectAllRows.disabled = state.searchState === "searching" || visible.length === 0;
  }

  $("#poolList").innerHTML = selectedCount
    ? items
        .map((item) => `
          <div class="pool-item">
            <div>
              <strong>${escapeHtml(item.nickname || item.name || "-")}</strong>
              <span>${formatCompact(item.fans || item.fansNum)} 粉丝 · ${candidatePrice(item) ? `${formatCurrency(candidatePrice(item))} 起` : "报价待核"}</span>
            </div>
            <button class="remove-btn" data-remove="${escapeHtml(candidateId(item))}" type="button" aria-label="移除 ${escapeHtml(item.nickname || item.name)}">×</button>
          </div>
        `)
        .join("")
    : `<div class="empty-state">从结果表勾选达人后，这里会形成候选池。</div>`;

  $$(".remove-btn").forEach((button) => {
    button.addEventListener("click", () => {
      track("creator_unselect", {
        source: "candidate_pool",
        selectedCount: Math.max(state.selectedCandidates.size - 1, 0),
      });
      removeSelectedCandidate(button.dataset.remove);
      renderAll();
      scheduleCandidatePoolSave();
    });
  });
}

function renderFieldLibrary() {
  const groups = FIELD_LIBRARY.reduce((map, field) => {
    if (!map.has(field.group)) map.set(field.group, []);
    map.get(field.group).push(field);
    return map;
  }, new Map());
  $("#fieldLibrary").innerHTML = Array.from(groups.entries())
    .map(([group, fields]) => `
      <div class="field-group">
        <span>${escapeHtml(group)}</span>
        <div>
          ${fields.map((field) => `
            <label class="field-check">
              <input type="checkbox" name="collectField" value="${escapeHtml(field.name)}" ${state.selectedFields.has(field.name) ? "checked" : ""} ${state.templateId === "medela" ? "disabled" : ""} />
              ${escapeHtml(field.name)}
            </label>
          `).join("")}
        </div>
      </div>
    `)
    .join("");
  renderFieldReview();
}

function currentTemplate() {
  return templates.find((item) => item.id === state.templateId) || templates[0] || FALLBACK_TEMPLATES[0];
}

function applyTemplate(templateId, { silent = false, force = false } = {}) {
  const next = templates.find((item) => item.id === templateId) || templates[0] || FALLBACK_TEMPLATES[0];
  const activeTotal = numberValue(state.collectJob?.progress?.total || state.collectJob?.creators?.length);
  if (!force && activeTotal && state.collectJob?.templateId && state.collectJob.templateId !== next.id) {
    $$("input[name='templateId']").forEach((input) => {
      input.checked = input.value === state.collectJob.templateId;
    });
    if (!silent) showToast("当前任务已锁定模板；如需切换，请先重置当前任务");
    return;
  }
  state.templateId = next.id;
  FIELD_LIBRARY = next.fields || [];
  defaultFields = FIELD_LIBRARY.filter((field) => field.default).map((field) => field.name);
  state.selectedFields = new Set(defaultFields);
  $$("input[name='templateId']").forEach((input) => {
    input.checked = input.value === next.id;
  });
  setText("#templateHint", next.description || "");
  setText("#selectedTemplateName", next.label || "");
  if ($("#selectDefaultFields")) $("#selectDefaultFields").disabled = next.id === "medela";
  renderFieldLibrary();
  bindFieldEvents();
  if (!silent) {
    track("collect_template_change", { templateId: next.id, fieldCount: defaultFields.length });
    showToast(`已切换到${next.label}`);
  }
}

function syncSelectedFieldsFromDom() {
  const checked = $$("input[name='collectField']:checked").map((input) => input.value);
  if (!checked.length) {
    state.selectedFields = new Set(defaultFields);
    renderFieldLibrary();
    bindFieldEvents();
    track("collect_fields_change", { fieldCount: state.selectedFields.size, resetToDefault: true });
    return;
  }
  state.selectedFields = new Set(checked);
  track("collect_fields_change", { fieldCount: state.selectedFields.size, resetToDefault: false });
  renderFieldReview();
}

function renderFieldReview() {
  setText(
    "#fieldReviewText",
    state.templateId === "medela"
      ? `美德乐模板固定 ${state.selectedFields.size} 个字段，含公式与 DeepSeek 推荐理由。`
      : state.templateId === "dynamic"
        ? `上传后自动解析 Excel 字段；当前显示 ${state.selectedFields.size} 个可用字段，可微调。`
        : `当前选择 ${state.selectedFields.size} 个字段，可按任务增减。`,
  );
}

function renderSavedTemplates() {
  const container = $("#savedTemplateList");
  if (!container) return;
  container.innerHTML = state.savedTemplates.length
    ? state.savedTemplates.map((template) => `
        <button class="saved-template-chip" type="button" data-saved-template="${escapeHtml(template.id)}">
          ${escapeHtml(template.name)}
        </button>
      `).join("")
    : `<span class="saved-template-empty">暂无固化模板；当前字段可随时保存。</span>`;
  $$("[data-saved-template]").forEach((button) => {
    button.addEventListener("click", () => {
      const saved = state.savedTemplates.find((item) => item.id === button.dataset.savedTemplate);
      if (!saved) return;
      applyTemplate(saved.baseTemplateId || "dynamic", { silent: true, force: true });
      const fields = saved.definition?.fieldIds || [];
      if (fields.length) state.selectedFields = new Set(fields);
      renderFieldLibrary();
      bindFieldEvents();
      showToast(`已应用固化模板：${saved.name}，可继续增删字段`);
    });
  });
}

async function loadSavedTemplates() {
  const data = await getJson("/api/collection-templates");
  state.savedTemplates = Array.isArray(data.templates) ? data.templates : [];
  renderSavedTemplates();
}

async function saveCurrentFieldTemplate() {
  const name = window.prompt("请输入固化模板名称");
  if (!name?.trim()) return;
  const data = await postJson("/api/collection-templates", {
    name: name.trim(),
    baseTemplateId: state.templateId,
    fieldIds: selectedFieldNames(),
  });
  if (data.template) {
    state.savedTemplates = [
      data.template,
      ...state.savedTemplates.filter((item) => item.id !== data.template.id),
    ];
    renderSavedTemplates();
    showToast(`已保存固化模板：${data.template.name}`);
  }
}

function renderImportState() {
  const selectedCount = selectedItems().length;
  const total = numberValue(state.collectJob?.progress?.total || state.collectJob?.creators?.length);
  const sourceType = state.collectJob?.sourceType || "";
  if (total) {
    $("#finderImportState").innerHTML = `
      <strong>${sourceType === "excel" ? "已有 Excel 任务" : `已导入 ${formatNumber(total)} 位达人`}</strong>
      <p>${sourceType === "excel" ? "当前任务来自 Excel，如需改用候选池请重新导入。" : "确认字段后可直接开始采集。"}</p>
    `;
  } else {
    $("#finderImportState").innerHTML = selectedCount
    ? `
      <strong>已选择 ${formatNumber(selectedCount)} 位达人</strong>
      <p>导入后将生成采集任务，字段按下方选择执行。</p>
    `
    : `
      <strong>尚未选择达人</strong>
      <p>点击后会回到找达人页，先勾选候选名单。</p>
    `;
  }
  if ($("#excelImportState")) {
    $("#excelImportState").innerHTML = total && sourceType === "excel"
      ? `
        <strong>已识别 ${formatNumber(total)} 位达人</strong>
        <p>请核对字段样本库，确认后开始采集。</p>
      `
      : `
        <strong>等待上传 Excel</strong>
        <p>识别后请确认字段是否准确，再开始采集。</p>
      `;
  }
}

function renderLogs(logs = []) {
  $("#lastUpdate").textContent = logs.length ? `更新于 ${new Date(logs.at(-1).ts).toLocaleTimeString()}` : "暂无更新";
  if (!logs.length) {
    $("#logs").innerHTML = `<div class="log muted">等待任务开始</div>`;
    return;
  }
  $("#logs").innerHTML = logs
    .slice()
    .reverse()
    .map((item) => `<div class="log"><span class="muted">${new Date(item.ts).toLocaleTimeString()}</span>${escapeHtml(item.message)}</div>`)
    .join("");
}

const CONTRACT_OPTION_VALUES = Object.freeze({
  scene: { "合作笔记": "cooperation", "日常笔记": "daily" },
  contentType: { "图文+视频": "all", "视频": "video", "图文": "image" },
  window: { "近90日": "90d", "近30日": "30d" },
  traffic: { "全流量": "all", "仅自然流量": "natural" },
  view: { "按规模": "scale", "按成本": "cost" },
});

function scopeGroupText(group) {
  const scene = { cooperation: "合作笔记", daily: "日常笔记", all: "全部笔记", creator: "达人主页" }[group.scene] || group.scene;
  const contentType = { all: "图文+视频", video: "视频", image: "图文" }[group.contentType] || group.contentType;
  const windowText = { "90d": "近90日", "30d": "近30日", recent16: "近16篇", lifetime: "当前" }[group.window] || group.window;
  const traffic = { all: "全流量", natural: "仅自然流量", original: "原始流量" }[group.traffic] || group.traffic;
  return `${scene}，${contentType}，${windowText}，${traffic}`;
}

async function confirmCurrentContract() {
  const job = state.collectJob;
  if (!job?.id || job.templateId !== "dynamic") return;
  const button = $("#confirmContract");
  button.disabled = true;
  button.textContent = "正在确认";
  try {
    const defaults = {};
    $$("#contractQuestions select[data-dimension]").forEach((select) => {
      const dimension = select.dataset.dimension;
      const value = CONTRACT_OPTION_VALUES[dimension]?.[select.value] || "";
      if (value) defaults[`${dimension}Default`] = value;
    });
    let next = job;
    if (Object.keys(defaults).length) {
      next = (await postJson(`/api/jobs/${encodeURIComponent(job.id)}/contract/resolve`, { defaults })).job;
    }
    if (next.taskContract?.unresolvedCount === 0 && next.taskState !== "CONFIRMED") {
      next = (await postJson(`/api/jobs/${encodeURIComponent(job.id)}/contract/confirm`)).job;
    }
    state.collectJob = next;
    renderAll();
    showToast(next.taskState === "CONFIRMED" ? "取数口径已确认，可以开始采集" : "仍有字段需要继续澄清");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = "确认取数口径";
  }
}

function renderContractReview() {
  const panel = $("#contractReview");
  const job = state.collectJob;
  const contract = job?.taskContract;
  const visible = job?.templateId === "dynamic" && contract;
  panel.hidden = !visible;
  if (!visible) return;
  const clarification = contract.clarification || {};
  const questions = clarification.questions || [];
  setText("#contractSummary", clarification.summary || "请确认系统理解的取数口径。");
  setText("#contractState", taskStateText(job.taskState));
  $("#contractState").className = `status-pill ${job.taskState === "CONFIRMED" ? "ready" : questions.length ? "running" : "muted"}`;
  $("#contractGroups").innerHTML = (contract.scopeGroups || [])
    .filter((group) => group.scene !== "creator")
    .map((group) => `<p>${escapeHtml(scopeGroupText(group))}，${group.contracts?.length || 0} 个字段</p>`)
    .join("") || `<p>暂未形成可执行的数据口径。</p>`;
  $("#contractQuestions").innerHTML = questions.map((question) => `
    <label class="contract-question">
      <span>${escapeHtml(question.prompt)}</span>
      <select data-dimension="${escapeHtml(question.dimension)}">
        ${(question.options || []).map((option) => `
          <option ${option === question.recommended ? "selected" : ""}>${escapeHtml(option)}</option>
        `).join("")}
      </select>
    </label>
  `).join("");
  const button = $("#confirmContract");
  button.hidden = job.taskState === "CONFIRMED";
  button.textContent = questions.length ? "应用这些口径并确认" : "确认上述取数口径";
  button.onclick = confirmCurrentContract;
}

function renderTasks() {
  const job = state.collectJob;
  const creators = job?.creators || [];
  const total = numberValue(job?.progress?.total || creators.length);
  const done = numberValue(job?.progress?.done);
  const pending = Math.max(total - done, 0);
  const logs = job?.logs || [];
  $("#collector")?.classList.toggle("has-job", !!job && total > 0);
  $("#collector")?.classList.toggle("has-runtime-log", !!job && job.status !== "uploaded" && logs.length > 0);

  $("#jobTotal").textContent = String(total);
  $("#jobDone").textContent = String(done);
  $("#jobPending").textContent = String(pending);
  $("#jobStatus").textContent = job
    ? job.templateId === "dynamic" && job.taskState !== "CONFIRMED"
      ? taskStateText(job.taskState)
      : statusText(job.status)
    : "等待导入";
  $("#collectorTaskMeta").textContent = job
    ? `${done}/${total} · ${job.templateLabel || (job.templateId === "medela" ? "美德乐模板" : "富士模板")} · ${statusText(job.status)}`
    : "等待导入";
  $("#startCollect").disabled = !job
    || job.status === "running"
    || total === 0
    || (job.templateId === "dynamic" && job.taskState !== "CONFIRMED");
  $("#downloadBtn").classList.toggle("disabled", job?.status !== "done");
  $("#downloadBtn").href = job?.status === "done" ? apiUrl(`/api/download/${encodeURIComponent(job.id)}`) : "#";

  if (!job || creators.length === 0) {
    $("#taskList").innerHTML = `
      <div class="task is-empty">
        <div>
          <strong>先导入一批达人</strong>
          <p>从找达人候选池导入会保留筛选结果；也可以上传含达人主页链接的 Excel。</p>
        </div>
        <span class="status-pill muted">待导入</span>
        <div class="progress"><i></i></div>
      </div>
    `;
    renderLogs([]);
    renderContractReview();
    renderTopStatus();
    return;
  }

  $("#taskList").innerHTML = creators
    .map((item, index) => {
      const complete = index < done || job.status === "done";
      const running = job.status === "running" && index === done;
      const progress = complete ? 100 : running ? 45 : 0;
      const label = complete ? "已完成" : running ? "采集中" : "排队中";
      const pill = complete ? "ready" : running ? "running" : "muted";
      return `
        <div class="task">
          <div>
            <strong>${escapeHtml(item.nickname || item.redId || item.creatorId || "未命名达人")}</strong>
            <p>${escapeHtml(item.redId || item.creatorId || "")}</p>
          </div>
          <span class="status-pill ${pill}">${label}</span>
          <div class="progress"><i style="--progress:${progress}%"></i></div>
        </div>
      `;
    })
    .join("");

  renderLogs(logs);
  renderContractReview();
  renderTopStatus();
}

function renderRecords() {
  const recordsRows = $("#recordsRows");
  if (!recordsRows) return;
  if (!state.records.length) {
    recordsRows.innerHTML = `<tr><td colspan="6" class="empty-cell">暂无任务记录</td></tr>`;
    return;
  }
  recordsRows.innerHTML = state.records
    .map((job) => {
      const count = job.progress?.total || job.creators?.length || 0;
      const source = `${job.sourceType === "finder" ? "找达人候选池" : "Excel 上传"} · ${job.templateLabel || (job.templateId === "medela" ? "美德乐模板" : "富士模板")}`;
      const download = job.status === "done"
        ? `<a class="mini-btn" href="${apiUrl(`/api/download/${encodeURIComponent(job.id)}`)}">下载</a>`
        : `<span class="subtle">未生成</span>`;
      return `
        <tr>
          <td>${escapeHtml(job.originalName || job.id)}</td>
          <td>${source}</td>
          <td class="number">${formatNumber(count)}</td>
          <td><span class="status-pill ${statusClass(job.status)}">${statusText(job.status)}</span></td>
          <td>${job.createdAt ? new Date(job.createdAt).toLocaleString() : "-"}</td>
          <td>${download}</td>
        </tr>
      `;
    })
    .join("");
}

function renderAnalyticsLocked(message = "请输入数据表现密钥后查看。") {
  const access = state.analyticsAccess || {};
  if (access.visibleTo || access.hiddenFrom || access.policy) {
    setText("#analyticsAccessText", `${(access.visibleTo || ["管理员", "投放负责人", "数据分析"]).join("、")}可以查看；${(access.hiddenFrom || ["普通媒介执行同学", "外部协作者"]).join("、")}默认不展示。${access.policy || ""}`);
  }
  setText("#analyticsSearchRate", "锁定");
  setText("#analyticsSearchMeta", message);
  setText("#analyticsSelectionRate", "-");
  setText("#analyticsSelectionMeta", "无权限");
  setText("#analyticsCollectRate", "-");
  setText("#analyticsCollectMeta", "无权限");
  setText("#analyticsDownloadRate", "-");
  setText("#analyticsDownloadMeta", "无权限");
  $("#analyticsFunnel").innerHTML = `<div class="empty-state">当前账号无权查看数据表现。</div>`;
  $("#analyticsKeywordRows").innerHTML = `<tr><td colspan="4" class="empty-cell">${escapeHtml(message)}</td></tr>`;
  $("#analyticsStability").innerHTML = `<div><span>访问控制</span><strong>需要密钥</strong></div>`;
  $("#analyticsAgent").innerHTML = `<div><span>访问控制</span><strong>需要密钥</strong></div>`;
  $("#analyticsRecentEvents").innerHTML = `<div class="empty-state">请输入管理员提供的数据表现密钥。</div>`;
  $("#analyticsTokenBox")?.classList.remove("is-hidden");
}

function renderAnalytics() {
  const data = state.analytics;
  if (state.analyticsError) {
    renderAnalyticsLocked(state.analyticsError);
    return;
  }
  if (!data) {
    renderAnalyticsLocked("暂无数据，点击刷新。");
    return;
  }
  const funnel = data.funnel || {};
  const stability = data.stability || {};
  const agent = data.agent || {};
  const access = data.access || {};
  $("#analyticsTokenBox")?.classList.toggle("is-hidden", data.accessMode === "open-local" || data.viewer !== "未授权");
  setText("#analyticsAccessText", `${(access.visibleTo || []).join("、")}可以查看；${(access.hiddenFrom || []).join("、")}默认不展示。${access.policy || ""}`);
  setText("#analyticsSearchRate", percentText(funnel.searchSuccessRate));
  setText("#analyticsSearchMeta", `${formatNumber(funnel.searchSubmits)} 次检索 · ${formatNumber(funnel.searchSuccesses)} 次成功`);
  setText("#analyticsSelectionRate", percentText(funnel.selectionRate));
  setText("#analyticsSelectionMeta", `${formatNumber(funnel.selectedCreators)} 次勾选 · ${formatNumber(funnel.resultCandidates)} 位返回`);
  setText("#analyticsCollectRate", percentText(stability.collectSuccessRate));
  setText("#analyticsCollectMeta", `${formatNumber(funnel.collectDone)} 完成 · ${formatNumber(funnel.collectFailed)} 失败`);
  setText("#analyticsDownloadRate", percentText(funnel.downloadRate));
  setText("#analyticsDownloadMeta", `${formatNumber(funnel.downloads)} 次下载`);

  const steps = [
    ["运行检索", funnel.searchSubmits, "用户点击检索"],
    ["检索成功", funnel.searchSuccesses, `${percentText(funnel.searchSuccessRate)} 成功率`],
    ["返回达人", funnel.resultCandidates, "平台返回候选"],
    ["勾选入池", funnel.selectedCreators, `${percentText(funnel.selectionRate)} 入池率`],
    ["进入采集", funnel.importedCreators, `${formatNumber(funnel.collectJobs)} 个任务`],
    ["下载 Excel", funnel.downloads, `${percentText(funnel.downloadRate)} 下载率`],
  ];
  $("#analyticsFunnel").innerHTML = steps.map(([label, value, detail]) => `
    <div class="analytics-step">
      <span>${escapeHtml(label)}</span>
      <strong>${formatNumber(value)}</strong>
      <p>${escapeHtml(detail)}</p>
    </div>
  `).join("");

  $("#analyticsKeywordRows").innerHTML = data.topKeywords?.length
    ? data.topKeywords.map((item) => `
      <tr>
        <td>${escapeHtml(item.label)}</td>
        <td class="number">${formatNumber(item.searches || item.count)}</td>
        <td class="number">${formatNumber(item.successes || 0)}</td>
        <td class="number">${formatNumber(item.returned || 0)}</td>
      </tr>
    `).join("")
    : `<tr><td colspan="4" class="empty-cell">暂无关键词数据</td></tr>`;

  const stabilityItems = [
    ["平均检索耗时", durationText(stability.avgSearchMs)],
    ["平均采集耗时", durationText(stability.avgCollectMs)],
    ["字段缺失", formatNumber(stability.fieldMissing)],
    ["连接需处理", formatNumber(stability.loginExpired)],
    ["接口超时", formatNumber(stability.apiTimeout)],
    ["失败事件", formatNumber(stability.failedEvents)],
  ];
  $("#analyticsStability").innerHTML = stabilityItems.map(([label, value]) => `
    <div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>
  `).join("");

  const providerText = (agent.providers || [])
    .map((item) => `${item.label} ${item.completed || 0}/${(item.completed || 0) + (item.failed || 0)}`)
    .join(" · ") || "尚无调用";
  const agentItems = [
    ["澄清解决率", percentText(agent.clarificationResolutionRate)],
    ["字段合同确认", formatNumber(agent.taskConfirmed)],
    ["作用域完成", formatNumber(agent.scopeGroupCompleted)],
    ["模型成功率", percentText(agent.modelSuccessRate)],
    ["模型调用", `${formatNumber(agent.modelCallCompleted)} 成功 / ${formatNumber(agent.modelCallFailed)} 失败`],
    ["模型提供方", providerText],
    ["确定性校验失败", formatNumber(agent.validationFailed)],
  ];
  $("#analyticsAgent").innerHTML = agentItems.map(([label, value]) => `
    <div><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>
  `).join("");

  $("#analyticsRecentEvents").innerHTML = data.recentEvents?.length
    ? data.recentEvents.map((event) => `
      <div class="analytics-event">
        <strong>${escapeHtml(event.eventName)}</strong>
        <code>${escapeHtml(compactProperties(event.properties))}</code>
        <span>${event.createdAt ? new Date(event.createdAt).toLocaleString() : ""}</span>
      </div>
    `).join("")
    : `<div class="empty-state">暂无事件</div>`;
}

function renderAll() {
  renderSummary();
  renderRows();
  renderPool();
  renderSearchMode();
  renderImportState();
  renderFieldReview();
  renderTasks();
  renderRecords();
  renderAnalytics();
}

async function refreshStatus() {
  try {
    const status = await getJson("/api/status");
    const connected = status.loginState === "connected";
    setConnectionState({ connected, error: false, text: connected ? "已连接" : "未连接" });
  } catch {
    setConnectionState({ connected: false, error: true, text: "服务不可用" });
  }
}

async function refreshRecords() {
  const data = await getJson("/api/jobs");
  state.records = data.jobs || [];
  renderRecords();
}

async function refreshAnalytics() {
  const days = $("#analyticsDays")?.value || "14";
  const response = await fetch(apiUrl(`/api/admin/analytics?days=${encodeURIComponent(days)}`));
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    state.analytics = null;
    state.analyticsAccess = data.access || null;
    state.analyticsError = data.error || data.access?.policy || "无权查看数据表现";
    renderAnalytics();
    return;
  }
  state.analytics = data;
  state.analyticsAccess = data.access || null;
  state.analyticsError = "";
  renderAnalytics();
}

async function runSearch() {
  if (state.searchWithinResults) {
    searchCurrentResults();
    return;
  }
  state.batchIndex = 0;
  clearSelectedCandidates();
  saveCandidatePool().catch(() => {});
  await performSearch();
}

async function performSearch() {
  const filters = filtersFromForm();
  if (!filters.keyword) {
    state.searchState = "idle";
    $("#resultMeta").textContent = "请输入关键词后再检索";
    renderAll();
    showToast("请输入关键词，比如网球 网球服");
    $("#keywordInput").focus();
    return;
  }
  track("finder_search_submit", {
    keyword: filters.keyword,
    expandedKeywordCount: filters.expandedKeywords ? filters.expandedKeywords.split("，").filter(Boolean).length : 0,
    strategyCount: filters.strategies.length,
    strategy: filters.strategy,
    fanRange: filters.fanRange,
    category: filters.category,
    subcategory: filters.subcategory,
    cooperationType: filters.cooperationType,
    priceRange: filters.priceRange,
    bloggerGender: filters.bloggerGender,
    fanGender: filters.fanGender,
    sort: filters.sort,
    limit: filters.limit,
    batchIndex: filters.batchIndex,
  });
  const submit = $("#searchBtn");
  const nextButton = $("#nextBatchBtn");
  const requestId = state.searchRequestId + 1;
  state.searchRequestId = requestId;
  state.searchState = "searching";
  state.candidates = [];
  state.resultSearchQuery = "";
  state.lastSearchInput = $("#keywordInput").value.trim();
  submit.disabled = true;
  if (nextButton) nextButton.disabled = true;
  submit.classList.add("is-loading");
  submit.setAttribute("aria-label", "检索中");
  $("#resultMeta").textContent = "正在检索，请稍候";
  renderAll();
  try {
    const data = await postJson("/api/finder/search", { filters });
    if (requestId !== state.searchRequestId) return;
    state.candidates = (data.candidates || []).map((item) => ({
      ...item,
      totalInteractionStatus: item.totalInteraction ? "success" : "loading",
    }));
    syncSelectedCandidatesFromCurrentResults();
    state.searchState = state.candidates.length ? "done" : "empty";
    $("#resultMeta").textContent = `第 ${state.batchIndex + 1} 批 · 返回 ${state.candidates.length} 位候选 · 平台总量 ${formatNumber(data.total || state.candidates.length)}`;
    setConnectionState({ connected: true, error: false, text: "已连接" });
    setFilterCollapsed(true);
    markSaved();
    showToast(`检索完成：返回 ${state.candidates.length} 位候选达人`);
    hydrateTotalInteractions(requestId);
  } catch (error) {
    if (requestId !== state.searchRequestId) return;
    state.searchState = "error";
    $("#resultMeta").textContent = `检索失败：${error.message}`;
    setConnectionState({ connected: false, error: true, text: "需重新连接" });
    track("finder_search_client_failed", {
      keyword: filters.keyword,
      batchIndex: filters.batchIndex,
      limit: filters.limit,
      message: String(error.message || "").slice(0, 120),
    });
    showToast(`检索失败：${error.message}`);
  } finally {
    submit.disabled = false;
    if (nextButton) nextButton.disabled = state.searchState === "searching" || !filters.keyword;
    submit.classList.remove("is-loading");
    submit.setAttribute("aria-label", "运行检索");
    renderAll();
  }
}

async function hydrateTotalInteractions(requestId) {
  const targets = state.candidates.filter((item) => !numberValue(item.totalInteraction));
  if (!targets.length) return;
  const batchSize = 4;
  for (let index = 0; index < targets.length; index += batchSize) {
    if (requestId !== state.searchRequestId) return;
    const batch = targets.slice(index, index + batchSize);
    try {
      const data = await postJson("/api/finder/enrich-interactions", { candidates: batch });
      if (requestId !== state.searchRequestId) return;
      const byId = new Map((data.candidates || []).map((item) => [candidateId(item), item]));
      state.candidates = state.candidates.map((item) => {
        const enriched = byId.get(candidateId(item));
        return enriched ? { ...item, ...enriched } : item;
      });
      syncSelectedCandidatesFromCurrentResults();
      renderAll();
    } catch {
      if (requestId !== state.searchRequestId) return;
      const failedIds = new Set(batch.map(candidateId));
      state.candidates = state.candidates.map((item) => {
        if (!failedIds.has(candidateId(item)) || numberValue(item.totalInteraction)) return item;
        return { ...item, totalInteractionStatus: "missing" };
      });
      renderAll();
    }
  }
}

async function nextBatch() {
  if (state.searchState === "searching") return;
  const filters = filtersFromForm();
  if (!filters.keyword) {
    showToast("请输入关键词后再换一批");
    $("#keywordInput").focus();
    return;
  }
  state.searchWithinResults = false;
  state.resultSearchQuery = "";
  $("#keywordInput").value = state.lastSearchInput || $("#keywordInput").value;
  track("finder_next_batch", {
    keyword: filters.keyword,
    nextBatchIndex: state.batchIndex + 1,
    limit: filters.limit,
    selectedKept: state.selectedCandidates.size,
  });
  state.batchIndex += 1;
  await performSearch();
}

async function createCollectJobFromSelection(options = {}) {
  const candidates = selectedItems();
  if (!candidates.length) {
    showToast("请先选择候选达人");
    return;
  }
  if (state.templateId !== "fuji") {
    applyTemplate("fuji", { silent: true, force: true });
    showToast("候选池导出使用富士模板；美德乐模板请上传项目执行表");
  }
  const button = options.button;
  if (button) button.disabled = true;
  track("candidate_pool_import_click", {
    candidateCount: candidates.length,
    fieldCount: selectedFieldNames().length,
    switchToCollector: Boolean(options.switchToCollector),
  });
  try {
    const data = await postJson("/api/finder/create-collect-job", {
      name: `${filtersFromForm().keyword || "未命名"}候选池`,
      candidates,
      selectedFields: selectedFieldNames(),
    });
    state.collectJobId = data.jobId;
    state.collectJob = data.job;
    state.currentTask = `${filtersFromForm().keyword || "未命名"}候选池采集`;
    $("#fieldLibraryPanel")?.setAttribute("open", "");
    markSaved();
    await refreshRecords().catch(() => {});
    renderAll();
    showToast(`已导入候选池：${data.count} 位达人`);
    if (options.switchToCollector) switchScreen("collector");
  } catch (error) {
    track("candidate_pool_import_failed", {
      candidateCount: candidates.length,
      message: String(error.message || "").slice(0, 120),
    });
    showToast(`加入队列失败：${error.message}`);
  } finally {
    if (button) button.disabled = false;
  }
}

async function handleCandidatePoolImport(event) {
  const total = numberValue(state.collectJob?.progress?.total || state.collectJob?.creators?.length);
  if (total) {
    switchScreen("collector");
    $("#fieldLibraryPanel")?.setAttribute("open", "");
    $("#startCollect").focus();
    showToast("候选池已导入，确认字段后可开始采集");
    return;
  }
  if (!selectedItems().length) {
    switchScreen("finder");
    showToast(state.candidates.length ? "请先在达人结果中勾选候选达人" : "请先检索并勾选候选达人");
    if (!state.candidates.length) $("#keywordInput").focus();
    return;
  }
  await createCollectJobFromSelection({ button: event.currentTarget });
  switchScreen("collector");
  $("#startCollect").focus();
}

async function refreshJob() {
  if (!state.collectJobId) return;
  const job = await getJson(`/api/jobs/${encodeURIComponent(state.collectJobId)}`);
  state.collectJob = job;
  if (job.templateId && job.templateId !== state.templateId) {
    applyTemplate(job.templateId, { silent: true, force: true });
  }
  renderTasks();
  if (job.status === "done" || job.status === "failed") {
    stopPolling();
    await refreshRecords().catch(() => {});
  }
}

function startPolling() {
  stopPolling();
  state.pollTimer = window.setInterval(() => {
    refreshJob().catch((error) => {
      showToast(error.message);
      stopPolling();
    });
  }, 1400);
}

function stopPolling() {
  if (state.pollTimer) window.clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function uploadExcel() {
  const file = $("#fileInput").files[0];
  if (!file) {
    showToast("请先选择 Excel 文件");
    return;
  }
  const form = new FormData();
  form.append("file", file);
  form.append("templateId", state.templateId);
  form.append("selectedFields", JSON.stringify(selectedFieldNames()));
  $("#uploadBtn").disabled = true;
  $("#uploadBtn").textContent = "识别中";
  track("excel_upload_submit", {
    fieldCount: selectedFieldNames().length,
    templateId: state.templateId,
    filenameLength: file.name.length,
    size: file.size,
  });
  try {
    const response = await fetch(apiUrl("/api/upload"), { method: "POST", body: form });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "上传失败");
    state.collectJobId = data.jobId;
    state.collectJob = data.job || {
      id: data.jobId,
      status: "uploaded",
      sourceType: "excel",
      templateId: state.templateId,
      templateLabel: currentTemplate().label,
      originalName: file.name,
      progress: { done: 0, total: data.count },
      creators: data.creators || [],
      selectedFields: selectedFieldNames(),
      logs: [{ ts: new Date().toISOString(), message: `已识别 ${data.count} 个达人主页链接` }],
    };
    applyTemplate(state.collectJob.templateId || state.templateId, { silent: true, force: true });
    if (state.collectJob.selectedFields?.length) {
      state.selectedFields = new Set(state.collectJob.selectedFields);
      renderFieldLibrary();
      bindFieldEvents();
    }
    state.currentTask = `${file.name} 表现采集`;
    $("#fieldLibraryPanel")?.setAttribute("open", "");
    markSaved();
    await refreshRecords().catch(() => {});
    renderAll();
    track("excel_upload_client_success", {
      jobId: data.jobId,
      count: data.count,
      fieldCount: selectedFieldNames().length,
      templateId: state.collectJob.templateId || state.templateId,
    }, { jobId: data.jobId, entityType: "job", entityId: data.jobId });
    showToast(
      state.collectJob.templateId === "dynamic" && state.collectJob.taskState !== "CONFIRMED"
        ? `Excel 已识别：${data.count} 位达人，请确认 AI 对取数口径的理解`
        : `Excel 已识别：${data.count} 位达人，请确认字段后开始采集`,
    );
  } catch (error) {
    track("excel_upload_failed", { message: String(error.message || "").slice(0, 120) });
    showToast(error.message);
  } finally {
    $("#uploadBtn").disabled = false;
    $("#uploadBtn").textContent = "识别 Excel";
  }
}

async function openLogin() {
  for (const button of [$("#loginBtn"), $("#loginBtnTop")].filter(Boolean)) button.disabled = true;
  track("pgy_login_open_click");
  try {
    await postJson("/api/login");
    setConnectionState({ connected: true, error: false, text: "窗口已打开" });
    showToast("登录窗口已打开，完成登录后即可检索或采集");
  } catch (error) {
    setConnectionState({ connected: false, error: true, text: "连接失败" });
    track("pgy_login_open_failed", { message: String(error.message || "").slice(0, 120) });
    showToast(`连接失败：${error.message}`);
  } finally {
    for (const button of [$("#loginBtn"), $("#loginBtnTop")].filter(Boolean)) button.disabled = false;
  }
}

async function startCollect() {
  if (!state.collectJobId) {
    showToast("请先加入采集队列或上传 Excel");
    return;
  }
  $("#startCollect").disabled = true;
  track("collect_start_clicked", {
    jobId: state.collectJobId,
    fieldCount: selectedFieldNames().length,
    total: state.collectJob?.progress?.total || state.collectJob?.creators?.length || 0,
    sourceType: state.collectJob?.sourceType || "",
    templateId: state.collectJob?.templateId || state.templateId,
  }, { jobId: state.collectJobId, entityType: "job", entityId: state.collectJobId });
  try {
    await postJson("/api/collect", { jobId: state.collectJobId, selectedFields: selectedFieldNames() });
    await refreshJob().catch(() => {});
    startPolling();
    switchScreen("collector");
    showToast("表现数据采集已开始");
  } catch (error) {
    track("collect_start_failed", {
      jobId: state.collectJobId,
      message: String(error.message || "").slice(0, 120),
    }, { jobId: state.collectJobId, entityType: "job", entityId: state.collectJobId });
    showToast(`采集启动失败：${error.message}`);
    $("#startCollect").disabled = false;
  }
}

function resetWorkspace() {
  stopPolling();
  window.clearTimeout(state.poolSaveTimer);
  state.candidates = [];
  clearSelectedCandidates();
  fetch(apiUrl("/api/candidate-pool/current"), { method: "DELETE" }).catch(() => {});
  state.collectJobId = "";
  state.collectJob = null;
  applyTemplate("fuji", { silent: true, force: true });
  state.searchState = "idle";
  state.searchWithinResults = false;
  state.filtersCollapsed = false;
  state.records = [];
  state.resultSearchQuery = "";
  state.lastSearchInput = "";
  state.batchIndex = 0;
  state.searchRequestId += 1;
  state.currentTask = "待输入关键词";
  state.lastSavedAt = "";
  $("#keywordInput").value = "";
  $$("input[name='strategyOption']").forEach((input) => {
    input.checked = input.value === "综合推荐";
  });
  $("#fanRangeSelect").value = "不限";
  $("#categorySelect").value = state.categories.some((item) => item.name === "全部") ? "全部" : state.categories[0]?.name || "";
  renderSubcategories();
  $("#subcategorySelect").value = "不限";
  $("#cooperationTypeSelect").value = "不限";
  $("#priceRangeSelect").value = "不限";
  $("#resultLimitSelect").value = "50";
  $("#bloggerGenderSelect").value = "不限";
  $("#fanGenderSelect").value = "不限";
  $("#sortSelect").value = "综合匹配";
  $("#fileInput").value = "";
  $("#fileName").textContent = "上传达人主页链接 Excel";
  $("#resultMeta").textContent = "尚未检索";
  renderFieldLibrary();
  bindFieldEvents();
  $("#fieldLibraryPanel")?.removeAttribute("open");
  setFilterCollapsed(false);
  renderAll();
  switchScreen("finder");
  track("workspace_reset");
  showToast("当前任务已重置");
}

function bindEvents() {
  $$("[data-screen]").forEach((button) => {
    button.addEventListener("click", () => switchScreen(button.dataset.screen));
  });

  $("#categorySelect").addEventListener("change", () => {
    renderSubcategories();
    renderSummary();
  });

  ["#keywordInput", "#fanRangeSelect", "#subcategorySelect", "#cooperationTypeSelect", "#priceRangeSelect", "#resultLimitSelect", "#bloggerGenderSelect", "#fanGenderSelect", "#sortSelect"].forEach((selector) => {
    $(selector).addEventListener("input", renderSummary);
    $(selector).addEventListener("change", renderSummary);
  });

  $("#strategyTrigger").addEventListener("click", (event) => {
    event.stopPropagation();
    $("#strategyMenu").classList.toggle("is-open");
  });

  $$("input[name='strategyOption']").forEach((input) => {
    input.addEventListener("change", () => {
      if (!$$("input[name='strategyOption']:checked").length) input.checked = true;
      renderSummary();
    });
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".strategy-picker")) $("#strategyMenu").classList.remove("is-open");
  });

  $("#filterForm").addEventListener("submit", (event) => {
    event.preventDefault();
    runSearch();
  });

  $("#toggleFilterPanel").addEventListener("click", () => {
    setFilterCollapsed(!state.filtersCollapsed);
  });

  $("#resultModeToggle").addEventListener("change", (event) => {
    if (!state.candidates.length) {
      event.target.checked = false;
      state.searchWithinResults = false;
      showToast("请先完成一次达人检索");
      return;
    }
    state.searchWithinResults = event.target.checked;
    if (state.searchWithinResults) {
      state.lastSearchInput ||= $("#keywordInput").value.trim();
      $("#keywordInput").value = state.resultSearchQuery;
      setFilterCollapsed(true);
      $("#keywordInput").focus();
      showToast("已切换为在当前结果中检索");
    } else {
      $("#keywordInput").value = state.lastSearchInput;
      state.resultSearchQuery = "";
      $("#resultMeta").textContent = `当前批次 · 返回 ${formatNumber(state.candidates.length)} 位候选`;
      showToast("已切换为重新检索");
    }
    renderAll();
  });

  $("#toggleAll")?.addEventListener("change", (event) => {
    if (event.target.checked) {
      state.candidates.forEach(addSelectedCandidate);
    } else {
      state.candidates.forEach((item) => removeSelectedCandidate(candidateId(item)));
    }
    track(event.target.checked ? "creator_bulk_select" : "creator_bulk_unselect", {
      scope: "current_batch",
      count: state.candidates.length,
      selectedCount: state.selectedCandidates.size,
    });
    renderAll();
    scheduleCandidatePoolSave();
  });

  $("#selectAllRows").addEventListener("change", (event) => {
    const visible = visibleCandidates();
    if (event.target.checked) {
      visible.forEach(addSelectedCandidate);
    } else {
      visible.forEach((item) => removeSelectedCandidate(candidateId(item)));
    }
    track(event.target.checked ? "creator_bulk_select" : "creator_bulk_unselect", {
      scope: "visible_results",
      count: visible.length,
      selectedCount: state.selectedCandidates.size,
    });
    renderAll();
    scheduleCandidatePoolSave();
  });

  $("#clearSelection").addEventListener("click", () => {
    track("candidate_pool_clear", { selectedCount: state.selectedCandidates.size });
    clearSelectedCandidates();
    renderAll();
    saveCandidatePool().catch(() => {});
  });

  $("#addToCollector").addEventListener("click", (event) => createCollectJobFromSelection({ button: event.currentTarget }));
  $("#pushToCollector").addEventListener("click", (event) => createCollectJobFromSelection({ button: event.currentTarget, switchToCollector: true }));
  $("#importFromFinder").addEventListener("click", handleCandidatePoolImport);
  $("#nextBatchBtn").addEventListener("click", nextBatch);
  $("#loginBtn")?.addEventListener("click", openLogin);
  $("#loginBtnTop")?.addEventListener("click", openLogin);
  $("#refreshStatusBtn")?.addEventListener("click", () => refreshStatus());
  $("#uploadBtn").addEventListener("click", uploadExcel);
  $$("input[name='templateId']").forEach((input) => {
    input.addEventListener("change", (event) => applyTemplate(event.target.value));
  });
  $("#startCollect").addEventListener("click", startCollect);
  $("#downloadBtn").addEventListener("click", () => {
    const job = state.collectJob;
    if (!job || job.status !== "done") return;
    track("excel_download_click", {
      sourceType: job.sourceType,
      total: job.progress?.total || job.creators?.length || 0,
    }, { jobId: job.id, entityType: "job", entityId: job.id });
  });
  $("#selectDefaultFields").addEventListener("click", () => {
    state.selectedFields = new Set(defaultFields);
    track("collect_fields_change", { fieldCount: state.selectedFields.size, resetToDefault: true });
    renderFieldLibrary();
    bindFieldEvents();
  });
  $("#saveFieldTemplate")?.addEventListener("click", () => {
    saveCurrentFieldTemplate().catch((error) => showToast(error.message));
  });
  $("#resetWorkspace")?.addEventListener("click", resetWorkspace);
  $("#refreshRecords")?.addEventListener("click", () => refreshRecords().catch((error) => showToast(error.message)));
  $("#refreshAnalytics")?.addEventListener("click", () => refreshAnalytics().catch((error) => showToast(error.message)));
  $("#analyticsDays")?.addEventListener("change", () => refreshAnalytics().catch((error) => showToast(error.message)));
  $("#saveAnalyticsToken")?.addEventListener("click", () => {
    state.analyticsToken = $("#analyticsTokenInput")?.value.trim() || "";
    if (state.analyticsToken) window.localStorage?.setItem("xundao_analytics_token", state.analyticsToken);
    else window.localStorage?.removeItem("xundao_analytics_token");
    refreshAnalytics().catch((error) => showToast(error.message));
  });
  if ($("#analyticsTokenInput")) $("#analyticsTokenInput").value = state.analyticsToken;

  $("#fileInput").addEventListener("change", () => {
    const file = $("#fileInput").files[0];
    $("#fileName").textContent = file ? file.name : "上传达人主页链接 Excel";
  });
}

function bindFieldEvents() {
  $$("input[name='collectField']").forEach((input) => {
    input.addEventListener("change", syncSelectedFieldsFromDom);
  });
}

async function init() {
  if (window.XundaoAuth?.ready) await window.XundaoAuth.ready;
  document.body.dataset.activeScreen = state.activeScreen || "workbench";
  try {
    const templateData = await getJson("/api/templates");
    if (Array.isArray(templateData.templates) && templateData.templates.length) templates = templateData.templates;
  } catch {
    templates = FALLBACK_TEMPLATES;
  }
  applyTemplate("fuji", { silent: true, force: true });
  await loadSavedTemplates().catch(() => {
    state.savedTemplates = [];
    renderSavedTemplates();
  });
  try {
    const data = await getJson("/api/finder/categories");
    state.categories = normalizeCategories(data.categories);
  } catch (error) {
    state.categories = normalizeCategories(fallbackCategories);
    showToast(`类目加载失败，已使用本地兜底：${error.message}`);
  }
  renderCategories();
  renderFieldLibrary();
  bindEvents();
  bindFieldEvents();
  await restoreCandidatePool();
  renderAll();
  track("app_open", { screen: state.activeScreen });
  refreshStatus();
  refreshRecords().catch(() => {});
}

window.XundaoApp = {
  switchScreen,
  showToast,
  refreshStatus,
};
window.XundaoFinder = {
  open() {
    switchScreen("finder");
  },
  async search(text = "") {
    switchScreen("finder");
    $("#keywordInput").value = text;
    await runSearch();
  },
};
window.XundaoCollector = {
  open() {
    switchScreen("collector");
  },
};

init();
