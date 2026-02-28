// --- State ---
let currentStep = 1;
let lastOutputFile = null;
let customPromptText = null;
let lastGeneratedFile = null;
let generatedTextDirty = false;
let chatType = null; // "messages" (chat) or "comments" (channel with posts)
let _sessions = { active: "", sessions: [] };

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
async function checkEnv() {
  try {
    const res = await fetch("/api/env");
    const env = await res.json();
    const el = document.getElementById("env-checklist");

    const friendly = {
      TG_API_ID: "API ID Telegram",
      TG_API_HASH: "API Hash Telegram",
      TG_SESSION: "Сессия Telegram",
      OPENAI_API_KEY: "Ключ API OpenAI",
    };

    el.innerHTML = Object.entries(friendly)
      .map(
        ([key, label]) =>
          `<div class="env-item"><span class="dot ${env[key] ? "ok" : "missing"}"></span>${label}</div>`
      )
      .join("");

    await loadSessions();
  } catch (err) {
    document.getElementById("env-checklist").innerHTML =
      '<p class="status-error">Не удалось проверить настройки. Сервер запущен?</p>';
  }
}

// --- Sessions ---
async function loadSessions() {
  try {
    const res = await fetch("/api/sessions");
    _sessions = await res.json();
    renderSessionsList();
    populateSessionDropdowns();
  } catch {
    _sessions = { active: "", sessions: [] };
  }
}

function renderSessionsList() {
  const container = document.getElementById("sessions-list");
  if (!_sessions.sessions.length) {
    container.innerHTML = '<p class="sessions-empty">Нет добавленных аккаунтов.</p>';
    return;
  }

  container.innerHTML = _sessions.sessions
    .map((s) => {
      const isActive = s.name === _sessions.active;
      return `<div class="session-item ${isActive ? "session-active" : ""}">
        <div class="session-info">
          <span class="session-name">${escapeHtml(s.displayName || s.name)}</span>
          ${isActive ? '<span class="session-badge">активная</span>' : ""}
          ${s.phone ? `<span class="session-phone">${escapeHtml(s.phone)}</span>` : ""}
        </div>
        <div class="session-actions">
          ${!isActive ? `<button class="session-activate-btn" onclick="activateSession('${escapeHtml(s.name)}')">Выбрать</button>` : ""}
          <button class="session-delete-btn" onclick="removeSession('${escapeHtml(s.name)}')">Удалить</button>
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

  const show = _sessions.sessions.length > 1;

  for (let i = 0; i < selects.length; i++) {
    groups[i].style.display = show ? "" : "none";
    selects[i].innerHTML = _sessions.sessions
      .map(
        (s) =>
          `<option value="${escapeHtml(s.name)}" ${s.name === _sessions.active ? "selected" : ""}>${escapeHtml(s.displayName || s.name)}</option>`
      )
      .join("");
  }
}

async function activateSession(name) {
  try {
    await fetch("/api/sessions/active", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    await loadSessions();
  } catch {
    // ignore
  }
}

async function removeSession(name) {
  if (!confirm(`Удалить сессию «${name}»?`)) return;
  try {
    await fetch(`/api/sessions/${encodeURIComponent(name)}`, { method: "DELETE" });
    await loadSessions();
    checkEnv();
  } catch {
    // ignore
  }
}

function startNewSession() {
  document.getElementById("new-session-form").style.display = "";
  document.getElementById("add-session-btn").style.display = "none";
  document.getElementById("new-session-name").value = "";
  document.getElementById("new-session-name").focus();
}

function cancelNewSession() {
  document.getElementById("new-session-form").style.display = "none";
  document.getElementById("add-session-btn").style.display = "";
  document.getElementById("auth-input-group").style.display = "none";
  document.getElementById("auth-start-btn").style.display = "";
  document.getElementById("auth-start-btn").disabled = false;
  document.getElementById("auth-start-btn").textContent = "Войти в Telegram";
  document.getElementById("auth-status").textContent = "Подключите аккаунт Telegram.";
  fetch("/api/auth/cancel", { method: "POST" }).catch(() => {});
}

// --- Auth ---
async function startAuthWithName() {
  const nameInput = document.getElementById("new-session-name");
  const sessionName = nameInput.value.trim().toLowerCase() || "default";
  const btn = document.getElementById("auth-start-btn");
  btn.disabled = true;
  btn.textContent = "Подключение...";

  try {
    await fetch("/api/auth/cancel", { method: "POST" });
    const res = await fetch("/api/auth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionName }),
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

  const source = new EventSource(`/api/stream/${jobId}`);

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
  const parseSession = document.getElementById("parse-session").value;
  if (parseSession) body.session = parseSession;

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
  const inputFile = _sendFile;
  if (!inputFile) return false;

  if (!confirm("Сообщения будут отправлены в Telegram. Продолжить?")) return false;

  const mode = "comment";
  const delay = 2000;
  const sendSession = document.getElementById("send-session").value;

  const btn = document.getElementById("send-btn");
  btn.disabled = true;
  btn.textContent = "Отправка...";

  const sendBody = { inputFile, mode, delay };
  if (sendSession) sendBody.session = sendSession;

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
window.activateSession = activateSession;
window.removeSession = removeSession;

checkEnv();
