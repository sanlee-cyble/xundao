const PGY_CATEGORIES = [
  ["全部", []],
  ["美妆", ["整体妆容", "唇妆", "眼妆", "美甲", "底妆", "美妆合集", "香水", "美妆其他"]],
  ["护肤", ["面部保养", "面部清洁", "护肤合集", "护肤其他"]],
  ["个人护理", ["头发产品", "身体护理", "口腔护理", "护理其他"]],
  ["母婴", ["母婴日常", "早教", "婴童用品", "婴童洗护", "婴童食品", "婴童时尚", "孕期穿搭", "孕产经验", "产后恢复", "育儿经验", "宝宝才艺", "宝宝写真", "母婴其他"]],
  ["时尚", ["穿搭", "配饰", "发型", "箱包", "鞋靴", "时尚其他"]],
  ["美食", ["美食教程", "美食探店", "美食展示", "美食测评", "吃播", "美食其他"]],
  ["家居家装", ["装修", "家居用品", "花艺园艺", "家居装饰", "家具", "家电", "室内设计", "居家经验", "家居家装其他"]],
  ["影视综资讯", ["动漫", "娱乐资讯", "影视", "民生资讯", "综艺", "影视综其他"]],
  ["运动健身", ["减脂塑形", "滑雪", "滑板", "水上活动", "运动其他", "足球", "篮球", "跑步", "游泳"]],
  ["宠物", ["猫", "狗", "动物其他"]],
  ["文化艺术", ["社科", "文化", "艺术", "文化艺术其他"]],
  ["兴趣爱好", ["绘画", "手工", "阅读", "文具手账", "舞蹈", "兴趣爱好其他", "玩具周边"]],
  ["生活记录", ["接地气生活", "日常片段", "中外生活", "品质生活", "校园生活"]],
  ["教育", ["大学教育", "k12教育", "家庭教育", "学习日常", "留学教育", "教育其他", "语言教育"]],
  ["职场", ["职场干货", "职场行业", "职业考试", "职场其他"]],
  ["情感", ["情感知识", "情感日常", "情感其他"]],
  ["摄影", ["人文风光摄影", "摄影技巧", "胶片摄影", "人像摄影", "摄影其他"]],
  ["游戏", ["手机游戏", "主机游戏", "游戏其他", "线下游戏"]],
  ["科技数码", ["移动数码", "玩机攻略", "数码科技其他"]],
  ["出行旅游", ["城市出行", "户外", "旅行"]],
  ["音乐", []],
  ["搞笑", []],
  ["健康养生", []],
  ["汽车", ["用车攻略", "汽车评测", "汽车其他"]],
  ["婚嫁", ["婚礼造型", "婚礼记录", "婚礼经验", "婚礼用品"]],
  ["商业财经", []],
  ["素材", []],
  ["其他", []],
];

const CANDIDATES = [
  {
    id: "5fd829ba000000000100a033",
    name: "格跳Queena",
    redId: "1025851414",
    fans: 70336,
    evidence: "近期网球笔记 24 篇",
    price: 14500,
    status: "可采集",
  },
  {
    id: "5637c507b7ba2256377b12af",
    name: "Banks Tennis",
    redId: "411558514",
    fans: 31109,
    evidence: "近期网球笔记 25 篇",
    price: 5000,
    status: "可采集",
  },
  {
    id: "598d433f6a6a696748cf55c7",
    name: "开开katherine_",
    redId: "956914617",
    fans: 15198,
    evidence: "近期网球笔记 2 篇",
    price: 3000,
    status: "可采集",
  },
  {
    id: "5d0b3ce40000000016016624",
    name: "Total Tennis",
    redId: "779225163",
    fans: 24541,
    evidence: "近期网球笔记 2 篇",
    price: 3000,
    status: "可采集",
  },
  {
    id: "5aadf4184eacab740fcada15",
    name: "羊仔码头",
    redId: "945691188",
    fans: 17002,
    evidence: "近期网球笔记 2 篇",
    price: 9700,
    status: "可采集",
  },
];

const state = {
  selected: new Set(),
  pushed: false,
  activeScreen: "finder",
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(value);
}

function formatFans(value) {
  if (!value) return "0";
  if (value >= 10000) return `${(value / 10000).toFixed(value >= 100000 ? 1 : 1)}万`;
  return formatNumber(value);
}

function formatPrice(value) {
  return `¥${formatNumber(value)} 起`;
}

function selectedItems() {
  return CANDIDATES.filter((item) => state.selected.has(item.id));
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2200);
}

function switchScreen(screenId) {
  state.activeScreen = screenId;
  $$(".screen").forEach((screen) => {
    screen.classList.toggle("is-active", screen.id === screenId);
  });
  $$("[data-screen]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.screen === screenId);
  });
}

function renderCategories() {
  const categorySelect = $("#categorySelect");
  categorySelect.innerHTML = PGY_CATEGORIES.map(([name]) => `<option value="${name}">${name}</option>`).join("");
  categorySelect.value = "运动健身";
  renderSubcategories();
}

function renderSubcategories() {
  const category = $("#categorySelect").value;
  const hit = PGY_CATEGORIES.find(([name]) => name === category);
  const subcategories = hit?.[1] || [];
  $("#subcategorySelect").innerHTML = ["不限", ...subcategories]
    .map((name) => `<option value="${name}">${name}</option>`)
    .join("");
}

function renderRows() {
  $("#candidateRows").innerHTML = CANDIDATES.map((item) => {
    const checked = state.selected.has(item.id);
    return `
      <tr class="${checked ? "is-selected" : ""}">
        <td data-label="选择">
          <input type="checkbox" class="row-check" aria-label="选择 ${item.name}" data-id="${item.id}" ${checked ? "checked" : ""} />
        </td>
        <td data-label="达人">
          <span class="creator-name">
            <strong>${item.name}</strong>
            <span>${item.id}</span>
          </span>
        </td>
        <td data-label="小红书号">
          <span class="copy-row">${item.redId}<button class="mini-btn copy-btn" data-copy="${item.redId}" type="button">复制</button></span>
        </td>
        <td data-label="粉丝数" class="number">${formatNumber(item.fans)}</td>
        <td data-label="相关依据">${item.evidence}</td>
        <td data-label="报价" class="number">${formatPrice(item.price)}</td>
        <td data-label="状态"><span class="status-pill ready">${item.status}</span></td>
        <td data-label="操作"><button class="mini-btn detail-btn" data-id="${item.id}" type="button">查看主页</button></td>
      </tr>
    `;
  }).join("");

  $$(".row-check").forEach((input) => {
    input.addEventListener("change", () => {
      if (input.checked) state.selected.add(input.dataset.id);
      else state.selected.delete(input.dataset.id);
      state.pushed = false;
      renderAll();
    });
  });

  $$(".copy-btn").forEach((button) => {
    button.addEventListener("click", async () => {
      await navigator.clipboard?.writeText(button.dataset.copy).catch(() => {});
      showToast(`已复制小红书号：${button.dataset.copy}`);
    });
  });

  $$(".detail-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const url = `https://pgy.xiaohongshu.com/solar/pre-trade/blogger-detail/${button.dataset.id}`;
      showToast(`正式版将打开：${url}`);
    });
  });
}

function renderPool() {
  const items = selectedItems();
  const selectedCount = items.length;
  const averageFans = selectedCount
    ? Math.round(items.reduce((sum, item) => sum + item.fans, 0) / selectedCount)
    : 0;

  $("#selectedCountInline").textContent = String(selectedCount);
  $("#poolReadyCount").textContent = String(selectedCount);
  $("#poolAverageFans").textContent = selectedCount ? formatFans(averageFans) : "0";
  $("#sidebarQueueCount").textContent = state.pushed ? String(selectedCount) : "0";
  $("#addToCollector").disabled = selectedCount === 0;
  $("#pushToCollector").disabled = selectedCount === 0;
  $("#toggleAll").checked = selectedCount === CANDIDATES.length;
  $("#toggleAll").indeterminate = selectedCount > 0 && selectedCount < CANDIDATES.length;

  $("#poolList").innerHTML = selectedCount
    ? items.map((item) => `
        <div class="pool-item">
          <div>
            <strong>${item.name}</strong>
            <span>${formatNumber(item.fans)} 粉丝 · ${formatPrice(item.price)}</span>
          </div>
          <button class="remove-btn" data-remove="${item.id}" type="button" aria-label="移除 ${item.name}">×</button>
        </div>
      `).join("")
    : `<div class="empty-state">暂无候选达人，请从左侧表格选择</div>`;

  $$(".remove-btn").forEach((button) => {
    button.addEventListener("click", () => {
      state.selected.delete(button.dataset.remove);
      state.pushed = false;
      renderAll();
    });
  });

  $("#confirmStep").classList.toggle("active", selectedCount > 0 && !state.pushed);
  $("#confirmStep").classList.toggle("done", state.pushed);
  $("#confirmStep").querySelector("em").textContent = selectedCount ? "已确认" : "待确认";
  $("#pushStep").classList.toggle("active", state.pushed);
  $("#pushStep").classList.toggle("done", state.pushed);
  $("#pushStep").querySelector("em").textContent = state.pushed ? "已推送" : "未推送";
}

function renderTasks(progress = 0) {
  const items = selectedItems();
  if (!state.pushed || items.length === 0) {
    $("#collectorTaskMeta").textContent = "等待导入";
    $("#taskList").innerHTML = `
      <div class="task">
        <div>
          <strong>无任务</strong>
          <p>找达人候选池不会自动进入采集，需确认后导入。</p>
        </div>
        <span class="status-pill muted">待导入</span>
        <div class="progress"><i></i></div>
      </div>
    `;
    return;
  }

  $("#collectorTaskMeta").textContent = `${items.length} 位达人`;
  $("#taskList").innerHTML = items.map((item, index) => {
    const rowProgress = Math.max(0, Math.min(100, progress - index * 22));
    const status = rowProgress >= 100 ? "已完成" : rowProgress > 0 ? "采集中" : "排队中";
    const pill = rowProgress >= 100 ? "ready" : "muted";
    return `
      <div class="task">
        <div>
          <strong>${item.name}</strong>
          <p>${item.redId} · ${formatNumber(item.fans)} 粉丝</p>
        </div>
        <span class="status-pill ${pill}">${status}</span>
        <div class="progress"><i style="--progress:${rowProgress}%"></i></div>
      </div>
    `;
  }).join("");
}

function renderSummary() {
  const keyword = $("#keywordInput").value.trim() || "关键词";
  const fanRange = $("#fanRangeSelect").value;
  const category = $("#categorySelect").value;
  const subcategory = $("#subcategorySelect").value;
  const categoryText = subcategory && subcategory !== "不限" ? `${category}/${subcategory}` : category;
  $("#querySummary").textContent = `${keyword} · ${fanRange}粉丝 · ${categoryText} · ${$("#sortSelect").value}`;
  $("#sidebarResultCount").textContent = String(CANDIDATES.length);
}

function renderAll() {
  renderRows();
  renderPool();
  renderTasks();
  renderSummary();
}

function bindEvents() {
  $$("[data-screen]").forEach((button) => {
    button.addEventListener("click", () => switchScreen(button.dataset.screen));
  });

  $("#categorySelect").addEventListener("change", () => {
    renderSubcategories();
    renderSummary();
  });

  ["#keywordInput", "#fanRangeSelect", "#subcategorySelect", "#matchSelect", "#sortSelect"].forEach((selector) => {
    $(selector).addEventListener("input", renderSummary);
    $(selector).addEventListener("change", renderSummary);
  });

  $("#filterForm").addEventListener("submit", (event) => {
    event.preventDefault();
    state.selected.clear();
    state.pushed = false;
    renderAll();
    showToast("已按当前条件刷新候选结果");
  });

  $("#toggleAll").addEventListener("change", (event) => {
    state.selected = event.target.checked ? new Set(CANDIDATES.map((item) => item.id)) : new Set();
    state.pushed = false;
    renderAll();
  });

  $("#selectAllRows").addEventListener("click", () => {
    state.selected = new Set(CANDIDATES.map((item) => item.id));
    state.pushed = false;
    renderAll();
  });

  $("#clearSelection").addEventListener("click", () => {
    state.selected.clear();
    state.pushed = false;
    renderAll();
  });

  $("#addToCollector").addEventListener("click", () => {
    if (!state.selected.size) return;
    state.pushed = true;
    renderAll();
    showToast(`已加入表现采集：${state.selected.size} 位达人`);
  });

  $("#pushToCollector").addEventListener("click", () => {
    if (!state.selected.size) return;
    state.pushed = true;
    renderAll();
    switchScreen("collector");
    showToast("候选池已推送到表现采集");
  });

  $("#importFromFinder").addEventListener("click", () => {
    if (!state.selected.size) {
      showToast("请先在找达人工作台选择候选");
      switchScreen("finder");
      return;
    }
    state.pushed = true;
    renderAll();
    showToast("已导入候选池");
  });

  $("#startCollect").addEventListener("click", () => {
    if (!state.pushed) {
      showToast("请先导入候选池或上传 Excel");
      return;
    }
    let progress = 20;
    renderTasks(progress);
    showToast("开始模拟采集表现数据");
    const timer = window.setInterval(() => {
      progress += 24;
      renderTasks(progress);
      if (progress >= 210) {
        window.clearInterval(timer);
        showToast("模拟采集完成，正式版将生成 Excel");
      }
    }, 520);
  });

  $("#resetDemo").addEventListener("click", () => {
    state.selected.clear();
    state.pushed = false;
    $("#keywordInput").value = "网球";
    $("#fanRangeSelect").value = "1-10万";
    $("#categorySelect").value = "运动健身";
    renderSubcategories();
    $("#subcategorySelect").value = "不限";
    $("#matchSelect").value = "至少 2 篇";
    $("#sortSelect").value = "综合匹配";
    renderAll();
    switchScreen("finder");
    showToast("演示已重置");
  });
}

renderCategories();
bindEvents();
renderAll();
