import type { IncomingMessage, ServerResponse } from "node:http";
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { resolve, join, extname, basename } from "node:path";
import { spawnJob, getJob, cancelJob, addSSEListener, listActiveJobs } from "./runner.js";
import { startAuth, respondAuth, getAuthStep, cancelAuth } from "./auth-handler.js";
import { listSessions, deleteSession, isValidSessionName, getSession, updateSession } from "../session-store.js";
import { testProxyConnectivity } from "../proxy-check.js";
import type { ProxyConfig } from "../types.js";
import {
  ensureTabWorkspace,
  ensureWorkspaceDirs,
  getWorkspaceSelectedSession,
  isValidTabId,
  listWorkspaceDataFiles,
  resolveWorkspaceDataFile,
  setTabWorkspaceSelectedSession,
  touchTabWorkspace,
} from "./workspace-service.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function error(res: ServerResponse, message: string, status = 400) {
  json(res, { error: message }, status);
}

function requireTabId(req: IncomingMessage, res: ServerResponse): string | null {
  const headerTabId = req.headers["x-tab-id"];
  const queryTabId = (() => {
    try {
      const rawUrl = req.url || "/";
      return new URL(rawUrl, "http://localhost").searchParams.get("tabId");
    } catch {
      return null;
    }
  })();
  const tabId = typeof headerTabId === "string" ? headerTabId : queryTabId;
  if (typeof tabId !== "string" || !isValidTabId(tabId)) {
    error(res, "Missing or invalid X-Tab-Id header", 400);
    return null;
  }
  ensureTabWorkspace(tabId);
  touchTabWorkspace(tabId);
  return tabId;
}

function resolveSessionName(tabId: string, requestedSession: unknown): string {
  const selected =
    typeof requestedSession === "string" && requestedSession
      ? requestedSession
      : getWorkspaceSelectedSession(tabId);
  if (!selected) {
    throw new Error("No session selected for this tab.");
  }
  if (!getSession(selected)) {
    throw new Error(`Session "${selected}" not found.`);
  }
  return selected;
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function listFiles(dir: string, extensions: string[]): Array<{
  name: string;
  size: number;
  mtime: string;
}> {
  const fullPath = resolve(PROJECT_ROOT, dir);
  try {
    return readdirSync(fullPath)
      .filter((f) => extensions.includes(extname(f).toLowerCase()))
      .map((f) => {
        const stat = statSync(join(fullPath, f));
        return { name: f, size: stat.size, mtime: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  } catch {
    return [];
  }
}

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  path: string
): Promise<void> {
  // GET /api/env
  if (path === "/api/env" && req.method === "GET") {
    json(res, {
      TG_API_ID: !!process.env.TG_API_ID,
      TG_API_HASH: !!process.env.TG_API_HASH,
      TG_SESSION: !!process.env.TG_SESSION,
      OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
      OPENAI_MODEL: process.env.OPENAI_MODEL || "gpt-4o",
    });
    return;
  }

  // POST /api/auth/start
  if (path === "/api/auth/start" && req.method === "POST") {
    const tabId = requireTabId(req, res);
    if (!tabId) return;
    try {
      const body = await readBody(req);
      const sessionName = (typeof body.sessionName === "string" && body.sessionName) ? body.sessionName : "default";
      const proxy = body.proxy as ProxyConfig | undefined;
      const result = await startAuth(tabId, sessionName, proxy);
      json(res, result);
    } catch (err: any) {
      error(res, err.message);
    }
    return;
  }

  // POST /api/proxy/test
  if (path === "/api/proxy/test" && req.method === "POST") {
    const tabId = requireTabId(req, res);
    if (!tabId) return;
    try {
      const body = await readBody(req);
      const proxy = body.proxy as ProxyConfig | undefined;
      if (!proxy || !proxy.ip || !proxy.port) {
        error(res, "Missing proxy configuration");
        return;
      }
      await testProxyConnectivity(proxy);
      json(res, { ok: true });
    } catch (err: any) {
      json(res, { ok: false, error: err.message });
    }
    return;
  }

  // POST /api/auth/respond
  if (path === "/api/auth/respond" && req.method === "POST") {
    const tabId = requireTabId(req, res);
    if (!tabId) return;
    try {
      const body = await readBody(req);
      if (typeof body.value !== "string") {
        error(res, "Missing 'value' field");
        return;
      }
      const prevStep = getAuthStep(tabId)?.step;
      const result = respondAuth(tabId, body.value);
      // Poll until the step changes or an error appears (up to 15s)
      let updated = getAuthStep(tabId);
      for (let i = 0; i < 30; i++) {
        updated = getAuthStep(tabId);
        if (!updated || updated.step !== prevStep || updated.error) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      json(res, updated || result);
    } catch (err: any) {
      error(res, err.message);
    }
    return;
  }

  // GET /api/auth/status
  if (path === "/api/auth/status" && req.method === "GET") {
    const tabId = requireTabId(req, res);
    if (!tabId) return;
    const state = getAuthStep(tabId);
    json(res, state || { step: null });
    return;
  }

  // POST /api/auth/cancel
  if (path === "/api/auth/cancel" && req.method === "POST") {
    const tabId = requireTabId(req, res);
    if (!tabId) return;
    await cancelAuth(tabId);
    json(res, { ok: true });
    return;
  }

  // GET /api/files/data
  if (path === "/api/files/data" && req.method === "GET") {
    const tabId = requireTabId(req, res);
    if (!tabId) return;
    json(res, listWorkspaceDataFiles(tabId));
    return;
  }

  // GET /api/files/prompts
  if (path === "/api/files/prompts" && req.method === "GET") {
    json(res, listFiles("prompts", [".txt", ".md"]));
    return;
  }

  // GET /api/files/data/:filename
  const dataFileMatch = path.match(/^\/api\/files\/data\/(.+)$/);
  if (dataFileMatch && req.method === "GET") {
    const tabId = requireTabId(req, res);
    if (!tabId) return;
    const filename = decodeURIComponent(dataFileMatch[1]);
    try {
      const content = readFileSync(resolveWorkspaceDataFile(tabId, filename), "utf-8");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(content);
    } catch {
      error(res, "File not found", 404);
    }
    return;
  }

  // GET /api/files/prompts/:filename
  const promptFileMatch = path.match(/^\/api\/files\/prompts\/(.+)$/);
  if (promptFileMatch && req.method === "GET") {
    const filename = decodeURIComponent(promptFileMatch[1]);
    if (filename.includes("..") || filename.includes("/")) {
      error(res, "Invalid filename", 403);
      return;
    }
    try {
      const content = readFileSync(
        resolve(PROJECT_ROOT, "prompts", filename),
        "utf-8"
      );
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(content);
    } catch {
      error(res, "File not found", 404);
    }
    return;
  }

  // POST /api/run/parse
  if (path === "/api/run/parse" && req.method === "POST") {
    const tabId = requireTabId(req, res);
    if (!tabId) return;
    try {
      const body = await readBody(req);
      const mode = body.mode as string;
      const chatId = body.chatId as string;
      if (!mode || !chatId) {
        error(res, "Missing 'mode' or 'chatId'");
        return;
      }

      const sessionName = resolveSessionName(tabId, body.session);

      const args: string[] = [mode, chatId];
      if (mode === "messages" && body.limit) {
        args.push("--limit", String(body.limit));
      }
      if (mode === "comments") {
        if (body.posts) args.push("--posts", String(body.posts));
        if (body.commentsPerPost)
          args.push("--comments-per-post", String(body.commentsPerPost));
      }
      args.push("--session", sessionName);

      const workspaceDir = ensureWorkspaceDirs(tabId).dataDir;
      const job = spawnJob("parser", args, tabId, workspaceDir, sessionName);
      json(res, { jobId: job.id });
    } catch (err: any) {
      error(res, err.message);
    }
    return;
  }

  // POST /api/run/generate
  if (path === "/api/run/generate" && req.method === "POST") {
    const tabId = requireTabId(req, res);
    if (!tabId) return;
    try {
      const body = await readBody(req);
      const inputFile = body.inputFile as string;
      const promptFile = body.promptFile as string;
      if (!inputFile || !promptFile) {
        error(res, "Missing 'inputFile' or 'promptFile'");
        return;
      }

      const workspaceDir = ensureWorkspaceDirs(tabId).dataDir;
      const args = [
        resolveWorkspaceDataFile(tabId, inputFile),
        "--prompt",
        resolve(PROJECT_ROOT, "prompts", promptFile),
      ];

      const job = spawnJob("generator", args, tabId, workspaceDir);
      json(res, { jobId: job.id });
    } catch (err: any) {
      error(res, err.message);
    }
    return;
  }

  // POST /api/run/send
  if (path === "/api/run/send" && req.method === "POST") {
    const tabId = requireTabId(req, res);
    if (!tabId) return;
    try {
      const body = await readBody(req);
      const inputFile = body.inputFile as string;
      if (!inputFile) {
        error(res, "Missing 'inputFile'");
        return;
      }

      const sessionName = resolveSessionName(tabId, body.session);

      const workspaceDir = ensureWorkspaceDirs(tabId).dataDir;
      const args = [resolveWorkspaceDataFile(tabId, inputFile)];
      if (body.mode) args.push("--mode", String(body.mode));
      if (body.delay) args.push("--delay", String(body.delay));
      args.push("--session", sessionName);

      const job = spawnJob("sender", args, tabId, workspaceDir, sessionName);
      json(res, { jobId: job.id });
    } catch (err: any) {
      error(res, err.message);
    }
    return;
  }

  // GET /api/stream/:jobId
  const streamMatch = path.match(/^\/api\/stream\/([a-f0-9-]+)$/);
  if (streamMatch && req.method === "GET") {
    const tabId = requireTabId(req, res);
    if (!tabId) return;
    const job = getJob(streamMatch[1]);
    if (!job || job.tabId !== tabId) {
      error(res, "Job not found", 404);
      return;
    }
    addSSEListener(job, res);
    return;
  }

  // POST /api/run/:jobId/cancel
  const cancelMatch = path.match(/^\/api\/run\/([a-f0-9-]+)\/cancel$/);
  if (cancelMatch && req.method === "POST") {
    const tabId = requireTabId(req, res);
    if (!tabId) return;
    const job = getJob(cancelMatch[1]);
    if (!job || job.tabId !== tabId) {
      error(res, "Job not found", 404);
      return;
    }
    const ok = cancelJob(cancelMatch[1]);
    json(res, { ok });
    return;
  }

  // GET /api/sessions
  if (path === "/api/sessions" && req.method === "GET") {
    const tabId = requireTabId(req, res);
    if (!tabId) return;
    const all = listSessions();
    const selected = getWorkspaceSelectedSession(tabId);
    json(res, { active: selected ?? "", sessions: all.sessions });
    return;
  }

  // POST /api/sessions/active (tab-scoped)
  if (path === "/api/sessions/active" && req.method === "POST") {
    const tabId = requireTabId(req, res);
    if (!tabId) return;
    try {
      const body = await readBody(req);
      const name = body.name as string;
      if (!name || !isValidSessionName(name)) {
        error(res, "Invalid session name");
        return;
      }
      if (!getSession(name)) {
        error(res, "Session not found", 404);
        return;
      }
      setTabWorkspaceSelectedSession(tabId, name);
      json(res, { ok: true });
    } catch (err: any) {
      error(res, err.message);
    }
    return;
  }

  // POST /api/workspace/session
  if (path === "/api/workspace/session" && req.method === "POST") {
    const tabId = requireTabId(req, res);
    if (!tabId) return;
    try {
      const body = await readBody(req);
      const name = body.name;
      if (name === null || name === "") {
        setTabWorkspaceSelectedSession(tabId, null);
        json(res, { ok: true });
        return;
      }
      if (typeof name !== "string" || !isValidSessionName(name)) {
        error(res, "Invalid session name");
        return;
      }
      if (!getSession(name)) {
        error(res, "Session not found", 404);
        return;
      }
      setTabWorkspaceSelectedSession(tabId, name);
      json(res, { ok: true });
    } catch (err: any) {
      error(res, err.message);
    }
    return;
  }

  // DELETE /api/sessions/:name
  const sessionDeleteMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionDeleteMatch && req.method === "DELETE") {
    const tabId = requireTabId(req, res);
    if (!tabId) return;
    const name = decodeURIComponent(sessionDeleteMatch[1]);
    const ok = deleteSession(name);
    if (ok && getWorkspaceSelectedSession(tabId) === name) {
      const sessions = listSessions().sessions;
      setTabWorkspaceSelectedSession(tabId, sessions[0]?.name ?? null);
    }
    json(res, { ok });
    return;
  }

  // PUT /api/sessions/:name
  const sessionUpdateMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionUpdateMatch && req.method === "PUT") {
    const tabId = requireTabId(req, res);
    if (!tabId) return;
    try {
      const name = decodeURIComponent(sessionUpdateMatch[1]);
      const body = await readBody(req);

      const patch: {
        displayName?: string;
        phone?: string;
        proxy?: ProxyConfig;
        clearProxy?: boolean;
      } = {};

      if (body.displayName !== undefined) {
        if (typeof body.displayName !== "string") {
          error(res, "Invalid displayName");
          return;
        }
        patch.displayName = body.displayName.trim();
      }

      if (body.phone !== undefined) {
        if (typeof body.phone !== "string") {
          error(res, "Invalid phone");
          return;
        }
        patch.phone = body.phone.trim();
      }

      if (body.clearProxy === true) {
        patch.clearProxy = true;
      } else if (body.proxy !== undefined) {
        const proxy = body.proxy as ProxyConfig;
        if (!proxy || typeof proxy.ip !== "string" || typeof proxy.port !== "number") {
          error(res, "Invalid proxy");
          return;
        }
        patch.proxy = proxy;
      }

      const ok = updateSession(name, patch);
      if (!ok) {
        error(res, "Session not found", 404);
        return;
      }

      if (getWorkspaceSelectedSession(tabId) === name) {
        setTabWorkspaceSelectedSession(tabId, name);
      }
      json(res, { ok: true });
    } catch (err: any) {
      error(res, err.message || "Failed to update session");
    }
    return;
  }

  // GET /api/jobs/active
  if (path === "/api/jobs/active" && req.method === "GET") {
    const tabId = requireTabId(req, res);
    if (!tabId) return;
    json(res, listActiveJobs().filter((job) => job.tabId === tabId));
    return;
  }

  // PUT /api/files/data/:filename
  const dataPutMatch = path.match(/^\/api\/files\/data\/(.+)$/);
  if (dataPutMatch && req.method === "PUT") {
    const tabId = requireTabId(req, res);
    if (!tabId) return;
    const filename = decodeURIComponent(dataPutMatch[1]);
    try {
      const body = await readBody(req);
      const filePath = resolveWorkspaceDataFile(tabId, filename);
      const existing = JSON.parse(readFileSync(filePath, "utf-8"));
      if (body.generatedTexts) {
        existing.generatedTexts = body.generatedTexts;
      }
      writeFileSync(filePath, JSON.stringify(existing, null, 2), "utf-8");
      json(res, { ok: true });
    } catch (err: any) {
      error(res, err.message || "Failed to update file");
    }
    return;
  }

  error(res, "Not found", 404);
}
