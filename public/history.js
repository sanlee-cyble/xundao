(function setupHistory() {
  const itemsNode = document.querySelector("#recentTaskItems");
  const searchInput = document.querySelector("#taskHistorySearch");
  let tasks = [];
  let query = "";
  let currentTaskId = "";

  const statusLabel = {
    PARSING: "解析中",
    NEEDS_CLARIFICATION: "待澄清",
    READY_TO_CONFIRM: "待确认",
    CONFIRMED: "待采集",
    COLLECTING: "采集中",
    NEEDS_ATTENTION: "需处理",
    VALIDATING: "校验中",
    EXPORTING: "导出中",
    COMPLETED: "已完成",
    FAILED: "失败",
    EXPIRED: "已过期",
  };

  function dayStart(value) {
    const date = new Date(value);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  }

  function groupLabel(task) {
    const today = dayStart(Date.now());
    const created = dayStart(task.createdAt || Date.now());
    const days = Math.round((today - created) / 86400000);
    if (days <= 0) return "今天";
    if (days === 1) return "昨天";
    return "过去 7 天";
  }

  function taskTitle(task) {
    const original = String(task.originalName || "未命名任务");
    if (/^(?:LUI\s*)?链接采集$/i.test(original.trim())) return "链接";
    return original
      .replace(/\.(xlsx|xlsm)$/i, "")
      .trim() || "未命名任务";
  }

  function statusClass(task) {
    if (task.status === "failed" || task.taskState === "FAILED" || task.taskState === "NEEDS_ATTENTION") {
      return "is-error";
    }
    if (task.outputReady || task.taskState === "COMPLETED") return "is-done";
    if (task.status === "running" || ["COLLECTING", "VALIDATING", "EXPORTING"].includes(task.taskState)) {
      return "is-running";
    }
    return "";
  }

  async function copyTask(task, button) {
    button.disabled = true;
    try {
      const data = await window.XundaoAuth.request(`/api/tasks/${encodeURIComponent(task.id)}/copy`, {
        method: "POST",
      });
      await refresh();
      await openTask(data.task);
    } catch (error) {
      window.XundaoApp?.showToast(error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function saveTemplate(task, button) {
    const name = window.prompt("请输入模板名称", `${taskTitle(task)}模板`);
    if (!name?.trim()) return;
    button.disabled = true;
    try {
      const data = await window.XundaoAuth.request(
        `/api/tasks/${encodeURIComponent(task.id)}/save-template`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: name.trim() }),
        },
      );
      window.dispatchEvent(new CustomEvent("xundao:templates-updated"));
      window.XundaoApp?.showToast(`已固化模板：${data.template.name}`);
    } catch (error) {
      window.XundaoApp?.showToast(error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function deleteTask(task, button) {
    if (!window.confirm(`确定删除“${taskTitle(task)}”吗？任务文件将立即删除且不可恢复。`)) return;
    button.disabled = true;
    try {
      await window.XundaoAuth.request(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
      if (currentTaskId === task.id) window.XundaoWorkbench?.newTask();
      await refresh();
    } catch (error) {
      window.XundaoApp?.showToast(error.message);
    }
  }

  async function openTask(task) {
    currentTaskId = task.id;
    render();
    await window.XundaoWorkbench?.openTask(task);
  }

  function actionButton(label, run, className = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      run(button);
    });
    return button;
  }

  function taskNode(task) {
    const article = document.createElement("article");
    article.className = `recent-task${currentTaskId === task.id ? " is-current" : ""}`;

    const dot = document.createElement("span");
    dot.className = `task-status-dot ${statusClass(task)}`.trim();
    dot.title = statusLabel[task.taskState] || task.status || "待处理";

    const main = document.createElement("button");
    main.type = "button";
    main.className = "recent-task-main";
    main.title = `${taskTitle(task)} · ${dot.title}`;
    const title = document.createElement("strong");
    title.textContent = taskTitle(task);
    main.append(title);
    main.addEventListener("click", () => openTask(task).catch((error) => {
      window.XundaoApp?.showToast(error.message);
    }));

    const actions = document.createElement("details");
    actions.className = "history-actions";
    const summary = document.createElement("summary");
    summary.className = "recent-task-menu";
    summary.setAttribute("aria-label", `${taskTitle(task)}更多操作`);
    summary.textContent = "•••";
    const menu = document.createElement("div");
    if (task.outputReady) {
      const download = document.createElement("a");
      download.href = `/api/tasks/${encodeURIComponent(task.id)}/download`;
      download.textContent = "下载 Excel";
      menu.append(download);
    }
    menu.append(actionButton("复制任务", (button) => copyTask(task, button)));
    if (
      task.templateId === "dynamic"
      && task.taskContract
      && Number(task.taskContract.unresolvedCount || 0) === 0
    ) {
      menu.append(actionButton("固化为模板", (button) => saveTemplate(task, button)));
    }
    menu.append(actionButton("删除任务", (button) => deleteTask(task, button), "danger-text"));
    actions.append(summary, menu);
    article.append(dot, main, actions);
    return article;
  }

  function render() {
    if (!itemsNode) return;
    itemsNode.replaceChildren();
    const normalized = query.trim().toLowerCase();
    const visible = tasks.filter((task) => (
      !normalized
      || taskTitle(task).toLowerCase().includes(normalized)
      || String(statusLabel[task.taskState] || task.status || "").includes(normalized)
    ));
    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = normalized ? "没有匹配的任务。" : "最近 7 天还没有任务。";
      itemsNode.append(empty);
      return;
    }
    const groups = new Map();
    for (const task of visible) {
      const label = groupLabel(task);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push(task);
    }
    for (const [label, groupedTasks] of groups) {
      const section = document.createElement("section");
      section.className = "history-group";
      const heading = document.createElement("span");
      heading.className = "history-group-label";
      heading.textContent = label;
      section.append(heading, ...groupedTasks.map(taskNode));
      itemsNode.append(section);
    }
  }

  async function refresh() {
    if (window.XundaoAuth?.ready) await window.XundaoAuth.ready;
    const data = await window.XundaoAuth.request("/api/tasks");
    tasks = data.tasks || [];
    render();
    return tasks;
  }

  searchInput?.addEventListener("input", () => {
    query = searchInput.value;
    render();
  });
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      searchInput?.focus();
    }
  });
  document.addEventListener("click", (event) => {
    document.querySelectorAll(".history-actions[open]").forEach((details) => {
      if (!details.contains(event.target)) details.removeAttribute("open");
    });
  });
  window.addEventListener("xundao:task-updated", () => refresh().catch(() => {}));

  window.XundaoHistory = {
    refresh,
    render,
    clearCurrent() {
      currentTaskId = "";
      render();
    },
  };
  refresh().catch(() => {});
})();
