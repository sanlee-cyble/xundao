(function setupProfile() {
  let pgyPreviewObjectUrl = "";

  function setText(selector, value) {
    const node = document.querySelector(selector);
    if (node) node.textContent = value;
  }

  async function refresh() {
    if (window.XundaoAuth?.ready) await window.XundaoAuth.ready;
    const [profile, performanceData] = await Promise.all([
      window.XundaoAuth.request("/api/profile"),
      window.XundaoAuth.request("/api/profile/performance"),
    ]);
    const user = profile.user || {};
    const connection = profile.connection || {};
    setText("#profileAccount", `${user.displayName || "未命名用户"} · ${user.email || ""} · ${user.role === "admin" ? "管理员" : "媒介用户"}`);
    const displayNameInput = document.querySelector("#profileDisplayName");
    if (displayNameInput) displayNameInput.value = user.displayName || "";
    document.querySelector("#profileAccountForm")?.toggleAttribute("hidden", !profile.authRequired);
    document.querySelector("#profilePasswordForm")?.toggleAttribute("hidden", !profile.authRequired);
    document.querySelector("#logoutAccount")?.toggleAttribute("hidden", !profile.authRequired);
    document.querySelector("#profileSecurity")?.toggleAttribute("hidden", !profile.authRequired);
    const loginPanel = document.querySelector("#pgyLoginPanel");
    if (loginPanel && connection.interactiveOpen) {
      loginPanel.removeAttribute("hidden");
      if (!pgyPreviewObjectUrl) {
        loadPgyPreview().catch((error) => {
          const feedback = document.querySelector("#pgyLoginPreviewFeedback");
          if (feedback) feedback.textContent = error.message;
        });
      }
    }
    if (!connection.interactiveOpen) hidePgyPreview();
    const connectButton = document.querySelector("#profileConnectPgy");
    if (connectButton) {
      connectButton.textContent = connection.shared
        ? "连接个人蒲公英账号"
        : connection.connected || connection.interactiveOpen
          ? "重新连接"
          : "连接蒲公英";
    }
    const saveButton = document.querySelector("#profileSavePgy");
    if (saveButton) saveButton.toggleAttribute("hidden", !connection.interactiveOpen);
    const disconnectButton = document.querySelector("#profileDisconnectPgy");
    if (disconnectButton) disconnectButton.toggleAttribute("hidden", connection.shared || !connection.connected);
    setText(
      "#profilePgyStatus",
      connection.interactiveOpen
        ? "蒲公英连接页面已打开；完成登录后，请点击“确认已登录并保存”。"
        : connection.connected
          ? `${connection.shared ? "正在使用团队共享的" : ""}${connection.maskedAccountName || "蒲公英账号"}，最近验证：${connection.lastVerifiedAt ? new Date(connection.lastVerifiedAt).toLocaleString("zh-CN") : "刚刚"}`
          : connection.contextOpen
          ? "蒲公英连接页面已打开；完成登录后，请点击“确认已登录并保存”。"
          : "尚未连接。首次连接后会使用独立加密登录态，失效前无需重复登录。",
    );
    const performance = performanceData.performance || {};
    const node = document.querySelector("#profilePerformance");
    if (node) {
      node.innerHTML = `
        <div><strong>${performance.taskCount || 0}</strong><span>任务</span></div>
        <div><strong>${performance.completed || 0}</strong><span>完成</span></div>
        <div><strong>${performance.creatorCount || 0}</strong><span>达人</span></div>
        <div><strong>${performance.completionRate || 0}%</strong><span>完成率</span></div>
      `;
    }
  }

  function setAccountFeedback(message, error = false) {
    const node = document.querySelector("#profileAccountFeedback");
    if (!node) return;
    node.textContent = message;
    node.classList.toggle("is-error", error);
  }

  function hidePgyPreview() {
    document.querySelector("#pgyLoginPanel")?.setAttribute("hidden", "");
    if (pgyPreviewObjectUrl) URL.revokeObjectURL(pgyPreviewObjectUrl);
    pgyPreviewObjectUrl = "";
    const image = document.querySelector("#pgyLoginPreview");
    if (image) image.removeAttribute("src");
  }

  async function loadPgyPreview() {
    const feedback = document.querySelector("#pgyLoginPreviewFeedback");
    if (feedback) feedback.textContent = "正在读取登录画面……";
    const response = await fetch(`/api/pgy/connect/preview?t=${Date.now()}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "蒲公英登录画面读取失败");
    }
    const blob = await response.blob();
    if (pgyPreviewObjectUrl) URL.revokeObjectURL(pgyPreviewObjectUrl);
    pgyPreviewObjectUrl = URL.createObjectURL(blob);
    const image = document.querySelector("#pgyLoginPreview");
    if (image) image.src = pgyPreviewObjectUrl;
    if (feedback) feedback.textContent = "登录页已重新加载；可直接点击画面继续登录。";
  }

  async function clickPgyPreview(event) {
    const image = event.currentTarget;
    if (!image?.naturalWidth || !image?.naturalHeight) return;
    const rectangle = image.getBoundingClientRect();
    if (!rectangle.width || !rectangle.height) return;
    const renderedRatio = Math.min(
      rectangle.width / image.naturalWidth,
      rectangle.height / image.naturalHeight,
    );
    const contentWidth = image.naturalWidth * renderedRatio;
    const contentHeight = image.naturalHeight * renderedRatio;
    const contentLeft = rectangle.left + (rectangle.width - contentWidth) / 2;
    const contentTop = rectangle.top + (rectangle.height - contentHeight) / 2;
    const xRatio = (event.clientX - contentLeft) / contentWidth;
    const yRatio = (event.clientY - contentTop) / contentHeight;
    if (xRatio < 0 || xRatio > 1 || yRatio < 0 || yRatio > 1) return;
    const feedback = document.querySelector("#pgyLoginPreviewFeedback");
    if (feedback) feedback.textContent = "正在操作蒲公英页面……";
    await window.XundaoAuth.request("/api/pgy/connect/input", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ xRatio, yRatio }),
    });
    await loadPgyPreview();
  }

  document.querySelector("#profileAccountForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type='submit']");
    button.disabled = true;
    setAccountFeedback("");
    try {
      const data = await window.XundaoAuth.request("/api/profile", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: document.querySelector("#profileDisplayName").value.trim(),
        }),
      });
      window.XundaoAuth.state.user = data.user;
      setAccountFeedback("显示名称已保存。");
      await refresh();
    } catch (error) {
      setAccountFeedback(error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  document.querySelector("#profilePasswordForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button[type='submit']");
    button.disabled = true;
    setAccountFeedback("");
    try {
      const data = await window.XundaoAuth.request("/api/profile/change-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          currentPassword: document.querySelector("#profileCurrentPassword").value,
          newPassword: document.querySelector("#profileNewPassword").value,
        }),
      });
      if (data.reloginRequired) {
        window.location.reload();
        return;
      }
    } catch (error) {
      setAccountFeedback(error.message, true);
      button.disabled = false;
    }
  });

  document.querySelector("#profileConnectPgy")?.addEventListener("click", async () => {
    try {
      const data = await window.XundaoAuth.request("/api/pgy/connect", { method: "POST" });
      document.querySelector("#pgyLoginPanel")?.removeAttribute("hidden");
      await loadPgyPreview();
      window.XundaoApp?.showToast(data.message || "蒲公英连接页面已准备好");
      await refresh();
    } catch (error) {
      window.XundaoApp?.showToast(error.message);
    }
  });

  document.querySelector("#profileSavePgy")?.addEventListener("click", async () => {
    try {
      await window.XundaoAuth.request("/api/pgy/connection/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      window.XundaoApp?.showToast("蒲公英连接已加密保存");
      hidePgyPreview();
      await refresh();
    } catch (error) {
      window.XundaoApp?.showToast(error.message);
    }
  });

  document.querySelector("#profileDisconnectPgy")?.addEventListener("click", async () => {
    if (!window.confirm("确定解除当前蒲公英连接吗？后续采集需要重新登录。")) return;
    await window.XundaoAuth.request("/api/pgy/connection", { method: "DELETE" });
    hidePgyPreview();
    await refresh();
  });

  document.querySelector("#refreshPgyLoginPreview")?.addEventListener("click", () => {
    loadPgyPreview().catch((error) => {
      const feedback = document.querySelector("#pgyLoginPreviewFeedback");
      if (feedback) feedback.textContent = error.message;
    });
  });

  document.querySelector("#pgyLoginPreview")?.addEventListener("click", (event) => {
    clickPgyPreview(event).catch((error) => {
      const feedback = document.querySelector("#pgyLoginPreviewFeedback");
      if (feedback) feedback.textContent = error.message;
    });
  });

  document.querySelector("#logoutAccount")?.addEventListener("click", () => {
    window.XundaoAuth.logout().catch((error) => window.XundaoApp?.showToast(error.message));
  });

  window.addEventListener("xundao:screen", (event) => {
    if (event.detail?.screenId === "settings") refresh().catch((error) => window.XundaoApp?.showToast(error.message));
  });
  window.XundaoAuth?.ready.then((user) => {
    if (!user?.mustChangePassword) return;
    window.setTimeout(() => {
      window.XundaoApp?.switchScreen("settings");
      document.querySelector("#profileSecurity")?.setAttribute("open", "");
      setAccountFeedback("这是初始密码，请先修改后再使用团队功能。", true);
    }, 0);
  });
  window.XundaoProfile = { refresh };
})();
