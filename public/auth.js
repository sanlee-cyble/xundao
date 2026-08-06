(function setupAuthentication() {
  const gate = document.querySelector("#authGate");
  const form = document.querySelector("#authForm");
  const errorNode = document.querySelector("#authError");
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });

  const state = {
    user: null,
    authRequired: false,
    mode: "login",
  };

  async function jsonRequest(url, options = {}) {
    const response = await fetch(url, {
      credentials: "same-origin",
      ...options,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "请求失败");
    return data;
  }

  function finish(user) {
    state.user = user;
    gate.hidden = true;
    document.body.classList.remove("auth-locked");
    window.dispatchEvent(new CustomEvent("xundao:auth", { detail: { user } }));
    resolveReady(user);
  }

  function showGate({ setup = false, setupAllowed = true } = {}) {
    state.mode = setup ? "setup" : "login";
    gate.hidden = false;
    document.body.classList.add("auth-locked");
    const title = form?.querySelector("h2");
    const description = form?.querySelector("p");
    const nameField = document.querySelector("#authNameField");
    const password = document.querySelector("#authPassword");
    const submit = document.querySelector("#authSubmit");
    if (title) title.textContent = setup ? "创建寻达管理员" : "登录寻达";
    if (description) {
      description.textContent = setup
        ? setupAllowed
          ? "首次使用请创建管理员；现有任务和蒲公英连接会自动迁移到该账号。"
          : "首次管理员只能在服务器本机创建，请联系部署人员完成初始化。"
        : "登录后只会看到自己的任务与蒲公英连接。";
    }
    nameField?.toggleAttribute("hidden", !setup);
    document.querySelector("#authDisplayName")?.toggleAttribute("required", setup);
    if (password) password.autocomplete = setup ? "new-password" : "current-password";
    if (submit) {
      submit.textContent = setup ? "创建并登录" : "登录";
      submit.disabled = setup && !setupAllowed;
    }
    errorNode.textContent = setup && !setupAllowed ? "当前页面不能完成首次设置。" : "";
    window.setTimeout(() => {
      (setup ? document.querySelector("#authDisplayName") : document.querySelector("#authEmail"))?.focus();
    }, 0);
  }

  async function initialize() {
    try {
      const config = await jsonRequest("/api/auth/config");
      state.authRequired = Boolean(config.authRequired);
      if (config.setupRequired) {
        showGate({ setup: true, setupAllowed: Boolean(config.setupAllowed) });
        return;
      }
      const me = await jsonRequest("/api/auth/me");
      finish(me.user);
    } catch (error) {
      if (!state.authRequired) {
        finish(null);
        return;
      }
      showGate();
    }
  }

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = document.querySelector("#authSubmit");
    button.disabled = true;
    errorNode.textContent = "";
    try {
      const data = await jsonRequest(state.mode === "setup" ? "/api/auth/setup" : "/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: document.querySelector("#authDisplayName")?.value.trim(),
          email: document.querySelector("#authEmail").value,
          password: document.querySelector("#authPassword").value,
        }),
      });
      finish(data.user);
    } catch (error) {
      errorNode.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  window.XundaoAuth = {
    ready,
    state,
    async logout() {
      await jsonRequest("/api/auth/logout", { method: "POST" });
      window.location.reload();
    },
    request: jsonRequest,
  };

  initialize();
})();
