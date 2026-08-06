(function setupWorkbench() {
  const composer = document.querySelector("#luiComposer");
  const input = document.querySelector("#luiInput");
  const fileInput = document.querySelector("#luiFile");
  const conversation = document.querySelector("#conversation");
  const sendButton = document.querySelector("#luiSend");
  const workbench = document.querySelector("#luiWorkbench");
  const attachmentTrigger = document.querySelector("#luiAttachmentTrigger");
  const attachmentMenu = document.querySelector("#luiAttachmentMenu");
  const sidebarCollapse = document.querySelector("#sidebarCollapse");
  const jumpLatest = document.querySelector("#conversationJumpLatest");

  const state = {
    intent: "collect",
    task: null,
    pollTimer: null,
    runStream: null,
    runStreamTaskId: "",
    terminalKey: "",
    streamOpen: true,
    followLatest: true,
    runSignature: "",
    decisionNode: null,
    startingTaskId: "",
  };

  const taskStateLabels = {
    PARSING: "正在理解任务",
    NEEDS_CLARIFICATION: "等待你确认",
    READY_TO_CONFIRM: "等待确认口径",
    CONFIRMED: "准备执行",
    COLLECTING: "正在采集蒲公英",
    NEEDS_ATTENTION: "需要处理",
    VALIDATING: "正在核验数据",
    EXPORTING: "正在生成 Excel",
    COMPLETED: "已完成",
    FAILED: "已暂停",
  };

  const stageLabels = {
    parse: "解析 Excel",
    parsing: "解析 Excel",
    clarification: "澄清取数口径",
    confirmation: "确认字段合同",
    collection: "采集蒲公英",
    scope: "执行取数作用域",
    recovery: "调整采集策略",
    validation: "核验数据",
    model: "模型证据审计",
    export: "整理 Excel",
    result: "生成结果",
    collection_error: "采集遇到阻滞",
    pgy_connection: "检查蒲公英连接",
  };

  function setTaskActive(active) {
    workbench?.classList.toggle("is-empty", !active);
  }

  function setAttachmentMenu(open) {
    const next = Boolean(open);
    if (attachmentMenu) attachmentMenu.hidden = !next;
    attachmentTrigger?.setAttribute("aria-expanded", String(next));
  }

  function selectIntent(intent = "collect", { focus = true } = {}) {
    state.intent = intent === "finder" ? "finder" : "collect";
    document.querySelectorAll("[data-intent]").forEach((button) => {
      const active = button.dataset.intent === state.intent;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    if (input) {
      input.placeholder = state.intent === "collect"
        ? "上传 Excel、粘贴蒲公英链接，或描述需要采集的数据"
        : "例如：寻找 50 位母婴达人，粉丝 5 万到 50 万";
      if (focus) input.focus();
    }
  }

  function clearAttachment() {
    if (fileInput) fileInput.value = "";
    renderAttachment(null);
  }

  function resetComposer() {
    clearAttachment();
    setAttachmentMenu(false);
    selectIntent("collect", { focus: false });
    if (input) {
      input.value = "";
      input.style.height = "";
      input.placeholder = "上传 Excel、粘贴蒲公英链接，或描述需要采集的数据";
    }
    if (sendButton) sendButton.disabled = false;
    composer?.classList.remove("is-submitting", "is-dragover");
    const sendLabel = document.querySelector("#luiSendLabel");
    if (sendLabel) sendLabel.textContent = "发送";
  }

  function newTask() {
    stopPolling();
    state.task = null;
    state.runStream = null;
    state.runStreamTaskId = "";
    state.terminalKey = "";
    state.streamOpen = true;
    state.followLatest = true;
    state.runSignature = "";
    state.decisionNode = null;
    state.startingTaskId = "";
    conversation?.replaceChildren();
    resetComposer();
    setTaskActive(false);
    window.XundaoHistory?.clearCurrent?.();
    window.XundaoApp?.switchScreen("workbench");
    window.setTimeout(() => input?.focus(), 0);
  }

  function addMessage(role, text, { actions = [] } = {}) {
    setTaskActive(true);
    const article = document.createElement("article");
    article.className = `message ${role}`;
    const label = document.createElement("span");
    label.textContent = role === "assistant" ? "寻达" : "你";
    const body = document.createElement("p");
    body.textContent = text;
    article.append(label, body);
    if (actions.length) {
      const actionRow = document.createElement("div");
      actionRow.className = "message-actions";
      actions.forEach((action) => {
        const node = action.href ? document.createElement("a") : document.createElement("button");
        node.className = action.primary ? "primary-action" : "secondary-action";
        node.textContent = action.label;
        if (action.href) {
          node.href = action.href;
        } else {
          node.type = "button";
          node.addEventListener("click", async () => {
            node.disabled = true;
            try {
              await action.run();
            } catch (error) {
              addMessage("assistant", `没有完成：${error.message}`);
            } finally {
              node.disabled = false;
            }
          });
        }
        actionRow.append(node);
      });
      article.append(actionRow);
    }
    conversation?.append(article);
    if (state.followLatest) scrollConversationToLatest();
    updateJumpLatest();
    return article;
  }

  function conversationNearBottom() {
    if (!conversation) return true;
    return conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 96;
  }

  function updateJumpLatest() {
    if (!jumpLatest) return;
    jumpLatest.hidden = state.followLatest || !state.task?.id;
  }

  function scrollConversationToLatest({ behavior = "smooth" } = {}) {
    if (!conversation) return;
    state.followLatest = true;
    window.requestAnimationFrame(() => {
      conversation.scrollTo({ top: conversation.scrollHeight, behavior });
      updateJumpLatest();
    });
  }

  function clearDecision() {
    state.decisionNode?.remove();
    state.decisionNode = null;
  }

  function setDecisionMessage(text, options = {}) {
    clearDecision();
    state.decisionNode = addMessage("assistant", text, options);
    state.decisionNode.dataset.taskDecision = state.task?.id || "";
    return state.decisionNode;
  }

  function creatorNameForEvent(task, index) {
    const creator = task.creators?.[Math.max(0, Number(index) - 1)] || {};
    const currentValueName = Object.values(creator.currentValues || {})
      .map((value) => String(value || "").trim())
      .find((value) => value && !/^https?:\/\//i.test(value));
    return creator.nickname || creator.redId || currentValueName || `达人 ${index}`;
  }

  function legacyEventMessage(entry, task, cursor) {
    const message = String(entry.message || "");
    if (/^采集中：https?:\/\//.test(message)) {
      cursor.position += 1;
      cursor.current = cursor.position;
      return `第 ${cursor.position}/${task.progress?.total || task.creators?.length || "?"} 位 · ${creatorNameForEvent(task, cursor.position)}：开始采集`;
    }
    if (/^完成：https?:\/\//.test(message)) {
      const position = Math.max(1, cursor.current || cursor.position);
      return `第 ${position}/${task.progress?.total || task.creators?.length || "?"} 位 · ${creatorNameForEvent(task, position)}：${/成功/.test(message) ? "采集成功" : "采集完成"}`;
    }
    return message;
  }

  function elapsedText(task) {
    const start = Date.parse(task.startedAt || task.createdAt || "");
    const end = task.finishedAt ? Date.parse(task.finishedAt) : Date.now();
    if (!Number.isFinite(start)) return "";
    const seconds = Math.max(0, Math.floor((end - start) / 1000));
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return minutes ? `${minutes}m ${String(remainder).padStart(2, "0")}s` : `${remainder}s`;
  }

  function stageLabel(entry = {}) {
    if (entry.strategy === "native-ui") return "切换蒲公英原生交互";
    if (entry.strategy === "checkpoint") return "复用已完成检查点";
    return stageLabels[entry.stage] || "执行任务";
  }

  function eventClass(entry = {}) {
    if (entry.level === "error") return "is-error";
    if (entry.level === "warning") return "is-warning";
    if (entry.level === "success") return "is-success";
    if (entry.type === "scope_started" || entry.type === "creator_started") return "is-running";
    return "";
  }

  function runSummary(task, logs) {
    const latest = logs.at(-1);
    if (latest?.message) return latest.message;
    const total = Number(task.progress?.total || task.creators?.length || 0);
    const done = Number(task.progress?.done || 0);
    if (task.taskState === "COLLECTING") return `正在处理第 ${Math.min(done + 1, total)} / ${total} 位达人`;
    return taskStateLabels[task.taskState] || "任务已建立";
  }

  function renderAgentRun(task) {
    if (!task?.id) return null;
    setTaskActive(true);
    if (!state.runStream || state.runStreamTaskId !== task.id) {
      state.runStream?.remove();
      state.runStream = document.createElement("details");
      state.runStream.className = "agent-run-stream";
      state.runStream.open = state.streamOpen;
      state.runStream.addEventListener("toggle", () => {
        state.streamOpen = state.runStream.open;
      });
      state.runStreamTaskId = task.id;
      state.runSignature = "";
      conversation?.append(state.runStream);
    }

    const logs = task.logs || [];
    const total = Number(task.progress?.total || task.creators?.length || 0);
    const done = Number(task.progress?.done || 0);
    const active = task.status === "running";
    const failed = task.status === "failed";
    const status = taskStateLabels[task.taskState] || task.status;
    const progress = total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    const open = state.streamOpen;
    const latest = logs.at(-1) || {};
    const signature = JSON.stringify([
      task.id,
      task.status,
      task.taskState,
      done,
      total,
      logs.length,
      latest.ts || "",
      latest.message || "",
      latest.level || "",
    ]);
    if (state.runSignature === signature) return state.runStream;
    const scrollSnapshot = conversation ? {
      top: conversation.scrollTop,
      height: conversation.scrollHeight,
      follow: state.followLatest,
    } : null;
    state.runSignature = signature;
    state.runStream.replaceChildren();

    const summary = document.createElement("summary");
    const summaryMain = document.createElement("span");
    const pulse = document.createElement("i");
    pulse.className = `agent-run-pulse ${active ? "is-active" : failed ? "is-error" : "is-done"}`;
    const label = document.createElement("strong");
    label.textContent = `${status}${elapsedText(task) ? ` · ${elapsedText(task)}` : ""}`;
    summaryMain.append(pulse, label);
    const chevron = document.createElement("svg");
    chevron.setAttribute("viewBox", "0 0 24 24");
    chevron.setAttribute("aria-hidden", "true");
    chevron.innerHTML = '<path d="m8 10 4 4 4-4"/>';
    summary.append(summaryMain, chevron);

    const body = document.createElement("div");
    body.className = "agent-run-body";
    const headline = document.createElement("p");
    headline.className = "agent-run-headline";
    headline.textContent = runSummary(task, logs);
    body.append(headline);

    if (total) {
      const progressLine = document.createElement("div");
      progressLine.className = "agent-live-progress";
      const copy = document.createElement("span");
      copy.textContent = `${done}/${total} 位达人`;
      const track = document.createElement("i");
      const value = document.createElement("b");
      value.style.transform = `scaleX(${progress / 100})`;
      track.append(value);
      progressLine.append(copy, track);
      body.append(progressLine);
    }

    const list = document.createElement("ol");
    list.className = "agent-event-list";
    const legacyCursor = { position: 0, current: 0 };
    logs.forEach((entry) => {
      const row = document.createElement("li");
      row.className = eventClass(entry);
      const marker = document.createElement("i");
      marker.setAttribute("aria-hidden", "true");
      const copy = document.createElement("div");
      const top = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = stageLabel(entry);
      const time = document.createElement("time");
      time.textContent = entry.ts
        ? new Date(entry.ts).toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          })
        : "";
      top.append(name, time);
      const message = document.createElement("p");
      const readableMessage = legacyEventMessage(entry, task, legacyCursor);
      message.textContent = entry.actor === "user" ? `你：${readableMessage}` : readableMessage;
      copy.append(top, message);
      row.append(marker, copy);
      list.append(row);
    });
    body.append(list);

    if (active) {
      const current = document.createElement("div");
      current.className = "agent-current-action";
      const spinner = document.createElement("i");
      spinner.setAttribute("aria-hidden", "true");
      const text = document.createElement("span");
      text.textContent = "正在等待下一条真实执行事件";
      current.append(spinner, text);
      body.append(current);
    }

    state.runStream.append(summary, body);
    state.runStream.open = open;
    window.requestAnimationFrame(() => {
      if (!conversation || !scrollSnapshot) return;
      if (scrollSnapshot.follow) {
        conversation.scrollTo({ top: conversation.scrollHeight, behavior: "smooth" });
      } else {
        conversation.scrollTop = Math.min(scrollSnapshot.top, conversation.scrollHeight - conversation.clientHeight);
      }
      updateJumpLatest();
    });
    return state.runStream;
  }

  function updateProgress(task) {
    renderAgentRun(task);
  }

  function stopPolling() {
    window.clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }

  async function fetchTask(id) {
    const data = await window.XundaoAuth.request(`/api/tasks/${encodeURIComponent(id)}`);
    return data.task;
  }

  async function pollTask() {
    stopPolling();
    if (!state.task?.id) return;
    const task = await fetchTask(state.task.id);
    state.task = task;
    updateProgress(task);
    window.dispatchEvent(new CustomEvent("xundao:task-updated"));
    if (task.status === "running") {
      state.pollTimer = window.setTimeout(() => pollTask().catch(() => {}), 1000);
      return;
    }
    const terminalKey = `${task.id}:${task.status}:${task.finishedAt || task.error || ""}`;
    if (state.terminalKey === terminalKey) return;
    state.terminalKey = terminalKey;
    if (task.status === "done") {
      const warningText = task.warnings?.length
        ? "数据与 Excel 已完成；模型不可用的单元格已按证据规则补充，无法证明的内容保持空白。"
        : "采集、核验和 Excel 整理已经完成，文件会保留 7 天。";
      addMessage("assistant", warningText, {
        actions: [{
          label: "下载 Excel",
          href: `/api/tasks/${encodeURIComponent(task.id)}/download`,
          primary: true,
        }],
      });
    } else if (task.status === "failed") {
      if (task.errorType === "MODEL_ENRICHMENT") {
        addMessage("assistant", "蒲公英数据已经保留，任务停在模型证据审计阶段。你可以只重试模型，也可以让无法判断的非平台字段留空并生成 Excel。", {
          actions: [
            { label: "重试模型审计", primary: true, run: () => retryTask(false) },
            { label: "留空并生成 Excel", run: () => retryTask(true) },
          ],
        });
      } else if (task.errorType === "PGY_CONNECTION") {
        addMessage("assistant", `蒲公英连接需要恢复：${task.error || "登录状态已失效"}。连接完成后可继续原任务。`, {
          actions: [{
            label: "去个人中心连接",
            primary: true,
            run: () => window.XundaoApp?.switchScreen("settings"),
          }],
        });
      } else {
        addMessage("assistant", `任务已暂停：${task.error || "执行失败"}。已完成的达人和作用域不会重复采集，继续时只处理失败部分。`, {
          actions: [{ label: "继续失败部分", primary: true, run: () => retryTask(false) }],
        });
      }
    }
  }

  async function startTask() {
    if (!state.task?.id) throw new Error("当前会话还没有可执行任务");
    if (state.task.status === "running" || state.startingTaskId === state.task.id) {
      await pollTask();
      return;
    }
    state.startingTaskId = state.task.id;
    try {
      const data = await window.XundaoAuth.request(`/api/tasks/${encodeURIComponent(state.task.id)}/start`, {
        method: "POST",
      });
      state.task = data.job || { ...state.task, status: "running", taskState: "COLLECTING" };
      state.terminalKey = "";
      clearDecision();
      updateProgress(state.task);
      await pollTask();
    } finally {
      state.startingTaskId = "";
    }
  }

  async function confirmAndStart() {
    const version = state.task.taskContract?.version;
    const data = await window.XundaoAuth.request(`/api/tasks/${encodeURIComponent(state.task.id)}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version }),
    });
    state.task = data.job;
    clearDecision();
    addMessage("assistant", `已确认第 ${version} 版取数口径，下面只展示实际发生的步骤。`);
    await startTask();
  }

  async function retryTask(skipModel = false) {
    await window.XundaoAuth.request(`/api/tasks/${encodeURIComponent(state.task.id)}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ skipModel }),
    });
    state.terminalKey = "";
    const postCollectionRetry = ["MODEL_ENRICHMENT", "EXPORT"].includes(state.task.errorType);
    state.task = {
      ...state.task,
      status: "running",
      taskState: postCollectionRetry ? "VALIDATING" : "COLLECTING",
      error: "",
    };
    updateProgress(state.task);
    await pollTask();
  }

  const optionValues = {
    "图文+视频": "all",
    "全部内容": "all",
    "视频": "video",
    "图文": "image",
    "合作笔记": "cooperation",
    "日常笔记": "daily",
    "近90日": "90d",
    "近30日": "30d",
    "全流量": "all",
    "仅自然流量": "natural",
    "按规模": "scale",
    "按成本": "cost",
  };
  const defaultKeys = {
    scene: "sceneDefault",
    contentType: "contentTypeDefault",
    window: "windowDefault",
    traffic: "trafficDefault",
    view: "viewDefault",
  };

  async function answerQuestions(questions = []) {
    const defaults = {};
    const labels = [];
    for (const question of questions) {
      const key = defaultKeys[question.dimension];
      const value = optionValues[question.recommended];
      if (!key || !value) continue;
      defaults[key] = value;
      labels.push(question.recommended);
    }
    if (!Object.keys(defaults).length) throw new Error("这组问题还不能自动形成确定口径，请直接在输入框说明");
    addMessage("user", `采用建议口径：${labels.join("、")}`);
    const data = await window.XundaoAuth.request(`/api/tasks/${encodeURIComponent(state.task.id)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ defaults }),
    });
    state.task = data.job;
    renderTaskDecision(state.task);
  }

  function scopeSummary(task) {
    const groups = task.taskContract?.scopeGroups || [];
    const scene = { cooperation: "合作笔记", daily: "日常笔记", all: "全部笔记" };
    const content = { all: "图文+视频", video: "视频", image: "图文" };
    const windowLabel = { "90d": "近90日", "30d": "近30日", recent16: "近16篇" };
    const traffic = { all: "全流量", natural: "仅自然流量", original: "原始流量" };
    return groups.map((group) => (
      `${scene[group.scene] || group.scene} / ${content[group.contentType] || group.contentType} / ${windowLabel[group.window] || group.window} / ${traffic[group.traffic] || group.traffic}`
    )).join("；");
  }

  function renderTaskDecision(task) {
    window.dispatchEvent(new CustomEvent("xundao:task-updated"));
    const clarification = task.taskContract?.clarification;
    if (task.taskState === "NEEDS_CLARIFICATION") {
      const questions = clarification?.questions || [];
      const recommended = questions.filter((question) => question.recommended);
      const proposal = recommended.map((question) => question.recommended).join("、");
      const affected = questions
        .filter((question) => question.affectedColumns?.length)
        .map((question) => `${question.affectedColumns.join("/")}列缺少${question.dimension === "scene" ? "笔记属性" : question.dimension === "contentType" ? "内容类型" : question.dimension === "window" ? "时间周期" : question.dimension === "traffic" ? "流量范围" : "数据视图"}`)
        .join("；");
      const prompt = [
        clarification?.summary || "还有取数口径需要你确认。",
        affected ? `具体是：${affected}。` : "",
        proposal ? `我建议先按“${proposal}”理解；如果不同，直接在输入框用一句话说明完整口径。` : "请直接在输入框说明需要采用的口径。",
      ].filter(Boolean).join("");
      setDecisionMessage(prompt, {
        actions: recommended.length === questions.length && recommended.length
          ? [
              { label: "采用上述建议", primary: true, run: () => answerQuestions(questions) },
              { label: "我来修改", run: async () => input?.focus() },
            ]
          : [{ label: "我来说明", primary: true, run: async () => input?.focus() }],
      });
      return;
    }
    if (task.taskState === "READY_TO_CONFIRM") {
      setDecisionMessage(
        `我的理解是：${scopeSummary(task) || "按 Excel 表头采集对应的蒲公英字段"}。平台外字段只在已有数据足以证明时由模型补充，否则留空；确认后开始。`,
        { actions: [{ label: "确认并开始", primary: true, run: confirmAndStart }] },
      );
      return;
    }
    if (task.taskState === "CONFIRMED" || task.status === "uploaded") {
      setDecisionMessage(`已准备 ${task.progress?.total || task.creators?.length || 0} 位达人，可以开始。`, {
        actions: [{ label: "开始采集", primary: true, run: startTask }],
      });
      return;
    }
    clearDecision();
    if (["running", "done", "failed"].includes(task.status)) pollTask().catch(() => {});
  }

  function formatFileSize(size) {
    if (!Number.isFinite(size) || size <= 0) return "";
    if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }

  function validateWorkbook(file) {
    if (!file) return;
    if (!/\.(xlsx|xlsm)$/i.test(file.name || "")) throw new Error("只支持 .xlsx 或 .xlsm 文件");
    if (file.size > 50 * 1024 * 1024) throw new Error("Excel 不能超过 50 MB");
  }

  function renderAttachment(file, { error = "" } = {}) {
    const attachment = document.querySelector("#luiAttachment");
    const name = document.querySelector("#luiAttachmentName");
    const meta = document.querySelector("#luiAttachmentMeta");
    const label = document.querySelector("#luiFileLabel");
    const sendLabel = document.querySelector("#luiSendLabel");
    if (!attachment) return;
    attachment.hidden = !file;
    if (!file) {
      if (name) name.textContent = "";
      if (meta) {
        meta.textContent = "已添加，发送后开始解析";
        meta.classList.remove("is-error");
      }
      if (label) label.textContent = "添加 Excel 文件";
      if (sendLabel) sendLabel.textContent = "发送";
      return;
    }
    if (name) name.textContent = file.name;
    if (meta) {
      meta.textContent = error
        ? error
        : `${formatFileSize(file.size)} · 发送后由系统解析表头和蒲公英链接`;
      meta.classList.toggle("is-error", Boolean(error));
    }
    if (label) label.textContent = "更换 Excel";
    if (sendLabel) sendLabel.textContent = "解析 Excel";
  }

  function acceptWorkbookFile(file) {
    try {
      validateWorkbook(file);
      if (fileInput && fileInput.files?.[0] !== file && typeof DataTransfer === "function") {
        const transfer = new DataTransfer();
        transfer.items.add(file);
        fileInput.files = transfer.files;
      }
      renderAttachment(file);
      setAttachmentMenu(false);
      selectIntent("collect");
    } catch (error) {
      clearAttachment();
      addMessage("assistant", `Excel 没有添加：${error.message}`);
      window.XundaoApp?.showToast(error.message);
    }
  }

  async function uploadWorkbook(file, message) {
    const attachmentMeta = document.querySelector("#luiAttachmentMeta");
    if (attachmentMeta) attachmentMeta.textContent = "正在解析表头、字段口径和达人链接……";
    const formData = new FormData();
    formData.append("file", file);
    formData.append("templateId", "dynamic");
    if (message) formData.append("message", message);
    const response = await fetch("/api/upload", {
      method: "POST",
      credentials: "same-origin",
      body: formData,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (attachmentMeta) attachmentMeta.textContent = `解析失败：${data.error || "请检查文件内容"}`;
      throw new Error(data.error || "Excel 解析失败");
    }
    state.task = data.job;
    if (attachmentMeta) attachmentMeta.textContent = `已识别 ${data.count || 0} 位达人`;
    addMessage("assistant", `已读取“${file.name}”，找到 ${data.count || 0} 位达人；正在把表头转换为蒲公英字段合同。`);
    renderTaskDecision(state.task);
  }

  async function submitText(text, { echo = false } = {}) {
    if (echo) addMessage("user", text);
    const data = await window.XundaoAuth.request("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text, intent: state.intent }),
    });
    if (data.nextAction === "open_finder") {
      addMessage("assistant", data.assistant);
      await window.XundaoFinder?.search(text);
      return;
    }
    if (data.nextAction === "choose_collection_scope") {
      addMessage("assistant", data.assistant, {
        actions: [
          {
            label: "全量采集",
            primary: true,
            run: async () => {
              addMessage("user", "全量采集蒲公英可用数据");
              await submitText(`${text}\n全量采集蒲公英可用数据`);
              await window.XundaoHistory?.refresh();
            },
          },
          {
            label: "我来说明字段",
            run: async () => {
              input.value = "";
              input.placeholder = "请说明字段，例如：合作笔记、图文+视频、近90日、全流量的曝光和阅读中位数";
              input.focus();
            },
          },
        ],
      });
      return;
    }
    state.task = data.job;
    if (data.assistant && !["NEEDS_CLARIFICATION", "READY_TO_CONFIRM"].includes(state.task?.taskState)) {
      addMessage("assistant", data.assistant);
    }
    renderTaskDecision(state.task);
  }

  function isStartMessage(text) {
    return /^(?:开始|开始采集|确认|确认并开始|继续|执行|start)$/i.test(String(text || "").trim());
  }

  async function submitCurrentTaskText(text) {
    if (!state.task?.id) return await submitText(text);
    if (state.task.status === "running") {
      setDecisionMessage("当前任务正在执行；你可以向上回看事件，系统不会再把页面强制拉回底部。", {
        actions: [{ label: "查看最新进度", primary: true, run: async () => scrollConversationToLatest() }],
      });
      return;
    }
    if (isStartMessage(text)) {
      if (state.task.taskState === "READY_TO_CONFIRM") return await confirmAndStart();
      if (state.task.taskState === "CONFIRMED") return await startTask();
    }
    if (["NEEDS_CLARIFICATION", "READY_TO_CONFIRM"].includes(state.task.taskState)) {
      const data = await window.XundaoAuth.request(`/api/tasks/${encodeURIComponent(state.task.id)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      state.task = data.job;
      renderTaskDecision(state.task);
      return;
    }
    if (["done", "failed"].includes(state.task.status)) {
      setDecisionMessage("当前任务已经结束。如需采集新的 Excel 或链接，请点击左侧“新建任务”。");
      return;
    }
    return await submitText(text);
  }

  composer?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    const file = fileInput.files[0];
    if (!text && !file) {
      input.focus();
      return;
    }
    setTaskActive(true);
    sendButton.disabled = true;
    composer.classList.add("is-submitting");
    const sendLabel = document.querySelector("#luiSendLabel");
    if (sendLabel) sendLabel.textContent = file ? "正在解析" : "处理中";
    const userMessage = file
      ? `${text || "开始采集"}（已附加 ${file.name}）`
      : text;
    addMessage("user", userMessage);
    input.value = "";
    input.style.height = "";
    if (file) clearAttachment();
    try {
      if (state.intent === "finder" && !file) {
        await window.XundaoFinder?.search(text);
      } else if (file) {
        await uploadWorkbook(file, text);
      } else if (state.task?.id) {
        await submitCurrentTaskText(text);
      } else {
        await submitText(text);
      }
      await window.XundaoHistory?.refresh();
    } catch (error) {
      addMessage("assistant", `我暂时不能继续：${error.message}`);
      if (file) {
        acceptWorkbookFile(file);
        renderAttachment(file, { error: `解析失败：${error.message}` });
      }
    } finally {
      sendButton.disabled = false;
      composer.classList.remove("is-submitting");
      if (!fileInput.files[0] && sendLabel) sendLabel.textContent = "发送";
      else if (sendLabel) sendLabel.textContent = "重新解析";
    }
  });

  document.querySelectorAll("[data-intent]").forEach((button) => {
    button.addEventListener("click", () => selectIntent(button.dataset.intent));
  });

  fileInput?.addEventListener("change", () => {
    const file = fileInput.files[0];
    if (file) acceptWorkbookFile(file);
    else renderAttachment(null);
  });

  attachmentTrigger?.addEventListener("click", () => {
    setAttachmentMenu(attachmentMenu?.hidden !== false);
  });
  document.querySelector("#luiRemoveFile")?.addEventListener("click", clearAttachment);
  composer?.addEventListener("dragenter", (event) => {
    event.preventDefault();
    composer.classList.add("is-dragover");
  });
  composer?.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    composer.classList.add("is-dragover");
  });
  composer?.addEventListener("dragleave", (event) => {
    if (!composer.contains(event.relatedTarget)) composer.classList.remove("is-dragover");
  });
  composer?.addEventListener("drop", (event) => {
    event.preventDefault();
    composer.classList.remove("is-dragover");
    const file = event.dataTransfer?.files?.[0];
    if (file) acceptWorkbookFile(file);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && attachmentMenu?.hidden === false) {
      setAttachmentMenu(false);
      attachmentTrigger?.focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (attachmentMenu?.hidden === false && !event.target.closest(".attachment-menu-wrap")) {
      setAttachmentMenu(false);
    }
  });
  document.querySelector("#newTaskButton")?.addEventListener("click", newTask);
  conversation?.addEventListener("scroll", () => {
    state.followLatest = conversationNearBottom();
    updateJumpLatest();
  }, { passive: true });
  conversation?.addEventListener("wheel", (event) => {
    if (event.deltaY < 0) {
      state.followLatest = false;
      updateJumpLatest();
    }
  }, { passive: true });
  conversation?.addEventListener("touchstart", () => {
    state.followLatest = false;
    updateJumpLatest();
  }, { passive: true });
  jumpLatest?.addEventListener("click", () => scrollConversationToLatest());

  function updateSidebarControl(collapsed) {
    sidebarCollapse?.setAttribute("aria-label", collapsed ? "展开侧栏" : "收起侧栏");
    sidebarCollapse?.setAttribute("title", collapsed ? "展开侧栏" : "收起侧栏");
    sidebarCollapse?.setAttribute("aria-expanded", String(!collapsed));
  }

  sidebarCollapse?.addEventListener("click", () => {
    const collapsed = document.body.classList.toggle("sidebar-is-collapsed");
    window.localStorage?.setItem("xundao_sidebar_collapsed", collapsed ? "1" : "0");
    updateSidebarControl(collapsed);
  });
  const initiallyCollapsed = window.localStorage?.getItem("xundao_sidebar_collapsed") === "1";
  document.body.classList.toggle("sidebar-is-collapsed", initiallyCollapsed);
  updateSidebarControl(initiallyCollapsed);

  input?.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  });

  async function openTask(task) {
    window.XundaoApp?.switchScreen("workbench");
    stopPolling();
    conversation?.replaceChildren();
    resetComposer();
    state.runStream = null;
    state.runStreamTaskId = "";
    state.terminalKey = "";
    state.streamOpen = true;
    state.followLatest = true;
    state.runSignature = "";
    state.decisionNode = null;
    state.startingTaskId = "";
    state.task = await fetchTask(task.id);
    setTaskActive(true);
    renderAgentRun(state.task);
    renderTaskDecision(state.task);
    scrollConversationToLatest({ behavior: "auto" });
  }

  window.XundaoWorkbench = { openTask, renderTaskDecision, newTask };
})();
