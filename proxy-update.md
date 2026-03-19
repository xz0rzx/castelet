# Per-Session Proxy Support for Castelet

## Context

Users need to route Telegram connections through proxies on a per-account basis. This requires:
- Proxy configuration during account creation (before Telegram auth)
- Persisting proxy settings with each session
- A **kill switch**: if proxy is enabled but unreachable, block all operations and alert the user
- Proxy config passed to GramJS's `TelegramClient` which natively supports SOCKS4/5 and MTProxy

## Files to Modify

| File | Action |
|------|--------|
| `src/types.ts` | Add `ProxyConfig` types, add `proxy?` to `TgSession` |
| `src/proxy-check.ts` | **New** — TCP connectivity test utility |
| `src/client.ts` | Read proxy from session, test connectivity (kill switch), pass to TelegramClient |
| `src/web/auth-handler.ts` | Accept `proxy` param, test before auth, pass to TelegramClient, save with session |
| `src/web/api.ts` | Pass proxy to `startAuth()`, add `POST /api/proxy/test` endpoint |
| `web/index.html` | Add proxy config form inside `#new-session-form` |
| `web/style.css` | Styles for proxy form, checkbox, test button, proxy badge |
| `web/app.js` | Proxy form logic, `getProxyConfig()`, `testProxy()`, integrate with auth |

**No changes needed**: `parser.ts`, `sender.ts`, `generator.ts`, `runner.ts`, `session-store.ts`, `server.ts` — proxy flows through session store, not CLI args.

## Implementation Steps

### Step 1: Add proxy types (`src/types.ts`)

Add before `TgSession` interface (line ~94):

```typescript
export interface ProxyConfigSocks {
  ip: string;
  port: number;
  timeout?: number;
  username?: string;
  password?: string;
  socksType: 4 | 5;
}

export interface ProxyConfigMTProxy {
  ip: string;
  port: number;
  timeout?: number;
  username?: string;
  password?: string;
  secret: string;
  MTProxy: true;
}

export type ProxyConfig = ProxyConfigSocks | ProxyConfigMTProxy;
```

Add `proxy?: ProxyConfig` to `TgSession`. Existing sessions without proxy continue working (field is optional).

### Step 2: Create proxy test utility (`src/proxy-check.ts` — new file)

TCP connection test to `proxy.ip:proxy.port` with 5s timeout using `net.createConnection`. Resolves on connect, rejects on error/timeout. This is the kill switch mechanism — called before every client creation.

```typescript
import { createConnection } from "node:net";
import type { ProxyConfig } from "./types.js";

export function testProxyConnectivity(proxy: ProxyConfig, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: proxy.ip, port: proxy.port });

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Proxy connection timed out after ${timeoutMs}ms (${proxy.ip}:${proxy.port})`));
    }, timeoutMs);

    socket.on("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve();
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(`Proxy unreachable: ${proxy.ip}:${proxy.port} — ${err.message}`));
    });
  });
}
```

### Step 3: Update client creation (`src/client.ts`)

- Extract `proxy` from session entry alongside `sessionString`
- If `proxy` exists, call `testProxyConnectivity(proxy)` before creating client (kill switch)
- Pass `proxy` to `TelegramClient` constructor options

```typescript
import { testProxyConnectivity } from "./proxy-check.js";
import type { ProxyConfig } from "./types.js";

export async function createClient(sessionName?: string): Promise<TelegramClient> {
  let sessionString = config.tgSession;
  let proxy: ProxyConfig | undefined;

  if (sessionName) {
    const entry = getSession(sessionName);
    if (entry) {
      sessionString = entry.sessionString;
      proxy = entry.proxy;
      touchSession(sessionName);
    }
  } else {
    const active = getActiveSession();
    if (active) {
      sessionString = active.sessionString;
      proxy = active.proxy;
      touchSession(active.name);
    }
  }

  // Kill switch: test proxy connectivity before creating the client
  if (proxy) {
    await testProxyConnectivity(proxy);
  }

  const session = new StringSession(sessionString);
  const client = new TelegramClient(session, config.tgApiId, config.tgApiHash, {
    connectionRetries: 5,
    proxy,
  });
  await client.connect();
  return client;
}
```

This automatically protects all downstream operations (parser, sender) since they call `createClient()`.

### Step 4: Update auth handler (`src/web/auth-handler.ts`)

- Add `proxy?: ProxyConfig` param to `startAuth()`
- Store `proxy` in `AuthState`
- Test proxy connectivity before starting auth (kill switch)
- Pass `proxy` to `TelegramClient` constructor
- Include `proxy` in the `TgSession` entry saved on auth success

```typescript
import type { TgSession, ProxyConfig } from "../types.js";
import { testProxyConnectivity } from "../proxy-check.js";

interface AuthState {
  client: TelegramClient;
  step: AuthStep;
  resolve: ((value: string) => void) | null;
  error: string | null;
  sessionName: string;
  phone: string;
  proxy?: ProxyConfig;  // added
}

export async function startAuth(sessionName: string, proxy?: ProxyConfig): Promise<{ step: AuthStep }> {
  // Kill switch: test proxy before starting auth
  if (proxy) {
    await testProxyConnectivity(proxy);
  }

  const client = new TelegramClient(
    new StringSession(""),
    config.tgApiId,
    config.tgApiHash,
    { connectionRetries: 5, proxy }
  );

  authState = { client, step: "phone", resolve: null, error: null, sessionName, phone: "", proxy };

  // ... on auth success, include proxy in TgSession entry:
  const entry: TgSession = {
    name: authState.sessionName,
    sessionString,
    phone: authState.phone,
    displayName,
    createdAt: new Date().toISOString(),
    lastUsedAt: null,
    ...(authState.proxy ? { proxy: authState.proxy } : {}),
  };
}
```

### Step 5: Update API layer (`src/web/api.ts`)

- `POST /api/auth/start`: extract `proxy` from request body, pass to `startAuth(sessionName, proxy)`
- Add new `POST /api/proxy/test` endpoint: accepts `{ proxy }`, calls `testProxyConnectivity`, returns `{ ok: true }` or `{ ok: false, error: "..." }`

```typescript
// POST /api/auth/start — modified
const proxy = body.proxy as ProxyConfig | undefined;
const result = await startAuth(sessionName, proxy);

// POST /api/proxy/test — new endpoint
if (path === "/api/proxy/test" && req.method === "POST") {
  const body = await readBody(req);
  const proxy = body.proxy as ProxyConfig | undefined;
  if (!proxy || !proxy.ip || !proxy.port) {
    error(res, "Missing proxy configuration");
    return;
  }
  try {
    await testProxyConnectivity(proxy);
    json(res, { ok: true });
  } catch (err: any) {
    json(res, { ok: false, error: err.message });
  }
  return;
}
```

### Step 6: Update HTML (`web/index.html`)

Insert proxy form inside `#new-session-form` between session name input (line 58) and auth status (line 60):

```html
<!-- Proxy configuration -->
<div class="proxy-section">
  <label class="proxy-toggle">
    <input type="checkbox" id="proxy-enabled">
    <span>Использовать прокси</span>
  </label>
  <div id="proxy-fields" style="display:none">
    <div class="form-group">
      <label for="proxy-type">Тип прокси:</label>
      <select id="proxy-type">
        <option value="socks5" selected>SOCKS5</option>
        <option value="socks4">SOCKS4</option>
        <option value="mtproxy">MTProxy</option>
      </select>
    </div>
    <div class="proxy-row">
      <div class="form-group proxy-host-group">
        <label for="proxy-host">Хост:</label>
        <input type="text" id="proxy-host" placeholder="123.45.67.89">
      </div>
      <div class="form-group proxy-port-group">
        <label for="proxy-port">Порт:</label>
        <input type="number" id="proxy-port" placeholder="1080" min="1" max="65535">
      </div>
    </div>
    <div class="proxy-row" id="proxy-auth-row">
      <div class="form-group">
        <label for="proxy-username">Логин (необязательно):</label>
        <input type="text" id="proxy-username">
      </div>
      <div class="form-group">
        <label for="proxy-password">Пароль (необязательно):</label>
        <input type="text" id="proxy-password">
      </div>
    </div>
    <div class="form-group" id="proxy-secret-group" style="display:none">
      <label for="proxy-secret">Secret (hex):</label>
      <input type="text" id="proxy-secret" placeholder="ee0123456789abcdef...">
    </div>
    <button type="button" id="proxy-test-btn" class="proxy-test-btn" onclick="testProxy()">
      Проверить прокси
    </button>
    <span id="proxy-test-status"></span>
  </div>
</div>
```

### Step 7: Update CSS (`web/style.css`)

Add styles for proxy section using existing design variables (`--border`, `--text-primary`, `--gold`, `--gold-muted`, `--gold-border`, `--success`, `--error`, `--accent`, `--radius-sm`, `--font-body`, `--font-mono`):

- `.proxy-section` — bordered section with margin
- `.proxy-toggle` — styled checkbox label
- `.proxy-row` — flexbox row for host+port side-by-side
- `.proxy-test-btn` — subtle bordered button matching existing UI
- `#proxy-test-status` — monospace text, green for ok, red for fail
- `.session-proxy-badge` — small gold badge on session cards (like the "активная" badge style)

### Step 8: Update frontend JS (`web/app.js`)

- Proxy checkbox toggle shows/hides `#proxy-fields`
- Proxy type dropdown shows/hides `#proxy-secret-group` for MTProxy
- `getProxyConfig()` — reads form fields, returns `ProxyConfig` object or `undefined`
- `testProxy()` — calls `POST /api/proxy/test`, shows result in `#proxy-test-status`
- `startAuthWithName()` — include `proxy: getProxyConfig()` in request body
- `cancelNewSession()` — reset all proxy form fields
- `renderSessionsList()` — show `<span class="session-proxy-badge">proxy</span>` on sessions with `s.proxy`
- Register `window.testProxy`

## Kill Switch Behavior

| Scenario | What happens |
|----------|-------------|
| Auth start with bad proxy | `testProxyConnectivity` throws → API returns error → UI shows "Прокси недоступен" |
| Parse/Send with bad proxy | `createClient()` throws → child process exits code 1 → SSE streams error → UI shows error |
| Proxy test button | `POST /api/proxy/test` → immediate feedback before auth starts |
| No proxy configured | No test, no proxy passed to GramJS — works exactly as before |

## Verification

1. Start server (`npm run web`), go to Step 1
2. Click "Добавить аккаунт", enter session name
3. Check "Использовать прокси" — verify fields appear, type toggle shows/hides secret
4. Enter invalid proxy, click "Проверить прокси" — verify error shown
5. Enter valid SOCKS5 proxy, click "Проверить прокси" — verify success
6. Click "Войти в Telegram" with valid proxy — verify auth completes, session saved with proxy
7. Verify proxy badge appears on session card
8. Run parse with proxy session — verify it works through proxy
9. Stop proxy, try parse again — verify kill switch blocks with error message
10. Create session without proxy — verify it works as before (no regression)
