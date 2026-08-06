(function setupAdmin() {
  const rowsNode = document.querySelector("#adminUserRows");
  const form = document.querySelector("#adminUserForm");
  const feedback = document.querySelector("#adminUserFeedback");
  const sharedPgyFeedback = document.querySelector("#adminSharedPgyFeedback");

  function setFeedback(message, error = false) {
    if (!feedback) return;
    feedback.textContent = message;
    feedback.classList.toggle("is-error", error);
  }

  function dateText(value) {
    return value ? new Date(value).toLocaleString("zh-CN") : "尚未登录";
  }

  function setSharedPgyFeedback(message, error = false) {
    if (!sharedPgyFeedback) return;
    sharedPgyFeedback.textContent = message;
    sharedPgyFeedback.classList.toggle("is-error", error);
  }

  function renderSharedPgy(data) {
    const connection = data.connection || {};
    const allowedRoles = new Set(data.allowedRoles || []);
    const media = document.querySelector("#sharePgyWithMedia");
    const admin = document.querySelector("#sharePgyWithAdmin");
    if (media) media.checked = allowedRoles.has("media");
    if (admin) admin.checked = allowedRoles.has("admin");
    const status = document.querySelector("#adminSharedPgyStatus");
    if (status) {
      status.textContent = connection.connected
        ? `${connection.maskedAccountName || "团队蒲公英账号"}已共享；最近验证：${dateText(connection.lastVerifiedAt)}。`
        : connection.status === "expired"
          ? "团队连接已失效；请在个人中心重新连接后再次共享。"
          : "尚未共享团队蒲公英连接。";
    }
    const revoke = document.querySelector("#revokeSharedPgy");
    if (revoke) revoke.disabled = !connection.connected && connection.status !== "expired";
  }

  async function refreshSharedPgy() {
    const data = await window.XundaoAuth.request("/api/admin/pgy/shared-connection");
    renderSharedPgy(data);
    return data;
  }

  function identityCell(user) {
    const wrapper = document.createElement("div");
    wrapper.className = "user-identity";
    const name = document.createElement("strong");
    name.textContent = user.displayName || "未命名用户";
    const email = document.createElement("small");
    email.textContent = user.email;
    wrapper.append(name, email);
    return wrapper;
  }

  function renderUsers(users) {
    if (!rowsNode) return;
    rowsNode.replaceChildren();
    if (!users.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 5;
      cell.className = "empty-cell";
      cell.textContent = "暂无用户";
      row.append(cell);
      rowsNode.append(row);
      return;
    }
    users.forEach((user) => {
      const row = document.createElement("tr");
      const identity = document.createElement("td");
      identity.append(identityCell(user));
      const role = document.createElement("td");
      role.textContent = user.role === "admin" ? "管理员" : "媒介用户";
      const status = document.createElement("td");
      const statusPill = document.createElement("span");
      statusPill.className = `status-pill ${user.status === "active" ? "ready" : "failed"}`;
      statusPill.textContent = user.status === "active" ? "正常" : "已停用";
      status.append(statusPill);
      const login = document.createElement("td");
      login.textContent = dateText(user.lastLoginAt);
      const action = document.createElement("td");
      const button = document.createElement("button");
      button.type = "button";
      button.className = user.status === "active" ? "text-action danger-text" : "text-action";
      button.textContent = user.status === "active" ? "停用" : "恢复";
      if (user.id === window.XundaoAuth.state.user?.id) {
        button.disabled = true;
        button.title = "不能停用当前登录账号";
      }
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await window.XundaoAuth.request(`/api/admin/users/${encodeURIComponent(user.id)}/status`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ status: user.status === "active" ? "disabled" : "active" }),
          });
          await refreshUsers();
        } catch (error) {
          setFeedback(error.message, true);
        } finally {
          button.disabled = false;
        }
      });
      action.append(button);
      row.append(identity, role, status, login, action);
      rowsNode.append(row);
    });
  }

  async function refreshUsers() {
    const data = await window.XundaoAuth.request("/api/admin/users");
    renderUsers(data.users || []);
    return data.users || [];
  }

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = document.querySelector("#createAdminUser");
    submit.disabled = true;
    setFeedback("");
    try {
      await window.XundaoAuth.request("/api/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: document.querySelector("#adminUserName").value.trim(),
          email: document.querySelector("#adminUserEmail").value.trim(),
          password: document.querySelector("#adminUserPassword").value,
          role: document.querySelector("#adminUserRole").value,
        }),
      });
      form.reset();
      document.querySelector("#adminUserRole").value = "media";
      setFeedback("账号已创建；请通过安全渠道把初始密码交给使用者。");
      await refreshUsers();
    } catch (error) {
      setFeedback(error.message, true);
    } finally {
      submit.disabled = false;
    }
  });

  document.querySelector("#refreshAdminUsers")?.addEventListener("click", () => {
    refreshUsers().catch((error) => setFeedback(error.message, true));
  });

  document.querySelector("#refreshSharedPgy")?.addEventListener("click", () => {
    refreshSharedPgy().catch((error) => setSharedPgyFeedback(error.message, true));
  });

  document.querySelector("#publishSharedPgy")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    setSharedPgyFeedback("");
    try {
      const allowedRoles = [
        document.querySelector("#sharePgyWithMedia")?.checked ? "media" : "",
        document.querySelector("#sharePgyWithAdmin")?.checked ? "admin" : "",
      ].filter(Boolean);
      const data = await window.XundaoAuth.request("/api/admin/pgy/shared-connection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ allowedRoles }),
      });
      renderSharedPgy(data);
      setSharedPgyFeedback("团队连接已更新；获得授权的账号会在采集时自动使用。");
    } catch (error) {
      setSharedPgyFeedback(error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  document.querySelector("#revokeSharedPgy")?.addEventListener("click", async (event) => {
    if (!window.confirm("确定撤销团队蒲公英连接吗？正在使用共享连接的采集将需要重新连接。")) return;
    const button = event.currentTarget;
    button.disabled = true;
    setSharedPgyFeedback("");
    try {
      await window.XundaoAuth.request("/api/admin/pgy/shared-connection", { method: "DELETE" });
      await refreshSharedPgy();
      setSharedPgyFeedback("团队连接已撤销，加密副本已删除。");
    } catch (error) {
      setSharedPgyFeedback(error.message, true);
    } finally {
      button.disabled = false;
    }
  });

  window.addEventListener("xundao:screen", (event) => {
    if (event.detail?.screenId !== "analytics") return;
    if (window.XundaoAuth.state.user?.role === "admin") {
      refreshUsers().catch((error) => setFeedback(error.message, true));
      refreshSharedPgy().catch((error) => setSharedPgyFeedback(error.message, true));
    }
  });

  window.XundaoAuth?.ready.then((user) => {
    const adminButton = document.querySelector("[data-screen='analytics']");
    const isAdmin = Boolean(user && user.role === "admin");
    if (adminButton) adminButton.hidden = !isAdmin;
    const tokenBox = document.querySelector("#analyticsTokenBox");
    if (tokenBox) tokenBox.hidden = true;
    const panel = document.querySelector("#adminUsersPanel");
    if (panel) panel.hidden = !isAdmin;
    const sharedPanel = document.querySelector("#adminSharedPgyPanel");
    if (sharedPanel) sharedPanel.hidden = !isAdmin;
    if (isAdmin) {
      refreshUsers().catch((error) => setFeedback(error.message, true));
      refreshSharedPgy().catch((error) => setSharedPgyFeedback(error.message, true));
    }
  });
})();
