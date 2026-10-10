// 事件处理状态（#298）。由 automation/build_radar_site.py 生成，不要手改产物。
// 权限全部在 Supabase 端（supabase/migrations/20261009_event_status.sql）：
// 访客只读状态；写入只能经 set_event_status()，函数内校验团队白名单。
// 本脚本失败时所有状态位保持 hidden，页面退回无状态的原样。
(function () {
  "use strict";
  var API = "https://wixlszblqhtudzescpey.supabase.co";
  var KEY = "sb_publishable_yX1LpzpsiegRyRH1Uk6VoQ_FwrIq67y";
  var STORE = "policyRadarSession";
  var LABELS = { pending: "待解决", notified: "已通知", irrelevant: "不相关" };
  var ORDER = ["pending", "notified", "irrelevant"];
  var SLOT = "[data-event-status]";
  var authBox = document.querySelector("[data-status-auth]");
  var session = null;
  var statuses = {};
  var authMessage = "";

  function readSession() {
    try {
      var raw = window.localStorage.getItem(STORE);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  function saveSession(value) {
    session = value;
    try {
      if (value) window.localStorage.setItem(STORE, JSON.stringify(value));
      else window.localStorage.removeItem(STORE);
    } catch (error) {
      // 无痕模式等场景存不下：本页仍可用，刷新后需重新登录。
    }
  }

  function emailFromToken(token) {
    try {
      var payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      while (payload.length % 4) payload += "=";
      var bytes = atob(payload);
      var text = decodeURIComponent(Array.prototype.map.call(bytes, function (ch) {
        return "%" + ("0" + ch.charCodeAt(0).toString(16)).slice(-2);
      }).join(""));
      return JSON.parse(text).email || "";
    } catch (error) {
      return "";
    }
  }

  function sessionFrom(data) {
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
      email: (data.user && data.user.email) || emailFromToken(data.access_token)
    };
  }

  // 微软登录回跳时，凭证在 URL hash 里，出错时错误信息可能在 hash 或查询串里；读完立即从地址栏抹掉。
  function oauthErrorText(params) {
    var detail = (params.get("error_description") || "") + " " + (params.get("error_code") || "");
    if (/signup|not allowed/i.test(detail)) return "该账号尚未开通，请联系 lexie";
    if (params.get("error") === "access_denied") return "微软登录未完成（已取消，或需要管理员批准）";
    return "登录失败，请重试";
  }

  function takeSessionFromHash() {
    var hash = window.location.hash.replace(/^#/, "");
    var query = new URLSearchParams(window.location.search);
    if (query.get("error") && query.get("error_description") !== null) {
      authMessage = oauthErrorText(query);
      ["error", "error_code", "error_description"].forEach(function (key) { query.delete(key); });
      var rest = query.toString();
      window.history.replaceState(null, "", window.location.pathname + (rest ? "?" + rest : "") + window.location.hash);
    }
    if (!/(^|&)(access_token|error)=/.test(hash)) return;
    var params = new URLSearchParams(hash);
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    if (params.get("error")) {
      authMessage = oauthErrorText(params);
      return;
    }
    if (params.get("access_token") && params.get("refresh_token")) {
      saveSession(sessionFrom({
        access_token: params.get("access_token"),
        refresh_token: params.get("refresh_token"),
        expires_in: params.get("expires_in")
      }));
    }
  }

  function freshSession() {
    if (!session) return Promise.resolve(null);
    if (session.expires_at - Date.now() > 60000) return Promise.resolve(session);
    return fetch(API + "/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      headers: { apikey: KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refresh_token })
    }).then(function (response) {
      if (response.status === 400 || response.status === 401) {
        saveSession(null);
        return null;
      }
      if (!response.ok) return null;
      return response.json().then(function (data) {
        saveSession(sessionFrom(data));
        return session;
      });
    }).catch(function () {
      return null;
    });
  }

  function loadStatuses() {
    return fetch(API + "/rest/v1/event_status?select=event_id,status,version_key,updated_at", {
      headers: { apikey: KEY }
    }).then(function (response) {
      if (!response.ok) throw new Error("load " + response.status);
      return response.json();
    }).then(function (rows) {
      statuses = {};
      rows.forEach(function (row) { statuses[row.event_id] = row; });
    });
  }

  // 每次现查：时间线筛选会用 JS 生成新的结果行，状态位随之替换。
  function allSlots() {
    return Array.prototype.slice.call(document.querySelectorAll(SLOT));
  }

  // 从未标记过 → 空值（status 为 ""）。标记之后事件又出了新版本（版本数变了），一律视为待解决。
  function effectiveOf(eventId, version) {
    var row = statuses[eventId];
    if (!row) return { status: "", stale: false };
    if (row.version_key !== Number(version)) {
      return { status: "pending", stale: row.status !== "pending" };
    }
    return { status: row.status, stale: false };
  }

  function effective(slot) {
    return effectiveOf(slot.dataset.eventId, slot.dataset.version);
  }

  // 供时间线「处理状态」筛选读取：与状态位同一套口径，筛选结果与卡片显示不会不一致。
  // 状态读取成功后才 ready；读不到时筛选项保持隐藏。
  var api = { ready: false, effectiveOf: effectiveOf };
  window.PolicyRadarStatus = api;

  function announce(reason) {
    document.dispatchEvent(new CustomEvent("policy-radar-status", { detail: { reason: reason } }));
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function renderSlot(slot, errorText) {
    var state = effective(slot);
    slot.textContent = "";
    slot.className = "event-status status-" + (state.status || "unset") + (session ? " editable" : "");
    // 访客视角：没标记过的事件不显示任何东西。
    if (!session && !state.status && !errorText) {
      slot.hidden = true;
      return;
    }
    if (session) {
      // 可操作的控件刻意做成「白底 + 边框 + 状态色圆点」，与左侧不可点的彩色标签区分。
      slot.appendChild(element("span", "status-dot"));
      var select = element("select", "status-select");
      select.setAttribute("aria-label", "处理状态");
      if (!state.status) {
        var placeholder = element("option", "", "选择状态");
        placeholder.value = "";
        placeholder.disabled = true;
        placeholder.hidden = true;
        placeholder.selected = true;
        select.appendChild(placeholder);
      }
      ORDER.forEach(function (key) {
        var option = element("option", "", LABELS[key]);
        option.value = key;
        option.selected = key === state.status;
        select.appendChild(option);
      });
      select.addEventListener("change", function () { saveStatus(slot, select); });
      slot.appendChild(select);
    } else {
      slot.appendChild(element("span", "status-badge", LABELS[state.status]));
    }
    if (state.stale) slot.appendChild(element("span", "status-note stale", "标记后有新版本"));
    if (errorText) slot.appendChild(element("span", "status-note error", errorText));
    slot.hidden = false;
  }

  function renderSlots() {
    allSlots().forEach(function (slot) { renderSlot(slot); });
  }

  function watchNewSlots() {
    if (!window.MutationObserver) return;
    new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        Array.prototype.forEach.call(mutation.addedNodes, function (node) {
          if (node.nodeType !== 1) return;
          if (node.matches(SLOT)) renderSlot(node);
          Array.prototype.forEach.call(node.querySelectorAll(SLOT), function (slot) { renderSlot(slot); });
        });
      });
    }).observe(document.body, { childList: true, subtree: true });
  }

  function saveStatus(slot, select) {
    var eventId = slot.dataset.eventId;
    var version = Number(slot.dataset.version);
    var value = select.value;
    select.disabled = true;
    freshSession().then(function (current) {
      if (!current) throw new Error("auth");
      return fetch(API + "/rest/v1/rpc/set_event_status", {
        method: "POST",
        headers: {
          apikey: KEY,
          Authorization: "Bearer " + current.access_token,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ p_event_id: eventId, p_status: value, p_version_key: version })
      });
    }).then(function (response) {
      // 401：凭证无效或已过期；403：凭证有效但不在团队白名单（set_event_status 内校验）。
      if (response.status === 401) {
        saveSession(null);
        throw new Error("auth");
      }
      if (response.status === 403) throw new Error("denied");
      if (!response.ok) throw new Error("save");
      statuses[eventId] = { event_id: eventId, status: value, version_key: version };
      allSlots().forEach(function (other) {
        if (other.dataset.eventId === eventId) renderSlot(other);
      });
      announce("save");
    }).catch(function (error) {
      var text = error.message === "auth" ? "登录已失效，请重新登录"
        : error.message === "denied" ? "保存失败：当前账号不在团队名单"
        : "保存失败，请稍后重试";
      if (error.message === "auth") {
        renderAuth();
        renderSlots();
      }
      renderSlot(slot, text);
    });
  }

  // 备用登录方式：邮箱 + 密码。账号由 lexie 在 Supabase 后台建，密码私下发给本人（decision-log 2026-10-09）。
  function passwordLogin(button, emailInput, passwordInput, note) {
    var email = emailInput.value.trim().toLowerCase();
    if (!email || !passwordInput.value) return;
    button.disabled = true;
    note.textContent = "登录中…";
    fetch(API + "/auth/v1/token?grant_type=password", {
      method: "POST",
      headers: { apikey: KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email: email, password: passwordInput.value })
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (data) {
        if (response.ok && data.access_token) {
          passwordInput.value = "";
          saveSession(sessionFrom(data));
          renderAuth();
          renderSlots();
          return;
        }
        var code = data.error_code || "";
        note.textContent = response.status === 429 || code === "over_request_rate_limit"
          ? "尝试太频繁，请稍后再试"
          : code === "invalid_credentials" || response.status === 400
            ? "邮箱或密码错误"
            : "登录失败，请稍后再试";
      });
    }).catch(function () {
      note.textContent = "登录失败，请检查网络";
    }).then(function () {
      button.disabled = false;
    });
  }

  // 主登录方式：公司微软账号（Entra ID 单租户，只有 ewp.sg 账号能登录）。
  // 整页跳转到 Supabase 的 authorize 端点，回跳后由 takeSessionFromHash() 取凭证（decision-log 2026-10-10）。
  // login_hint 让微软登录页预填这个邮箱；已登录 M365 的浏览器会直接通过、自动跳回。
  function microsoftLogin(email) {
    var redirect = window.location.origin + window.location.pathname + window.location.search;
    window.location.assign(API + "/auth/v1/authorize?provider=azure&scopes=email"
      + "&login_hint=" + encodeURIComponent(email)
      + "&redirect_to=" + encodeURIComponent(redirect));
  }

  // 只记邮箱（不是凭证），下次打开登录框时预填。
  var EMAIL_STORE = "policyRadarEmail";
  function rememberedEmail() {
    try {
      return window.localStorage.getItem(EMAIL_STORE) || "";
    } catch (error) {
      return "";
    }
  }
  function rememberEmail(email) {
    try {
      window.localStorage.setItem(EMAIL_STORE, email);
    } catch (error) {
      // 存不下就下次重新输入。
    }
  }

  // 浮层默认右对齐「团队登录」；窄屏下导航换行后会伸出左边缘，打开时按视口夹回 16px 边距内。
  function placeLoginForm(form) {
    form.style.right = "";
    if (form.hidden) return;
    var overflow = 16 - form.getBoundingClientRect().left;
    if (overflow > 0) form.style.right = -overflow + "px";
  }

  function renderAuth() {
    if (!authBox) return;
    authBox.textContent = "";
    if (session) {
      authBox.appendChild(element("span", "status-user", session.email || "已登录"));
      var logout = element("button", "status-auth-button", "退出");
      logout.type = "button";
      logout.addEventListener("click", function () {
        var token = session.access_token;
        saveSession(null);
        renderAuth();
        renderSlots();
        fetch(API + "/auth/v1/logout", {
          method: "POST",
          headers: { apikey: KEY, Authorization: "Bearer " + token }
        }).catch(function () {});
      });
      authBox.appendChild(logout);
    } else {
      var toggle = element("button", "status-auth-button", "团队登录");
      toggle.type = "button";
      // 一个邮箱框 + 一个主按钮。默认「微软登录」；「改用密码登录」只是在同一个框下展开密码框，主按钮随之变为「密码登录」。
      var form = element("form", "status-login");
      form.noValidate = true;
      var usePassword = false;
      var input = element("input");
      input.type = "email";
      input.name = "email";
      input.autocomplete = "username";
      input.placeholder = "name@ewp.sg";
      input.value = rememberedEmail();
      input.setAttribute("aria-label", "公司邮箱");
      var password = element("input");
      password.type = "password";
      password.name = "password";
      password.autocomplete = "current-password";
      password.placeholder = "密码";
      password.setAttribute("aria-label", "密码");
      password.hidden = true;
      var submit = element("button", "status-auth-button primary", "微软登录");
      submit.type = "submit";
      var mode = element("button", "status-auth-button link", "改用密码登录");
      mode.type = "button";
      var note = element("span", "status-note", authMessage);
      form.appendChild(input);
      form.appendChild(password);
      form.appendChild(submit);
      form.appendChild(mode);
      form.appendChild(note);
      form.hidden = !authMessage;
      toggle.addEventListener("click", function () {
        form.hidden = !form.hidden;
        placeLoginForm(form);
        if (!form.hidden) (input.value ? submit : input).focus();
      });
      mode.addEventListener("click", function () {
        usePassword = !usePassword;
        password.hidden = !usePassword;
        submit.textContent = usePassword ? "密码登录" : "微软登录";
        mode.textContent = usePassword ? "改用微软登录" : "改用密码登录";
        note.textContent = "";
        (usePassword && input.value ? password : input).focus();
      });
      form.addEventListener("submit", function (event) {
        event.preventDefault();
        var email = input.value.trim().toLowerCase();
        if (!/^[^@\s]+@ewp\.sg$/.test(email)) {
          note.textContent = "请填写 @ewp.sg 公司邮箱";
          input.focus();
          return;
        }
        rememberEmail(email);
        if (usePassword) {
          if (!password.value) {
            note.textContent = "请填写密码";
            password.focus();
            return;
          }
          passwordLogin(submit, input, password, note);
          return;
        }
        submit.disabled = true;
        note.textContent = "正在跳转到微软登录…";
        microsoftLogin(email);
      });
      authBox.appendChild(toggle);
      authBox.appendChild(form);
      authBox.hidden = false;
      placeLoginForm(form);
    }
    authBox.hidden = false;
  }

  takeSessionFromHash();
  if (!session) session = readSession();
  freshSession().then(function () {
    renderAuth();
    return loadStatuses();
  }).then(function () {
    renderSlots();
    watchNewSlots();
    api.ready = true;
    announce("load");
  }).catch(function () {
    // 读不到状态时不渲染任何状态位，避免把「未知」显示成「待解决」。
  });
})();