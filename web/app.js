// --- State ---
let currentStep = 1;
let lastOutputFile = null;
let customPromptText = null;
let lastGeneratedFile = null;
let generatedTextDirty = false;
let chatType = null; // "messages" (chat) or "comments" (channel with posts)
let _sessions = { active: "", sessions: [] };
let _editingSessionName = null;
let _envStatus = null;
const BASE_TITLE = document.title;
const REQUIRED_ENV_LABELS = {
  TG_API_ID: "API ID Telegram",
  TG_API_HASH: "API Hash Telegram",
  OPENAI_API_KEY: "Ключ API OpenAI",
};

// Per-tab session storage
const TAB_SESSION_KEY = "castelet_tab_session";
const TAB_ID_KEY = "castelet_tab_id";

function getTabId() {
  let tabId = sessionStorage.getItem(TAB_ID_KEY);
  if (!tabId) {
    tabId = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
    sessionStorage.setItem(TAB_ID_KEY, tabId);
  }
  return tabId;
}

const _nativeFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  const headers = new Headers(init.headers || {});
  headers.set("X-Tab-Id", getTabId());
  return _nativeFetch(input, { ...init, headers });
};

function getTabSession() {
  const saved = sessionStorage.getItem(TAB_SESSION_KEY);
  return saved || null;
}

function setTabSession(sessionName) {
  if (sessionName) {
    sessionStorage.setItem(TAB_SESSION_KEY, sessionName);
  } else {
    sessionStorage.removeItem(TAB_SESSION_KEY);
  }
  fetch("/api/workspace/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: sessionName || null }),
  }).catch(() => {});
  updateTabSessionIndicator();
  renderSessionsList();
  populateSessionDropdowns();
}

function updateTabSessionIndicator() {
  const indicator = document.getElementById("tab-session-indicator");
  if (!indicator) return;
  
  const tabSession = getTabSession();
  if (!tabSession || !_sessions.sessions.length) {
    indicator.innerHTML = "";
    document.title = BASE_TITLE;
    return;
  }
  
  const session = _sessions.sessions.find(s => s.name === tabSession);
  if (session) {
    const proxyLabel = session.proxy?.ip
      ? `<span class="tab-session-proxy">${escapeHtml(session.proxy.ip)}${session.proxy.port ? `:${escapeHtml(String(session.proxy.port))}` : ""}</span>`
      : "";
    indicator.innerHTML = `<span class="tab-session-name"><span class="tab-session-user">${escapeHtml(session.displayName || session.name)}</span>${proxyLabel}</span>`;
    document.title = `${session.displayName || session.name} | ${BASE_TITLE}`;
  } else {
    document.title = BASE_TITLE;
  }
}

// --- Step Navigation ---
const stepBtns = document.querySelectorAll(".step-btn");
const steps = document.querySelectorAll(".step");

function goToStep(n) {
  currentStep = n;
  stepBtns.forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.step) === n);
  });
  steps.forEach((s) => {
    s.classList.toggle("active", s.id === `step-${n}`);
  });
  if (n === 3) refreshGenerateDropdowns();
  if (n === 4) refreshSendDropdown();
}

stepBtns.forEach((btn) => {
  btn.addEventListener("click", () => goToStep(Number(btn.dataset.step)));
});

// --- Parse mode toggle ---
document.querySelectorAll('input[name="parseMode"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    const isComments = radio.value === "comments" && radio.checked;
    document.querySelectorAll(".messages-opts").forEach((el) => (el.style.display = isComments ? "none" : ""));
    document.querySelectorAll(".comments-opts").forEach((el) => (el.style.display = isComments ? "" : "none"));
  });
});

// --- Env Check ---
function getMissingEnvKeys(keys = Object.keys(REQUIRED_ENV_LABELS)) {
  if (!_envStatus) return [];
  return keys.filter((key) => !_envStatus[key]);
}

function getMissingEnvLabelText(keys) {
  return keys.map((key) => REQUIRED_ENV_LABELS[key] || key).join(", ");
}

function renderEnvWarning(messageHtml = "") {
  const warning = document.getElementById("env-warning");
  if (!warning) return;

  if (!messageHtml) {
    warning.style.display = "none";
    warning.innerHTML = "";
    return;
  }

  warning.innerHTML = messageHtml;
  warning.style.display = "";
}

function ensureEnvKeys(keys, options = {}) {
  if (!_envStatus) return true;
  const missing = getMissingEnvKeys(keys);
  if (!missing.length) return true;

  const message = `Отсутствуют настройки: ${getMissingEnvLabelText(missing)}. Добавьте их в .env и перезапустите сервер.`;

  if (options.statusElId) {
    const statusEl = document.getElementById(options.statusElId);
    if (statusEl) statusEl.textContent = message;
  }

  if (options.logPanelId) {
    const panel = document.getElementById(options.logPanelId);
    if (panel) {
      panel.innerHTML = "";
      addStatusLine(panel, message, "error");
    }
  }

  return false;
}

async function checkEnv() {
  try {
    const res = await fetch("/api/env");
    const env = await res.json();
    _envStatus = {
      TG_API_ID: !!env.TG_API_ID,
      TG_API_HASH: !!env.TG_API_HASH,
      OPENAI_API_KEY: !!env.OPENAI_API_KEY,
    };

    const missing = getMissingEnvKeys();
    if (!missing.length) {
      renderEnvWarning("");
    } else {
      const labels = getMissingEnvLabelText(missing);
      renderEnvWarning(
        `<div class="env-warning-title">Отсутствуют обязательные ключи</div>
         <div class="env-warning-text">${escapeHtml(labels)}</div>
         <div class="env-warning-hint">Добавьте ключи в <code>.env</code> и перезапустите сервер.</div>`
      );
    }

    await loadSessions();
  } catch (err) {
    _envStatus = null;
    renderEnvWarning(
      `<div class="env-warning-title">Не удалось проверить ключи окружения</div>
       <div class="env-warning-hint">Проверьте, что сервер запущен и файл <code>.env</code> доступен.</div>`
    );
  }
}

// --- Sessions ---
async function loadSessions() {
  try {
    const res = await fetch("/api/sessions");
    _sessions = await res.json();
    
    // Initialize tab session if not set
    let tabSession = getTabSession();
    if (!tabSession && _sessions.sessions.length > 0) {
      // Default to the global active session or first session
      tabSession = _sessions.active || _sessions.sessions[0].name;
      setTabSession(tabSession);
    } else if (tabSession && !_sessions.sessions.find(s => s.name === tabSession)) {
      // Tab session no longer exists, switch to first available
      tabSession = _sessions.sessions.length > 0 ? _sessions.sessions[0].name : null;
      setTabSession(tabSession);
    }
    
    updateTabSessionIndicator();
    renderSessionsList();
    populateSessionDropdowns();
  } catch {
    _sessions = { active: "", sessions: [] };
  }
}

function renderSessionsList() {
  const container = document.getElementById("sessions-list");
  const summary = document.getElementById("sessions-summary");
  const tabSession = getTabSession();
  if (summary) {
    const sessionsCount = _sessions.sessions.length;
    const activeSession = _sessions.sessions.find((s) => s.name === tabSession);
    const activeLabel = activeSession ? ` • ${activeSession.displayName || activeSession.name}` : "";
    summary.textContent = `${sessionsCount} аккаунт${sessionsCount === 1 ? "" : sessionsCount < 5 ? "а" : "ов"}${activeLabel}`;
  }

  if (!_sessions.sessions.length) {
    container.innerHTML = '<p class="sessions-empty">Нет добавленных аккаунтов.</p>';
    return;
  }
  
  container.innerHTML = _sessions.sessions
    .map((s) => {
      const isTabActive = s.name === tabSession;
      const encodedName = encodeURIComponent(s.name);
      return `<div class="session-item ${isTabActive ? "session-active" : ""}">
        <div class="session-info">
          <span class="session-name">${escapeHtml(s.displayName || s.name)}</span>
          ${isTabActive ? '<span class="session-badge">активная в этой вкладке</span>' : ""}
          ${s.proxy ? '<span class="session-proxy-badge">proxy</span>' : ""}
          ${s.proxy?.ip ? `<span class="session-proxy-ip">${escapeHtml(s.proxy.ip)}${s.proxy.port ? `:${escapeHtml(String(s.proxy.port))}` : ""}</span>` : ""}
          ${s.phone ? `<span class="session-phone">${escapeHtml(s.phone)}</span>` : ""}
        </div>
        <div class="session-actions">
          ${!isTabActive ? `<button class="session-activate-btn" onclick="activateSessionInTab('${encodedName}')">Использовать в этой вкладке</button>` : ""}
          <button class="session-activate-btn" onclick="openSessionEdit('${encodedName}')">Редактировать</button>
          <button class="session-delete-btn" onclick="removeSession('${encodedName}')">Удалить</button>
        </div>
      </div>`;
    })
    .join("");
}

function populateSessionDropdowns() {
  const selects = [
    document.getElementById("parse-session"),
    document.getElementById("send-session"),
  ];
  const groups = [
    document.getElementById("parse-session-group"),
    document.getElementById("send-session-group"),
  ];

  const show = _sessions.sessions.length > 0;
  const tabSession = getTabSession();

  for (let i = 0; i < selects.length; i++) {
    groups[i].style.display = show ? "" : "none";
    selects[i].innerHTML = _sessions.sessions
      .map(
        (s) =>
          `<option value="${escapeHtml(s.name)}" ${s.name === tabSession ? "selected" : ""}>${escapeHtml(s.displayName || s.name)}</option>`
      )
      .join("");
    
    // Listen for dropdown changes to update tab session
    selects[i].onchange = (e) => {
      setTabSession(e.target.value);
    };
  }
}

function activateSessionInTab(encodedName) {
  setTabSession(decodeURIComponent(encodedName));
}

async function removeSession(encodedName) {
  const name = decodeURIComponent(encodedName);
  if (!confirm(`Удалить сессию «${name}»?`)) return;
  try {
    await fetch(`/api/sessions/${encodeURIComponent(name)}`, { method: "DELETE" });
    // If deleted session was the active tab session, clear it
    if (getTabSession() === name) {
      setTabSession(null);
    }
    await loadSessions();
    checkEnv();
  } catch {
    // ignore
  }
}

function toggleEditProxy() {
  const checked = document.getElementById("edit-proxy-enabled").checked;
  document.getElementById("edit-proxy-fields").style.display = checked ? "" : "none";
}

function onEditProxyTypeChange() {
  const val = document.getElementById("edit-proxy-type").value;
  document.getElementById("edit-proxy-secret-group").style.display = val === "mtproto" ? "" : "none";
}

function getEditProxyConfig() {
  if (!document.getElementById("edit-proxy-enabled").checked) return undefined;
  const type = document.getElementById("edit-proxy-type").value;
  const ip = document.getElementById("edit-proxy-host").value.trim();
  const port = parseInt(document.getElementById("edit-proxy-port").value, 10);
  if (!ip || !port) return undefined;

  const username = document.getElementById("edit-proxy-username").value.trim() || undefined;
  const password = document.getElementById("edit-proxy-password").value.trim() || undefined;

  if (type === "mtproto") {
    const secret = document.getElementById("edit-proxy-secret").value.trim();
    if (!secret) return undefined;
    return { ip, port, username, password, secret, MTProxy: true };
  }
  return { ip, port, username, password, socksType: parseInt(type, 10) };
}

function openSessionEdit(encodedName) {
  const name = decodeURIComponent(encodedName);
  const session = _sessions.sessions.find((s) => s.name === name);
  if (!session) return;

  _editingSessionName = name;
  document.getElementById("new-session-form").style.display = "none";
  document.getElementById("add-session-btn").style.display = "none";
  document.getElementById("edit-session-form").style.display = "";
  document.getElementById("edit-session-name-label").textContent = `Сессия: ${name}`;
  document.getElementById("edit-session-display-name").value = session.displayName || "";
  document.getElementById("edit-session-phone").value = session.phone || "";

  const hasProxy = !!session.proxy;
  document.getElementById("edit-proxy-enabled").checked = hasProxy;
  document.getElementById("edit-proxy-fields").style.display = hasProxy ? "" : "none";

  if (!hasProxy) {
    document.getElementById("edit-proxy-type").value = "5";
    document.getElementById("edit-proxy-host").value = "";
    document.getElementById("edit-proxy-port").value = "";
    document.getElementById("edit-proxy-username").value = "";
    document.getElementById("edit-proxy-password").value = "";
    document.getElementById("edit-proxy-secret").value = "";
    document.getElementById("edit-proxy-secret-group").style.display = "none";
    return;
  }

  if (session.proxy.MTProxy) {
    document.getElementById("edit-proxy-type").value = "mtproto";
    document.getElementById("edit-proxy-secret-group").style.display = "";
    document.getElementById("edit-proxy-secret").value = session.proxy.secret || "";
  } else {
    document.getElementById("edit-proxy-type").value = String(session.proxy.socksType || 5);
    document.getElementById("edit-proxy-secret-group").style.display = "none";
    document.getElementById("edit-proxy-secret").value = "";
  }
  document.getElementById("edit-proxy-host").value = session.proxy.ip || "";
  document.getElementById("edit-proxy-port").value = String(session.proxy.port || "");
  document.getElementById("edit-proxy-username").value = session.proxy.username || "";
  document.getElementById("edit-proxy-password").value = session.proxy.password || "";
}

function cancelSessionEdit() {
  _editingSessionName = null;
  document.getElementById("edit-session-form").style.display = "none";
  document.getElementById("add-session-btn").style.display = "";
}

async function saveSessionEdit() {
  if (!_editingSessionName) return;
  const saveBtn = document.getElementById("edit-session-save-btn");
  saveBtn.disabled = true;
  saveBtn.textContent = "Сохранение...";

  const displayName = document.getElementById("edit-session-display-name").value.trim();
  const phone = document.getElementById("edit-session-phone").value.trim();
  const proxy = getEditProxyConfig();
  const clearProxy = !document.getElementById("edit-proxy-enabled").checked;
  const body = { displayName, phone, clearProxy };
  if (proxy) body.proxy = proxy;

  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(_editingSessionName)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) {
      alert(data.error || "Не удалось сохранить изменения");
      return;
    }
    await loadSessions();
    cancelSessionEdit();
  } catch {
    alert("Не удалось сохранить изменения");
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Сохранить";
  }
}

function startNewSession() {
  document.getElementById("edit-session-form").style.display = "none";
  document.getElementById("new-session-form").style.display = "";
  document.getElementById("add-session-btn").style.display = "none";
  document.getElementById("new-session-name").value = "";
  document.getElementById("new-session-name").focus();
}

function cancelNewSession() {
  _editingSessionName = null;
  document.getElementById("edit-session-form").style.display = "none";
  document.getElementById("new-session-form").style.display = "none";
  document.getElementById("add-session-btn").style.display = "";
  document.getElementById("auth-input-group").style.display = "none";
  document.getElementById("auth-start-btn").style.display = "";
  document.getElementById("auth-start-btn").disabled = false;
  document.getElementById("auth-start-btn").textContent = "Войти в Telegram";
  document.getElementById("auth-status").textContent = "Подключите аккаунт Telegram.";
  resetProxyForm();
  fetch("/api/auth/cancel", { method: "POST" }).catch(() => {});
}

// --- Proxy ---
function toggleProxy() {
  const checked = document.getElementById("proxy-enabled").checked;
  document.getElementById("proxy-fields").style.display = checked ? "" : "none";
  if (!checked) {
    document.getElementById("proxy-test-status").textContent = "";
    document.getElementById("proxy-test-status").className = "";
  }
}

function onProxyTypeChange() {
  const val = document.getElementById("proxy-type").value;
  document.getElementById("proxy-secret-group").style.display = val === "mtproto" ? "" : "none";
}

function getProxyConfig() {
  if (!document.getElementById("proxy-enabled").checked) return undefined;
  const type = document.getElementById("proxy-type").value;
  const ip = document.getElementById("proxy-host").value.trim();
  const port = parseInt(document.getElementById("proxy-port").value, 10);
  if (!ip || !port) return undefined;

  const username = document.getElementById("proxy-username").value.trim() || undefined;
  const password = document.getElementById("proxy-password").value.trim() || undefined;

  if (type === "mtproto") {
    const secret = document.getElementById("proxy-secret").value.trim();
    if (!secret) return undefined;
    return { ip, port, username, password, secret, MTProxy: true };
  }
  return { ip, port, username, password, socksType: parseInt(type, 10) };
}

async function testProxy() {
  const proxy = getProxyConfig();
  const status = document.getElementById("proxy-test-status");
  if (!proxy) {
    status.textContent = "Заполните хост и порт";
    status.className = "proxy-fail";
    return;
  }

  const btn = document.querySelector(".proxy-test-btn");
  btn.disabled = true;
  status.textContent = "Проверка...";
  status.className = "";

  try {
    const res = await fetch("/api/proxy/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ proxy }),
    });
    const data = await res.json();
    if (data.ok) {
      status.textContent = "Прокси доступен";
      status.className = "proxy-ok";
    } else {
      status.textContent = data.error || "Прокси недоступен";
      status.className = "proxy-fail";
    }
  } catch {
    status.textContent = "Ошибка соединения с сервером";
    status.className = "proxy-fail";
  }
  btn.disabled = false;
}

function resetProxyForm() {
  document.getElementById("proxy-enabled").checked = false;
  document.getElementById("proxy-fields").style.display = "none";
  document.getElementById("proxy-type").value = "5";
  document.getElementById("proxy-host").value = "";
  document.getElementById("proxy-port").value = "";
  document.getElementById("proxy-username").value = "";
  document.getElementById("proxy-password").value = "";
  document.getElementById("proxy-secret").value = "";
  document.getElementById("proxy-secret-group").style.display = "none";
  document.getElementById("proxy-test-status").textContent = "";
  document.getElementById("proxy-test-status").className = "";
}

// --- Auth ---
async function startAuthWithName() {
  if (!ensureEnvKeys(["TG_API_ID", "TG_API_HASH"], { statusElId: "auth-status" })) {
    return;
  }

  const nameInput = document.getElementById("new-session-name");
  const sessionName = nameInput.value.trim().toLowerCase() || "default";
  const btn = document.getElementById("auth-start-btn");
  btn.disabled = true;
  btn.textContent = "Подключение...";

  try {
    await fetch("/api/auth/cancel", { method: "POST" });
    const proxy = getProxyConfig();
    const authBody = { sessionName };
    if (proxy) authBody.proxy = proxy;
    const res = await fetch("/api/auth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(authBody),
    });
    const data = await res.json();
    if (data.error) {
      document.getElementById("auth-status").textContent = "Произошла ошибка: " + data.error;
      btn.disabled = false;
      btn.textContent = "Войти в Telegram";
      return;
    }
    showAuthStep(data.step);
  } catch (err) {
    document.getElementById("auth-status").textContent = "Не удалось подключиться к серверу.";
    btn.disabled = false;
    btn.textContent = "Войти в Telegram";
  }
}

function showAuthStep(step) {
  const statusEl = document.getElementById("auth-status");
  const inputGroup = document.getElementById("auth-input-group");
  const startBtn = document.getElementById("auth-start-btn");
  const label = document.getElementById("auth-label");
  const input = document.getElementById("auth-input");

  if (step === "done") {
    statusEl.textContent = "Вы авторизованы! Сессия сохранена.";
    inputGroup.style.display = "none";
    startBtn.style.display = "none";
    // Refresh sessions and hide the form
    loadSessions().then(() => {
      checkEnv();
      // Switch to the newly created session in this tab
      const sessions = _sessions.sessions;
      if (sessions.length > 0) {
        const newestSession = sessions[sessions.length - 1];
        setTabSession(newestSession.name);
      }
      setTimeout(() => {
        cancelNewSession();
      }, 1500);
    });
    return;
  }

  startBtn.style.display = "none";
  inputGroup.style.display = "flex";
  input.value = "";
  input.focus();

  const labels = {
    phone: "Номер телефона (с кодом страны):",
    code: "Введите код из Telegram:",
    password: "Введите пароль двухфакторной аутентификации:",
  };
  label.textContent = labels[step] || step + ":";

  const statuses = {
    phone: "Введите номер телефона Telegram для начала.",
    code: "Код подтверждения отправлен в ваш Telegram.",
    password: "На вашем аккаунте включена двухфакторная аутентификация.",
  };
  statusEl.textContent = statuses[step] || "";
}

async function submitAuth() {
  const input = document.getElementById("auth-input");
  const value = input.value.trim();
  if (!value) return;

  const btn = document.getElementById("auth-submit-btn");
  btn.disabled = true;

  try {
    const res = await fetch("/api/auth/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value }),
    });
    const data = await res.json();
    if (data.error) {
      document.getElementById("auth-status").textContent = "Произошла ошибка: " + data.error;
    } else {
      showAuthStep(data.step);
    }
  } catch (err) {
    document.getElementById("auth-status").textContent = "Запрос не удался. Попробуйте ещё раз.";
  }

  btn.disabled = false;
}

document.getElementById("auth-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitAuth();
});

// --- Friendly message transforms ---
// Returns { text, type } or null to skip the line entirely.
// type: "status" (neutral), "success", "warning", "detail", "skip"
function friendlyLine(raw, channel) {
  // Skip blank lines
  if (!raw.trim()) return null;

  // --- Parser stdout ---
  let m;

  m = raw.match(/^Fetching (\d+) messages from "(.+)"\.\.\.$/);
  if (m) return { text: `Сбор до ${m[1]} сообщений из «${m[2]}»...`, type: "status" };

  m = raw.match(/^Fetching comments from "(.+)" \((\d+) posts?, up to (\d+) comments each\)\.\.\.$/);
  if (m) return { text: `Чтение комментариев из «${m[1]}» (${m[2]} постов, до ${m[3]} комментариев)...`, type: "status" };

  m = raw.match(/^Post (\d+): (\d+) comments?$/);
  if (m) return { text: `Найдено ${m[2]} комментариев к посту #${m[1]}`, type: "detail" };

  m = raw.match(/^Collected (\d+) messages\.$/);
  if (m) return { text: `Готово! Собрано ${m[1]} сообщений.`, type: "success" };

  m = raw.match(/^Collected comments from (\d+) posts\.$/);
  if (m) return { text: `Готово! Собраны комментарии из ${m[1]} постов.`, type: "success" };

  // --- Generator stdout ---
  m = raw.match(/^Loaded .+ \((.+)\)$/);
  if (m) return { text: `Данные загружены (${m[1]})`, type: "status" };

  m = raw.match(/^Using prompt from .+$/);
  if (m) return { text: "Промпт загружен", type: "status" };

  m = raw.match(/^Calling (.+)\.\.\.$/);
  if (m) return { text: `Генерация текста через ${m[1]}... это может занять время.`, type: "status" };

  if (raw.startsWith("Generated text:")) return { text: "Текст сгенерирован!", type: "success" };

  // Skip the actual generated text body in the log (it's shown in the preview panel)
  m = raw.match(/^Saved: (.+)$/);
  if (m) return { text: "Результаты сохранены.", type: "success" };

  // --- Sender stdout ---
  m = raw.match(/^Using latest post #(\d+)$/);
  if (m) return { text: `Цель: последний пост (#${m[1]})`, type: "status" };

  m = raw.match(/^Split message .+ into (\d+) chunks\.$/);
  if (m) return { text: `Сообщение длинное — отправка в ${m[1]} частях.`, type: "detail" };

  m = raw.match(/^Sending (comment|message) to .+$/);
  if (m) return { text: m[1] === "comment" ? "Публикация комментария..." : "Отправка сообщения...", type: "status" };

  m = raw.match(/^Sent (comment|message)/);
  if (m) return { text: m[1] === "comment" ? "Комментарий опубликован!" : "Сообщение отправлено!", type: "success" };

  m = raw.match(/^Waiting (\d+)ms\.\.\.$/);
  if (m) return { text: `Короткая пауза перед следующей отправкой...`, type: "detail" };

  if (raw === "All messages sent.") return { text: "Все сообщения успешно отправлены!", type: "success" };

  // --- Retries (from stderr typically, but also stdout) ---
  m = raw.match(/^Retry.+waiting (\d+)ms/i);
  if (m) return { text: `Сбой соединения — повторная попытка...`, type: "warning" };

  m = raw.match(/^Retrying comments for post (\d+)/);
  if (m) return { text: `Повторная загрузка комментариев к посту #${m[1]}...`, type: "warning" };

  m = raw.match(/^Skipping comments for post (\d+): (.+)$/);
  if (m) return { text: `Не удалось загрузить комментарии к посту #${m[1]}: ${m[2]}`, type: "warning" };

  // --- Errors ---
  m = raw.match(/^Fatal error: (.+)$/);
  if (m) return { text: `Ошибка: ${m[1]}`, type: "error" };

  m = raw.match(/^Error: (.+)$/);
  if (m) return { text: `Ошибка: ${m[1]}`, type: "error" };

  if (raw.match(/^No posts found in channel/)) return { text: "В канале не найдено постов.", type: "warning" };

  return null; // skip anything else (GramJS noise, etc.)
}

function friendlyStderr(raw) {
  if (!raw.trim()) return null;

  // Skip GramJS/internal noise
  if (raw.match(/^\[.+\]/) || raw.match(/^Unhandled/) || raw.match(/^node:/)) return null;
  if (raw.match(/^WARNING/i)) return null;
  if (raw.match(/^\(node:\d+\)/)) return null;

  let m;
  m = raw.match(/^Fatal error: (.+)$/);
  if (m) return { text: `Ошибка: ${m[1]}`, type: "error" };

  m = raw.match(/^Error: (.+)$/);
  if (m) return { text: `Ошибка: ${m[1]}`, type: "error" };

  m = raw.match(/^Retry/i);
  if (m) return { text: "Сбой соединения — повторная попытка...", type: "warning" };

  // Show remaining stderr only if it looks meaningful (not GramJS internals)
  if (raw.length > 5 && !raw.match(/MTProto|BigInt|BufferError|net\.|timeout/i)) {
    return { text: raw, type: "warning" };
  }

  return null;
}

function addStatusLine(panel, text, type) {
  const div = document.createElement("div");
  div.className = `status-line status-${type}`;
  div.textContent = text;
  panel.appendChild(div);
  panel.scrollTop = panel.scrollHeight;
}

// --- SSE Log Streaming ---
function streamJob(jobId, logPanelId, onOutputFile, onDone, onRawStdout) {
  const panel = document.getElementById(logPanelId);
  panel.innerHTML = "";

  // Show initial spinner
  addStatusLine(panel, "Запуск...", "status");

  const source = new EventSource(`/api/stream/${jobId}?tabId=${encodeURIComponent(getTabId())}`);

  source.addEventListener("stdout", (e) => {
    const line = JSON.parse(e.data);
    if (onRawStdout) onRawStdout(line);
    const friendly = friendlyLine(line, "stdout");
    if (friendly) addStatusLine(panel, friendly.text, friendly.type);
  });

  source.addEventListener("stderr", (e) => {
    const line = JSON.parse(e.data);
    const friendly = friendlyStderr(line);
    if (friendly) addStatusLine(panel, friendly.text, friendly.type);
  });

  source.addEventListener("output_file", (e) => {
    const file = JSON.parse(e.data);
    if (onOutputFile) onOutputFile(file);
  });

  source.addEventListener("exit", (e) => {
    const code = JSON.parse(e.data);
    if (code === "0" || code === 0) {
      addStatusLine(panel, "Готово!", "success");
    } else {
      addStatusLine(panel, "Что-то пошло не так. Проверьте настройки и попробуйте снова.", "error");
    }
    source.close();
    if (onDone) onDone(Number(code));
  });

  source.onerror = () => {
    source.close();
    addStatusLine(panel, "Потеряно соединение с сервером.", "error");
  };

  return source;
}

// --- Parse Results Viewer ---
function renderParseResults(data) {
  const container = document.getElementById("parse-results-content");
  container.innerHTML = "";

  // Messages: type can be "group", "messages", etc. — anything with a messages array
  if (Array.isArray(data.messages)) {
    data.messages.forEach((msg) => {
      const div = document.createElement("div");
      div.className = "result-message";
      const sender = msg.senderName || msg.sender || "?";
      const date = msg.date ? new Date(msg.date).toLocaleString("ru-RU") : "";
      const text = msg.text || "";
      const replyHtml = msg.replyToMsgId
        ? `<span class="result-reply">↩ #${msg.replyToMsgId}</span> `
        : "";
      div.innerHTML =
        replyHtml +
        `<span class="result-meta">[${escapeHtml(sender)}]` +
        (date ? ` <span class="result-date">(${date})</span>` : "") +
        `:</span> <span class="result-text">${escapeHtml(text)}</span>`;
      container.appendChild(div);
    });
  } else if (data.type === "channel_comments" && Array.isArray(data.posts)) {
    data.posts.forEach((post) => {
      const postDiv = document.createElement("div");
      postDiv.className = "result-post";
      const postText = post.postText || post.text || "(без текста)";
      const postId = post.postId || post.id || "?";
      const mediaTag = post.postMedia
        ? ` <span class="result-media">[${post.postMedia.type || "media"}]</span>`
        : "";
      postDiv.innerHTML =
        `<div class="result-post-header">Пост #${postId}${mediaTag}: ${escapeHtml(postText.slice(0, 200))}${postText.length > 200 ? "..." : ""}</div>`;
      if (Array.isArray(post.comments)) {
        post.comments.forEach((c) => {
          const cDiv = document.createElement("div");
          cDiv.className = "result-message result-comment";
          const sender = c.senderName || c.sender || "?";
          const date = c.date ? new Date(c.date).toLocaleString("ru-RU") : "";
          const text = c.text || "";
          const replyHtml = c.replyToMsgId
            ? `<span class="result-reply">↩ #${c.replyToMsgId}</span> `
            : "";
          cDiv.innerHTML =
            replyHtml +
            `<span class="result-meta">[${escapeHtml(sender)}]` +
            (date ? ` <span class="result-date">(${date})</span>` : "") +
            `:</span> <span class="result-text">${escapeHtml(text)}</span>`;
          postDiv.appendChild(cDiv);
        });
      }
      container.appendChild(postDiv);
    });
  } else {
    container.innerHTML = '<div class="result-message"><span class="result-text">Нет данных для отображения.</span></div>';
  }
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

async function showParseResults() {
  if (!lastOutputFile) return;
  const panel = document.getElementById("parse-results");
  const content = document.getElementById("parse-results-content");
  const toggle = document.getElementById("parse-results-toggle");

  panel.style.display = "";

  toggle.onclick = () => {
    const open = content.style.display !== "none";
    content.style.display = open ? "none" : "";
    toggle.textContent = open
      ? "Показать собранные данные \u25BE"
      : "Скрыть собранные данные \u25B4";
  };

  try {
    const res = await fetch(`/api/files/data/${encodeURIComponent(lastOutputFile)}`);
    const data = await res.json();
    content.style.display = "";
    toggle.textContent = "Скрыть собранные данные \u25B4";
    renderParseResults(data);
  } catch {
    content.innerHTML = '<div class="result-message"><span class="result-text">Не удалось загрузить данные.</span></div>';
    content.style.display = "";
    toggle.textContent = "Скрыть собранные данные \u25B4";
  }
}

// --- Parse ---
async function runParse(e) {
  e.preventDefault();
  if (!ensureEnvKeys(["TG_API_ID", "TG_API_HASH"], { logPanelId: "parse-log" })) {
    return false;
  }

  const mode = document.querySelector('input[name="parseMode"]:checked').value;
  chatType = mode; // save chat type for later steps
  const chatId = document.getElementById("chatId").value.trim();
  if (!chatId) return false;

  const body = { mode, chatId };
  if (mode === "messages") {
    body.limit = Number(document.getElementById("parseLimit").value);
  } else {
    body.posts = Number(document.getElementById("parsePosts").value);
    body.commentsPerPost = Number(document.getElementById("parseComments").value);
  }
  // Always use the tab's active session
  const tabSession = getTabSession();
  if (tabSession) {
    body.session = tabSession;
  } else {
    const parseSession = document.getElementById("parse-session").value;
    if (parseSession) body.session = parseSession;
  }

  const btn = document.getElementById("parse-btn");
  btn.disabled = true;
  btn.textContent = "Сбор данных...";
  document.getElementById("parse-continue").style.display = "none";
  document.getElementById("parse-results").style.display = "none";

  try {
    const res = await fetch("/api/run/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) {
      const panel = document.getElementById("parse-log");
      panel.innerHTML = "";
      addStatusLine(panel, "Ошибка: " + data.error, "error");
      btn.disabled = false;
      btn.textContent = "Собрать";
      return false;
    }

    streamJob(
      data.jobId,
      "parse-log",
      (file) => {
        lastOutputFile = file.split("/").pop();
      },
      (code) => {
        btn.disabled = false;
        btn.textContent = "Собрать";
        if (code === 0 && lastOutputFile) {
          document.getElementById("parse-continue").style.display = "";
          showParseResults();
        }
      }
    );
  } catch (err) {
    const panel = document.getElementById("parse-log");
    panel.innerHTML = "";
    addStatusLine(panel, "Не удалось запустить. Сервер работает?", "error");
    btn.disabled = false;
    btn.textContent = "Собрать";
  }
  return false;
}

// --- Generate ---
let _dataFiles = [];
let _promptFiles = [];

async function refreshGenerateDropdowns() {
  const [dataRes, promptRes] = await Promise.all([
    fetch("/api/files/data"),
    fetch("/api/files/prompts"),
  ]);
  _dataFiles = await dataRes.json();
  _promptFiles = await promptRes.json();

  if (_promptFiles.length > 0) loadPromptPreview(_promptFiles[0].name);
}

async function loadPromptPreview(filename) {
  try {
    const res = await fetch(`/api/files/prompts/${encodeURIComponent(filename)}`);
    const text = await res.text();
    document.getElementById("promptPreview").value = text;
    customPromptText = null;
    document.getElementById("promptReset").style.display = "none";
  } catch {
    document.getElementById("promptPreview").value = "Не удалось загрузить предпросмотр.";
  }
}

document.getElementById("promptPreview").addEventListener("input", () => {
  customPromptText = document.getElementById("promptPreview").value;
  document.getElementById("promptReset").style.display = "";
});

document.getElementById("promptReset").addEventListener("click", () => {
  if (_promptFiles.length > 0) loadPromptPreview(_promptFiles[0].name);
});

async function runGenerate(e) {
  e.preventDefault();
  if (!ensureEnvKeys(["OPENAI_API_KEY"], { logPanelId: "generate-log" })) {
    return false;
  }

  // Auto-select: use last parsed file or the most recent data file
  const inputFile = lastOutputFile || (_dataFiles.length > 0 ? _dataFiles[0].name : null);
  const promptFile = _promptFiles.length > 0 ? _promptFiles[0].name : null;
  if (!inputFile || !promptFile) return false;

  const btn = document.getElementById("generate-btn");
  const loading = document.getElementById("generate-loading");
  btn.disabled = true;
  btn.textContent = "Генерация...";
  document.getElementById("generate-actions").style.display = "none";
  document.getElementById("generate-results").style.display = "none";
  document.getElementById("saveGenerated").style.display = "none";
  generatedTextDirty = false;
  loading.style.display = "none";

  try {
    const res = await fetch("/api/run/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        customPromptText
          ? { inputFile, promptFile, customPrompt: customPromptText }
          : { inputFile, promptFile }
      ),
    });
    const data = await res.json();
    if (data.error) {
      const panel = document.getElementById("generate-log");
      panel.innerHTML = "";
      addStatusLine(panel, "Ошибка: " + data.error, "error");
      btn.disabled = false;
      btn.textContent = "Сгенерировать";
      return false;
    }

    let showedLoading = false;

    streamJob(
      data.jobId,
      "generate-log",
      (file) => {
        lastOutputFile = file.split("/").pop();
        lastGeneratedFile = lastOutputFile;
      },
      (code) => {
        loading.style.display = "none";
        btn.disabled = false;
        btn.textContent = "Сгенерировать";
        if (code === 0 && lastOutputFile) {
          document.getElementById("generate-actions").style.display = "";
          showGeneratedText(lastOutputFile);
        }
      },
      (raw) => {
        // Show loading card when AI call begins
        if (!showedLoading && raw.match(/^Calling .+\.\.\.$/)) {
          showedLoading = true;
          loading.style.display = "flex";
        }
        // Hide loading when text comes back
        if (showedLoading && raw.startsWith("Generated text:")) {
          loading.style.display = "none";
        }
      }
    );
  } catch (err) {
    loading.style.display = "none";
    const panel = document.getElementById("generate-log");
    panel.innerHTML = "";
    addStatusLine(panel, "Не удалось запустить. Сервер работает?", "error");
    btn.disabled = false;
    btn.textContent = "Сгенерировать";
  }
  return false;
}

async function showGeneratedText(filename) {
  const panel = document.getElementById("generate-results");
  const content = document.getElementById("generate-results-content");
  const saveBtn = document.getElementById("saveGenerated");

  lastGeneratedFile = filename;
  generatedTextDirty = false;
  saveBtn.style.display = "none";
  panel.style.display = "";
  content.innerHTML = "";

  try {
    const res = await fetch(`/api/files/data/${encodeURIComponent(filename)}`);
    const data = await res.json();

    if (data.generatedTexts && data.generatedTexts.length > 0) {
      data.generatedTexts.forEach((item, idx) => {
        const div = document.createElement("div");
        div.className = "generated-text-item";
        if (data.generatedTexts.length > 1) {
          const header = document.createElement("div");
          header.className = "generated-text-header";
          header.textContent = `Сообщение ${idx + 1} \u2192 ${item.targetId}`;
          div.appendChild(header);
        }
        const ta = document.createElement("textarea");
        ta.className = "generated-text-editor";
        ta.value = item.text;
        ta.dataset.index = idx;
        ta.dataset.targetId = item.targetId;
        ta.addEventListener("input", () => {
          generatedTextDirty = true;
          saveBtn.style.display = "";
        });
        // Auto-size height to content
        ta.rows = Math.min(20, Math.max(4, item.text.split("\n").length + 1));
        div.appendChild(ta);
        content.appendChild(div);
      });
    } else {
      content.innerHTML = '<div class="generated-text-item"><div class="generated-text-header">Нет сгенерированного текста.</div></div>';
    }
  } catch {
    content.innerHTML = '<div class="generated-text-item"><div class="generated-text-header">Не удалось загрузить данные.</div></div>';
  }
}

async function saveGeneratedText() {
  if (!lastGeneratedFile) return;
  const btn = document.getElementById("saveGenerated");
  const editors = document.querySelectorAll("#generate-results-content .generated-text-editor");

  const generatedTexts = [];
  editors.forEach((ta) => {
    generatedTexts.push({ targetId: ta.dataset.targetId, text: ta.value });
  });

  btn.disabled = true;
  btn.textContent = "Сохранение...";

  try {
    const res = await fetch(`/api/files/data/${encodeURIComponent(lastGeneratedFile)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generatedTexts }),
    });
    const data = await res.json();
    if (data.ok) {
      generatedTextDirty = false;
      btn.textContent = "Сохранено";
      setTimeout(() => {
        btn.textContent = "Сохранить изменения";
        if (!generatedTextDirty) btn.style.display = "none";
      }, 1500);
    } else {
      btn.textContent = "Ошибка сохранения";
      setTimeout(() => { btn.textContent = "Сохранить изменения"; }, 2000);
    }
  } catch {
    btn.textContent = "Ошибка сохранения";
    setTimeout(() => { btn.textContent = "Сохранить изменения"; }, 2000);
  }
  btn.disabled = false;
}

function regenerate() {
  document.getElementById("generate-form").scrollIntoView({ behavior: "smooth" });
  document.getElementById("generate-actions").style.display = "none";
  document.getElementById("generate-results").style.display = "none";
  document.getElementById("promptPreview").focus();
}

function continueToGenerate() {
  goToStep(3);
}

// --- Send ---
let _sendFile = null;

async function refreshSendDropdown() {
  const res = await fetch("/api/files/data");
  const files = await res.json();
  const generated = files.filter((f) => f.name.includes("_generated_"));

  // Auto-select: use last generated file or the most recent generated file
  _sendFile = null;
  if (lastGeneratedFile) {
    const match = generated.find((f) => f.name === lastGeneratedFile);
    if (match) _sendFile = match.name;
  }
  if (!_sendFile && generated.length > 0) {
    _sendFile = generated[0].name;
  }

  if (_sendFile) loadSendPreview(_sendFile);
  else document.getElementById("send-preview").style.display = "none";
}

let sendTextDirty = false;

async function loadSendPreview(filename) {
  const preview = document.getElementById("send-preview");
  const body = document.getElementById("send-preview-body");
  const saveBtn = document.getElementById("saveSendEdits");

  sendTextDirty = false;
  saveBtn.style.display = "none";

  try {
    const res = await fetch(`/api/files/data/${encodeURIComponent(filename)}`);
    const data = await res.json();

    if (data.generatedTexts && data.generatedTexts.length > 0) {
      body.innerHTML = "";
      data.generatedTexts.forEach((item, idx) => {
        const div = document.createElement("div");
        div.className = "generated-text-item";
        if (data.generatedTexts.length > 1) {
          const header = document.createElement("div");
          header.className = "generated-text-header";
          header.textContent = `Сообщение ${idx + 1} \u2192 ${item.targetId}`;
          div.appendChild(header);
        }
        const ta = document.createElement("textarea");
        ta.className = "generated-text-editor";
        ta.value = item.text;
        ta.dataset.index = idx;
        ta.dataset.targetId = item.targetId;
        ta.addEventListener("input", () => {
          sendTextDirty = true;
          saveBtn.style.display = "";
        });
        ta.rows = Math.min(20, Math.max(4, item.text.split("\n").length + 1));
        div.appendChild(ta);
        body.appendChild(div);
      });
      preview.style.display = "";
    } else {
      preview.style.display = "none";
    }
  } catch {
    preview.style.display = "none";
  }
}

async function saveSendEdits() {
  if (!_sendFile) return;
  const btn = document.getElementById("saveSendEdits");
  const editors = document.querySelectorAll("#send-preview-body .generated-text-editor");

  const generatedTexts = [];
  editors.forEach((ta) => {
    generatedTexts.push({ targetId: ta.dataset.targetId, text: ta.value });
  });

  btn.disabled = true;
  btn.textContent = "Сохранение...";

  try {
    const res = await fetch(`/api/files/data/${encodeURIComponent(_sendFile)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ generatedTexts }),
    });
    const data = await res.json();
    if (data.ok) {
      sendTextDirty = false;
      btn.textContent = "Сохранено";
      setTimeout(() => {
        btn.textContent = "Сохранить изменения";
        if (!sendTextDirty) btn.style.display = "none";
      }, 1500);
    } else {
      btn.textContent = "Ошибка сохранения";
      setTimeout(() => { btn.textContent = "Сохранить изменения"; }, 2000);
    }
  } catch {
    btn.textContent = "Ошибка сохранения";
    setTimeout(() => { btn.textContent = "Сохранить изменения"; }, 2000);
  }
  btn.disabled = false;
}

async function runSend(e) {
  e.preventDefault();
  if (!ensureEnvKeys(["TG_API_ID", "TG_API_HASH"], { logPanelId: "send-log" })) {
    return false;
  }

  const inputFile = _sendFile;
  if (!inputFile) return false;

  if (!confirm("Сообщения будут отправлены в Telegram. Продолжить?")) return false;

  const mode = "comment";
  const delay = 2000;

  const btn = document.getElementById("send-btn");
  btn.disabled = true;
  btn.textContent = "Отправка...";

  const sendBody = { inputFile, mode, delay };
  // Always use the tab's active session
  const tabSession = getTabSession();
  if (tabSession) {
    sendBody.session = tabSession;
  } else {
    const sendSession = document.getElementById("send-session").value;
    if (sendSession) sendBody.session = sendSession;
  }

  try {
    const res = await fetch("/api/run/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sendBody),
    });
    const data = await res.json();
    if (data.error) {
      const panel = document.getElementById("send-log");
      panel.innerHTML = "";
      addStatusLine(panel, "Ошибка: " + data.error, "error");
      btn.disabled = false;
      btn.textContent = "Отправить";
      return false;
    }

    streamJob(
      data.jobId,
      "send-log",
      null,
      (code) => {
        btn.disabled = false;
        btn.textContent = "Отправить";
      }
    );
  } catch (err) {
    const panel = document.getElementById("send-log");
    panel.innerHTML = "";
    addStatusLine(panel, "Не удалось запустить. Сервер работает?", "error");
    btn.disabled = false;
    btn.textContent = "Отправить";
  }
  return false;
}

function continueToSend() {
  goToStep(4);
}

// --- Active Jobs Polling ---
const scriptLabels = { parser: "Сбор", generator: "Генерация", sender: "Отправка" };

async function pollActiveJobs() {
  try {
    const res = await fetch("/api/jobs/active");
    const jobs = await res.json();
    const badge = document.getElementById("active-jobs-badge");
    if (!jobs.length) {
      badge.innerHTML = "";
      return;
    }
    badge.innerHTML = jobs
      .map((j) => {
        const label = scriptLabels[j.script] || j.script;
        const sess = j.session ? ` (${escapeHtml(j.session)})` : "";
        return `<span class="job-chip">${escapeHtml(label)}${sess}</span>`;
      })
      .join("");
  } catch {
    // ignore
  }
}

setInterval(pollActiveJobs, 3000);

// --- Init ---
window.startAuthWithName = startAuthWithName;
window.submitAuth = submitAuth;
window.runParse = runParse;
window.runGenerate = runGenerate;
window.runSend = runSend;
window.continueToGenerate = continueToGenerate;
window.continueToSend = continueToSend;
window.regenerate = regenerate;
window.saveGeneratedText = saveGeneratedText;
window.saveSendEdits = saveSendEdits;
window.startNewSession = startNewSession;
window.cancelNewSession = cancelNewSession;
window.activateSessionInTab = activateSessionInTab;
window.openSessionEdit = openSessionEdit;
window.cancelSessionEdit = cancelSessionEdit;
window.saveSessionEdit = saveSessionEdit;
window.removeSession = removeSession;
window.toggleProxy = toggleProxy;
window.onProxyTypeChange = onProxyTypeChange;
window.testProxy = testProxy;
window.toggleEditProxy = toggleEditProxy;
window.onEditProxyTypeChange = onEditProxyTypeChange;

checkEnv();
