# Multiple Telegram Sessions — Implementation Changelog

## New File

### `src/session-store.ts`

Registry CRUD module for managing named Telegram sessions stored in `data/sessions.json`.

```ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { TgSession, SessionRegistry } from "./types.js";

const SESSIONS_PATH = resolve(
  import.meta.dirname,
  "..",
  "data",
  "sessions.json",
);

const NAME_RE = /^[a-z0-9_-]{1,32}$/;

function emptyRegistry(): SessionRegistry {
  return { activeSession: "default", sessions: [] };
}

export function isValidSessionName(name: string): boolean {
  return NAME_RE.test(name);
}

export function loadRegistry(): SessionRegistry {
  if (!existsSync(SESSIONS_PATH)) return emptyRegistry();
  try {
    return JSON.parse(readFileSync(SESSIONS_PATH, "utf-8"));
  } catch {
    return emptyRegistry();
  }
}

export function saveRegistry(registry: SessionRegistry): void {
  const dir = dirname(SESSIONS_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SESSIONS_PATH, JSON.stringify(registry, null, 2), "utf-8");
}

export function getSession(name: string): TgSession | undefined {
  return loadRegistry().sessions.find((s) => s.name === name);
}

export function getActiveSession(): TgSession | undefined {
  const reg = loadRegistry();
  return reg.sessions.find((s) => s.name === reg.activeSession);
}

export function listSessions(): { active: string; sessions: TgSession[] } {
  const reg = loadRegistry();
  return { active: reg.activeSession, sessions: reg.sessions };
}

export function addSession(session: TgSession): void {
  const reg = loadRegistry();
  const idx = reg.sessions.findIndex((s) => s.name === session.name);
  if (idx !== -1) {
    reg.sessions[idx] = session;
  } else {
    reg.sessions.push(session);
  }
  saveRegistry(reg);
}

export function deleteSession(name: string): boolean {
  const reg = loadRegistry();
  const before = reg.sessions.length;
  reg.sessions = reg.sessions.filter((s) => s.name !== name);
  if (reg.sessions.length === before) return false;
  if (reg.activeSession === name) {
    reg.activeSession = reg.sessions[0]?.name ?? "default";
  }
  saveRegistry(reg);
  return true;
}

export function setActiveSession(name: string): boolean {
  const reg = loadRegistry();
  if (!reg.sessions.some((s) => s.name === name)) return false;
  reg.activeSession = name;
  saveRegistry(reg);
  return true;
}

export function touchSession(name: string): void {
  const reg = loadRegistry();
  const session = reg.sessions.find((s) => s.name === name);
  if (session) {
    session.lastUsedAt = new Date().toISOString();
    saveRegistry(reg);
  }
}

export function migrateFromEnv(): void {
  if (existsSync(SESSIONS_PATH)) return;
  const envSession = process.env.TG_SESSION;
  if (!envSession) return;

  const reg = emptyRegistry();
  reg.sessions.push({
    name: "default",
    sessionString: envSession,
    phone: "",
    displayName: "Default",
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  });
  saveRegistry(reg);
  console.log("Migrated TG_SESSION from .env to data/sessions.json");
}
```

---

## Modified Files

### `src/types.ts`

Added two new interfaces at the end of the file:

```ts
export interface TgSession {
  name: string;
  sessionString: string;
  phone: string;
  displayName: string;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface SessionRegistry {
  activeSession: string;
  sessions: TgSession[];
}
```

---

### `src/client.ts`

Changed `createClient()` to accept an optional `sessionName` parameter. Looks up the named session from the registry, falls back to the active session, then to `config.tgSession` from `.env`.

```ts
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { config } from "./config.js";
import { getSession, getActiveSession, touchSession } from "./session-store.js";

export async function createClient(sessionName?: string): Promise<TelegramClient> {
  let sessionString = config.tgSession;

  if (sessionName) {
    const entry = getSession(sessionName);
    if (entry) {
      sessionString = entry.sessionString;
      touchSession(sessionName);
    }
  } else {
    const active = getActiveSession();
    if (active) {
      sessionString = active.sessionString;
      touchSession(active.name);
    }
  }

  const session = new StringSession(sessionString);
  const client = new TelegramClient(session, config.tgApiId, config.tgApiHash, {
    connectionRetries: 5,
  });
  await client.connect();
  return client;
}
```

---

### `src/web/server.ts`

Added import and call to `migrateFromEnv()` at startup:

```ts
import "dotenv/config";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { resolve, extname } from "node:path";
import { exec } from "node:child_process";
import { handleApi } from "./api.js";
import { migrateFromEnv } from "../session-store.js";

migrateFromEnv();

// ... rest unchanged
```

---

### `src/web/auth-handler.ts`

Full rewrite. Key changes:
- `startAuth(sessionName: string)` now accepts a session name.
- `AuthState` gains `sessionName` and `phone` fields.
- `respondAuth()` captures the phone number during the phone step.
- On auth completion: fetches display name via `client.getMe()`, calls `addSession()` and `setActiveSession()` instead of `saveSessionToEnv()`.
- `saveSessionToEnv()` function removed entirely.

```ts
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { config } from "../config.js";
import { addSession, setActiveSession } from "../session-store.js";
import type { TgSession } from "../types.js";

type AuthStep = "phone" | "code" | "password" | "done";

interface AuthState {
  client: TelegramClient;
  step: AuthStep;
  resolve: ((value: string) => void) | null;
  error: string | null;
  sessionName: string;
  phone: string;
}

let authState: AuthState | null = null;

export async function startAuth(sessionName: string): Promise<{ step: AuthStep }> {
  if (authState) {
    throw new Error("Auth already in progress. Complete or cancel it first.");
  }

  const client = new TelegramClient(
    new StringSession(""),
    config.tgApiId,
    config.tgApiHash,
    { connectionRetries: 5 }
  );

  authState = {
    client,
    step: "phone",
    resolve: null,
    error: null,
    sessionName,
    phone: "",
  };

  const authPromise = client.start({
    phoneNumber: () =>
      new Promise<string>((res) => {
        authState!.step = "phone";
        authState!.resolve = res;
      }),
    phoneCode: () =>
      new Promise<string>((res) => {
        authState!.step = "code";
        authState!.resolve = res;
      }),
    password: () =>
      new Promise<string>((res) => {
        authState!.step = "password";
        authState!.resolve = res;
      }),
    onError: (err) => {
      if (authState) authState.error = err.message;
    },
  });

  authPromise
    .then(async () => {
      if (!authState) return;
      const sessionString = authState.client.session.save() as unknown as string;

      let displayName = authState.sessionName;
      try {
        const me = await authState.client.getMe();
        if (me && "firstName" in me) {
          displayName = [me.firstName, me.lastName].filter(Boolean).join(" ") || displayName;
        }
      } catch {
        // ignore — use sessionName as fallback
      }

      const entry: TgSession = {
        name: authState.sessionName,
        sessionString,
        phone: authState.phone,
        displayName,
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      };
      addSession(entry);
      setActiveSession(entry.name);

      authState.step = "done";
      authState.resolve = null;
    })
    .catch((err) => {
      if (authState) {
        authState.error = err.message;
        authState.step = "done";
      }
    });

  await new Promise((r) => setTimeout(r, 500));

  return { step: authState.step };
}

export function respondAuth(value: string): { step: AuthStep; error: string | null } {
  if (!authState) {
    throw new Error("No auth in progress.");
  }
  if (!authState.resolve) {
    return { step: authState.step, error: authState.error };
  }

  // Capture phone number during phone step
  if (authState.step === "phone") {
    authState.phone = value;
  }

  authState.resolve(value);
  authState.resolve = null;

  return { step: authState.step, error: authState.error };
}

export function getAuthStep(): { step: AuthStep; error: string | null } | null {
  if (!authState) return null;
  return { step: authState.step, error: authState.error };
}

export async function cancelAuth(): Promise<void> {
  if (authState) {
    try {
      await authState.client.disconnect();
    } catch {
      // ignore
    }
    authState = null;
  }
}
```

---

### `src/web/api.ts`

**New import:**

```ts
import {
  listSessions,
  setActiveSession,
  deleteSession,
  isValidSessionName,
} from "../session-store.js";
```

**Modified `GET /api/env`** — checks registry instead of just `process.env`:

```ts
if (path === "/api/env" && req.method === "GET") {
  const hasSessions = listSessions().sessions.length > 0;
  json(res, {
    TG_API_ID: !!process.env.TG_API_ID,
    TG_API_HASH: !!process.env.TG_API_HASH,
    TG_SESSION: hasSessions || !!process.env.TG_SESSION,
    OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
    OPENAI_MODEL: process.env.OPENAI_MODEL || "gpt-4o",
  });
  return;
}
```

**New endpoints** (inserted after `GET /api/env`):

```ts
// GET /api/sessions
if (path === "/api/sessions" && req.method === "GET") {
  json(res, listSessions());
  return;
}

// POST /api/sessions/active
if (path === "/api/sessions/active" && req.method === "POST") {
  const body = await readBody(req);
  const name = body.name as string;
  if (!name) {
    error(res, "Missing 'name' field");
    return;
  }
  const ok = setActiveSession(name);
  if (!ok) {
    error(res, `Session "${name}" not found`, 404);
    return;
  }
  json(res, { ok: true });
  return;
}

// DELETE /api/sessions/:name
const sessionDeleteMatch = path.match(/^\/api\/sessions\/([a-z0-9_-]+)$/);
if (sessionDeleteMatch && req.method === "DELETE") {
  const name = decodeURIComponent(sessionDeleteMatch[1]);
  const ok = deleteSession(name);
  if (!ok) {
    error(res, `Session "${name}" not found`, 404);
    return;
  }
  json(res, { ok: true });
  return;
}
```

**Modified `POST /api/auth/start`** — reads `sessionName` from request body, validates it:

```ts
if (path === "/api/auth/start" && req.method === "POST") {
  try {
    const body = await readBody(req);
    const sessionName = (body.sessionName as string) || "default";
    if (!isValidSessionName(sessionName)) {
      error(res, "Invalid session name. Use lowercase letters, numbers, hyphens, underscores (max 32 chars).");
      return;
    }
    const result = await startAuth(sessionName);
    json(res, result);
  } catch (err: any) {
    error(res, err.message);
  }
  return;
}
```

**Modified `POST /api/run/parse`** — passes `--session` flag to child process:

```ts
if (body.session) args.push("--session", String(body.session));
```

**Modified `POST /api/run/send`** — passes `--session` flag to child process:

```ts
if (body.session) args.push("--session", String(body.session));
```

---

### `src/parser.ts`

**Added import:**

```ts
import { hasFlag, getNumericFlag, getStringFlag, getPositionalArg } from "./utils/cli.js";
```

**Added `--session` to help text:**

```
  --session <name>       Use a named Telegram session
```

**Added `session` to `parseArgs()` return:**

```ts
return {
  mode,
  chatId,
  limit: getNumericFlag("--limit", 100),
  posts: getNumericFlag("--posts", 10),
  commentsPerPost: getNumericFlag("--comments-per-post", 50),
  session: getStringFlag("--session"),
};
```

**Changed `fetchMessages` and `fetchComments` signatures:**

```ts
async function fetchMessages(chatId: string, limit: number, session?: string) {
  const client = await createClient(session);
  // ...
}

async function fetchComments(chatId: string, postsCount: number, commentsPerPost: number, session?: string) {
  const client = await createClient(session);
  // ...
}
```

**Changed `main()` to pass session through:**

```ts
async function main() {
  const { mode, chatId, limit, posts, commentsPerPost, session } = parseArgs();

  if (mode === "messages") {
    await fetchMessages(chatId, limit, session);
  } else if (mode === "comments") {
    await fetchComments(chatId, posts, commentsPerPost, session);
  }
  // ...
}
```

---

### `src/sender.ts`

**Added `--session` to help text:**

```
  --session <name>     Use a named Telegram session
```

**Added `session` to `parseArgs()` return:**

```ts
return {
  inputJson: getPositionalArg(0)!,
  mode: (getStringFlag("--mode", "comment")) as "comment" | "latest",
  delay: getNumericFlag("--delay", 2000),
  session: getStringFlag("--session"),
};
```

**Changed `main()` to use session:**

```ts
async function main() {
  const { inputJson, mode, delay, session } = parseArgs();
  // ...
  const client = await createClient(session);
  // ...
}
```

---

### `src/auth.ts`

Full rewrite. Key changes:
- Added `--name <label>` flag for naming the session.
- Validates session name with `isValidSessionName()`.
- Captures phone number from user input.
- Fetches display name via `client.getMe()`.
- Saves to session registry via `addSession()` + `setActiveSession()`.
- Still writes to `.env` for backward compatibility.

```ts
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import input from "input";
import { config } from "./config.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { addSession, setActiveSession, isValidSessionName } from "./session-store.js";
import type { TgSession } from "./types.js";

function getFlag(name: string): string | undefined {
  const args = process.argv.slice(2);
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return undefined;
}

async function main() {
  console.log("Telegram Authentication");
  console.log("=======================\n");

  let sessionName = getFlag("--name") || "default";
  if (!isValidSessionName(sessionName)) {
    console.error(
      `Invalid session name "${sessionName}". Use lowercase letters, numbers, hyphens, underscores (max 32 chars).`,
    );
    process.exit(1);
  }

  const client = new TelegramClient(
    new StringSession(""),
    config.tgApiId,
    config.tgApiHash,
    { connectionRetries: 5 }
  );

  let phone = "";

  await client.start({
    phoneNumber: async () => {
      phone = await input.text("Enter your phone number: ");
      return phone;
    },
    password: async () => await input.text("Enter your 2FA password (if set): "),
    phoneCode: async () => await input.text("Enter the code you received: "),
    onError: (err) => console.error("Auth error:", err.message),
  });

  const sessionString = client.session.save() as unknown as string;
  console.log("\nAuthentication successful!");

  let displayName = sessionName;
  try {
    const me = await client.getMe();
    if (me && "firstName" in me) {
      displayName = [me.firstName, me.lastName].filter(Boolean).join(" ") || displayName;
    }
  } catch {
    // ignore
  }

  const entry: TgSession = {
    name: sessionName,
    sessionString,
    phone,
    displayName,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
  };
  addSession(entry);
  setActiveSession(sessionName);
  console.log(`Session "${sessionName}" saved to data/sessions.json and set as active.`);

  // Also write session to .env for backward compatibility
  const envPath = resolve(process.cwd(), ".env");
  if (existsSync(envPath)) {
    let envContent = readFileSync(envPath, "utf-8");
    if (envContent.match(/^TG_SESSION=.*$/m)) {
      envContent = envContent.replace(/^TG_SESSION=.*$/m, `TG_SESSION=${sessionString}`);
    } else {
      envContent += `\nTG_SESSION=${sessionString}\n`;
    }
    writeFileSync(envPath, envContent);
  } else {
    writeFileSync(envPath, `TG_SESSION=${sessionString}\n`);
  }
  process.env.TG_SESSION = sessionString;
  console.log("Session also saved to .env file.");

  await client.disconnect();
}

main().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
```

---

### `web/index.html`

**Step 1 — Replaced `#auth-section` with `#sessions-section`:**

Old:
```html
<div id="auth-section" style="display:none">
  <h3>Авторизация в Telegram</h3>
  <p id="auth-status">Подключите аккаунт Telegram для начала работы.</p>
  <div id="auth-form">
    <button id="auth-start-btn" onclick="startAuth()">Войти в Telegram</button>
    <div id="auth-input-group" style="display:none">
      <label id="auth-label">Номер телефона:</label>
      <input type="text" id="auth-input" placeholder="Введите значение...">
      <button id="auth-submit-btn" onclick="submitAuth()">Подтвердить</button>
    </div>
  </div>
</div>
```

New:
```html
<div id="sessions-section">
  <h3>Сессии Telegram</h3>
  <div id="sessions-list" class="sessions-list"></div>
  <button id="add-session-btn" class="add-session-btn" onclick="startNewSession()">+ Добавить аккаунт</button>
  <div id="new-session-form" style="display:none">
    <div class="form-group">
      <label for="new-session-name">Имя сессии (латиница, цифры, дефис):</label>
      <input type="text" id="new-session-name" placeholder="напр. work, personal" maxlength="32">
    </div>
    <p id="auth-status">Подключите аккаунт Telegram.</p>
    <div id="auth-form">
      <button id="auth-start-btn" onclick="startAuthWithName()">Войти в Telegram</button>
      <div id="auth-input-group" style="display:none">
        <label id="auth-label">Номер телефона:</label>
        <input type="text" id="auth-input" placeholder="Введите значение...">
        <button id="auth-submit-btn" onclick="submitAuth()">Подтвердить</button>
      </div>
      <button id="auth-cancel-btn" class="auth-cancel-btn" onclick="cancelNewSession()">Отмена</button>
    </div>
  </div>
</div>
```

**Step 2 — Added session dropdown before the parse form fields:**

```html
<div class="form-group" id="parse-session-group" style="display:none">
  <label for="parse-session">Сессия Telegram:</label>
  <select id="parse-session"></select>
</div>
```

**Step 4 — Added session dropdown before the send preview:**

```html
<div class="form-group" id="send-session-group" style="display:none">
  <label for="send-session">Сессия Telegram:</label>
  <select id="send-session"></select>
</div>
```

---

### `web/app.js`

**New state variable:**

```js
let _sessions = { active: "", sessions: [] };
```

**Modified `checkEnv()`** — removed conditional `auth-section` display, now calls `loadSessions()`:

```js
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
```

**New session management functions:**

```js
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
```

**Replaced `startAuth()` with `startAuthWithName()`:**

```js
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
```

**Modified `showAuthStep()` "done" branch** — refreshes sessions and auto-hides the form:

```js
if (step === "done") {
  statusEl.textContent = "Вы авторизованы! Сессия сохранена.";
  inputGroup.style.display = "none";
  startBtn.style.display = "none";
  loadSessions().then(() => {
    checkEnv();
    setTimeout(() => {
      cancelNewSession();
    }, 1500);
  });
  return;
}
```

**Modified `runParse()`** — sends selected session:

```js
const parseSession = document.getElementById("parse-session").value;
if (parseSession) body.session = parseSession;
```

**Modified `runSend()`** — sends selected session:

```js
const sendSession = document.getElementById("send-session").value;
// ...
const sendBody = { inputFile, mode, delay };
if (sendSession) sendBody.session = sendSession;
// ... uses sendBody in fetch
```

**Updated window exports:**

```js
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
```

---

### `web/style.css`

**Replaced `#auth-section` block** with `#sessions-section` and all session-related styles:

```css
/* ============================================
   Sessions Section
   ============================================ */
#sessions-section {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 1rem 1.1rem;
}

.sessions-list {
  margin-bottom: 0.75rem;
}

.sessions-empty {
  font-size: 0.8rem;
  color: var(--text-dim);
  font-style: italic;
  padding: 0.35rem 0;
}

.session-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.55rem 0.65rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  margin-bottom: 0.4rem;
  transition: all 0.2s ease;
  background: var(--bg-surface);
}

.session-item.session-active {
  border-color: var(--accent-border);
  background: var(--accent-muted);
}

.session-info {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  min-width: 0;
}

.session-name {
  font-size: 0.84rem;
  font-weight: 600;
  color: var(--text-primary);
}

.session-badge {
  font-size: 0.66rem;
  font-family: var(--font-mono);
  color: var(--accent-bright);
  background: rgba(191, 61, 92, 0.15);
  padding: 0.1rem 0.45rem;
  border-radius: 3px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 600;
}

.session-phone {
  font-size: 0.74rem;
  font-family: var(--font-mono);
  color: var(--text-dim);
}

.session-actions {
  display: flex;
  gap: 0.35rem;
  flex-shrink: 0;
}

.session-activate-btn,
.session-delete-btn {
  background: none;
  border: 1px solid var(--border-light);
  color: var(--text-secondary);
  font-family: var(--font-body);
  font-size: 0.72rem;
  font-weight: 500;
  cursor: pointer;
  padding: 0.2rem 0.55rem;
  border-radius: var(--radius-sm);
  transition: all 0.2s ease;
}

.session-activate-btn:hover {
  border-color: var(--gold-border);
  color: var(--gold);
  background: var(--gold-muted);
}

.session-delete-btn:hover {
  border-color: var(--error);
  color: var(--error);
  background: rgba(191, 61, 92, 0.08);
}

.add-session-btn {
  background: var(--bg-surface);
  color: var(--gold);
  border: 1px dashed var(--gold-border);
  padding: 0.5rem 1rem;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-family: var(--font-body);
  font-size: 0.8rem;
  font-weight: 500;
  width: 100%;
  transition: all 0.3s var(--ease-out);
}

.add-session-btn:hover {
  background: var(--gold-muted);
  border-color: var(--gold);
  color: var(--gold-bright);
}

#new-session-form {
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border);
}

.auth-cancel-btn {
  background: none;
  border: 1px solid var(--border-light);
  color: var(--text-secondary);
  font-family: var(--font-body);
  font-size: 0.8rem;
  font-weight: 500;
  cursor: pointer;
  padding: 0.5rem 1.2rem;
  border-radius: var(--radius-sm);
  margin-top: 0.5rem;
  transition: all 0.2s ease;
}

.auth-cancel-btn:hover {
  border-color: var(--text-dim);
  color: var(--text-primary);
}
```

The existing `#auth-status` and `#auth-input-group` styles were preserved unchanged.

---

## Data Format

### `data/sessions.json`

```json
{
  "activeSession": "default",
  "sessions": [
    {
      "name": "default",
      "sessionString": "1BAAOMTQ5...",
      "phone": "+79161234567",
      "displayName": "Norman Main",
      "createdAt": "2026-02-28T14:00:00.000Z",
      "lastUsedAt": null
    }
  ]
}
```

---

## Migration & Backward Compatibility

- `migrateFromEnv()` runs at server startup: auto-creates `sessions.json` from existing `TG_SESSION` in `.env` as `"default"` entry.
- `.env` is NOT modified — `TG_SESSION` stays as fallback.
- `createClient()` with no args still works (uses active session or falls back to `.env`).
- CLI scripts without `--session` use the active session.
- Session `<select>` dropdowns only appear in the UI when there are 2+ sessions.
- `src/auth.ts` still writes to `.env` in addition to the registry for backward compatibility.
