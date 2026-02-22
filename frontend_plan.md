# Castelet Web Frontend — Implementation Plan

## Context

Castelet is a 4-step CLI pipeline (auth → parse → generate → send) for Telegram message processing with OpenAI. Currently all interaction is via terminal commands with flags. A non-programmer needs a point-and-click local web UI to use it without touching the CLI.

## Architecture Decisions

- **Zero new npm dependencies** — use `node:http` for the server (8 routes doesn't justify Express), vanilla HTML/CSS/JS for the frontend (4 forms + 4 log panels doesn't justify React)
- **Spawn existing scripts as child processes** — `child_process.spawn('npx', ['tsx', 'src/parser.ts', ...args])` preserves CLI tools as-is, no refactoring needed
- **SSE for log streaming** — `EventSource` in browser, `res.write('data: ...\n\n')` on server; simpler than WebSocket, sufficient for one-way logs
- **Auth handled programmatically** — the only script that can't be spawned cleanly (uses `input` library for stdin prompts). A dedicated handler imports `TelegramClient` directly and wires `client.start()` callbacks to HTTP request/response pairs
- **Startup**: `npm run ui` → opens `http://localhost:3333`

## New File Structure

```
src/web/
  server.ts          # HTTP server, static file serving, route dispatch
  api.ts             # Route handlers for /api/* endpoints
  runner.ts          # Spawns pipeline scripts, manages jobs, SSE broadcast
  auth-handler.ts    # Programmatic Telegram auth (promise-rendezvous pattern)
web/
  index.html         # Single-page stepper UI (4 steps)
  style.css          # Minimal dark-themed CSS (~150 lines)
  app.js             # Vanilla JS: fetch, EventSource, DOM manipulation (~300 lines)
```

No existing files are modified except `package.json` (add `"ui"` script).

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/env` | Which env vars are configured (booleans, not values) |
| POST | `/api/auth/start` | Begin Telegram auth flow, returns `{ step: "phone" }` |
| POST | `/api/auth/respond` | Submit phone/code/password, returns next step or `{ done: true }` |
| GET | `/api/files/data` | List JSON files in `data/` (name, size, mtime, type) |
| GET | `/api/files/prompts` | List text files in `prompts/` |
| GET | `/api/files/data/:filename` | Preview a specific data file's contents |
| GET | `/api/files/prompts/:filename` | Read a specific prompt file's contents |
| POST | `/api/run/parse` | Body: `{ mode, chatId, limit?, posts?, commentsPerPost? }` → `{ jobId }` |
| POST | `/api/run/generate` | Body: `{ inputFile, promptFile }` → `{ jobId }` |
| POST | `/api/run/send` | Body: `{ inputFile, mode?, delay? }` → `{ jobId }` |
| GET | `/api/stream/:jobId` | SSE — streams stdout/stderr lines + exit event |
| POST | `/api/run/:jobId/cancel` | Kill a running job |

## Frontend: 4-Step Wizard

**Step 1 — Setup**: Shows env var checklist (green/red). If TG_SESSION missing, inline auth form walks through phone → code → 2FA password. Non-dismissable until authenticated.

**Step 2 — Parse**: Mode toggle (Messages vs Comments), chat ID text input, numeric limit fields. "Parse" button spawns the job, log panel streams output. On completion, extracts output filename from `Saved: ...` log line, enables "Continue to Generate →" with file pre-selected.

**Step 3 — Generate**: Dropdown of data files (newest first, pre-selected from Step 2), dropdown of prompt files, read-only prompt preview textarea. "Generate" button spawns job. On completion, enables "Continue to Send →".

**Step 4 — Send**: Dropdown of `*_generated_*` files (pre-selected from Step 3), mode radio buttons (comment/latest), delay input. Confirmation dialog before sending ("This will post to Telegram. Continue?"). Log panel shows send progress + retries.

## Key Implementation Details

### Auth Handler (`src/web/auth-handler.ts`)
Replicates `src/auth.ts` lines 12-45 logic. Uses a promise-rendezvous pattern: `client.start()` callbacks set `currentStep` and return `new Promise()` that resolves when `/api/auth/respond` is called. Session saved to `.env` using the same regex-replace logic from `auth.ts:34-41`.

Reference file: `src/auth.ts`

### Job Runner (`src/web/runner.ts`)
- `spawnJob(script, args)` → generates ID via `crypto.randomUUID()`, spawns `npx tsx src/<script>.ts ...args` with CWD = project root
- Line-buffers stdout/stderr, broadcasts to SSE listeners
- Detects `^Saved: (.+)$` pattern in stdout → emits special `output_file` SSE event
- Only one job at a time (Telegram client connection may conflict)
- `process.on('SIGINT')` cleanup kills active child processes

Reference files: `src/utils/fs.ts` (saveJson prints "Saved: ..." pattern), `src/utils/retry.ts` (retry logs visible in stream)

### Server (`src/web/server.ts`)
- `node:http` createServer, URL-based routing switch
- Static file serving: `/` → `web/index.html`, `/*.css` → `web/style.css`, `/*.js` → `web/app.js`
- CORS not needed (same origin)
- Port from `CASTELET_PORT` env var or default `3333`
- Auto-opens browser on macOS (`open http://localhost:3333`)

### Frontend (`web/app.js`)
- Step navigation via CSS class toggling (`.step.active`)
- `EventSource` for log streaming with auto-scroll
- File dropdowns refresh on step activation
- Output file auto-selection across steps via URL param or global state

## Implementation Order

1. **Server skeleton + static serving** — `server.ts`, `index.html` shell, `style.css`, `app.js` navigation. Add `"ui"` script to `package.json`. Verify page loads.
2. **File listing API** — `GET /api/files/*` endpoints + frontend dropdowns. Verify files populate.
3. **Job runner + SSE** — `runner.ts`, run endpoints, SSE stream. Wire Parse form. Verify live log output.
4. **Generate + Send forms** — Wire remaining forms, file pre-selection flow.
5. **Auth handler** — `auth-handler.ts`, auth endpoints, Step 1 UI. Verify full auth from browser.
6. **Polish** — Confirmation dialogs, error states, cancel buttons, browser auto-open, process cleanup.

## Verification

1. `npm run ui` → browser opens at localhost:3333
2. Step 1 shows env var status; if session missing, complete auth from browser
3. Step 2: enter a test chat ID, click Parse, watch logs stream, see completion
4. Step 3: output file auto-selected, pick prompt, click Generate, watch OpenAI call
5. Step 4: generated file auto-selected, confirm send, watch delivery logs
6. All existing CLI commands (`npm run parse`, etc.) still work unchanged
