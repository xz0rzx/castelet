import type { IncomingMessage, ServerResponse } from "node:http";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join, extname, basename } from "node:path";
import { spawnJob, getJob, cancelJob, addSSEListener } from "./runner.js";
import { startAuth, respondAuth, getAuthStep, cancelAuth } from "./auth-handler.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");

function json(res: ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function error(res: ServerResponse, message: string, status = 400) {
  json(res, { error: message }, status);
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
    try {
      const result = await startAuth();
      json(res, result);
    } catch (err: any) {
      error(res, err.message);
    }
    return;
  }

  // POST /api/auth/respond
  if (path === "/api/auth/respond" && req.method === "POST") {
    try {
      const body = await readBody(req);
      if (typeof body.value !== "string") {
        error(res, "Missing 'value' field");
        return;
      }
      const result = respondAuth(body.value);
      // Wait a moment for next step to be set
      await new Promise((r) => setTimeout(r, 1000));
      const updated = getAuthStep();
      json(res, updated || result);
    } catch (err: any) {
      error(res, err.message);
    }
    return;
  }

  // GET /api/auth/status
  if (path === "/api/auth/status" && req.method === "GET") {
    const state = getAuthStep();
    json(res, state || { step: null });
    return;
  }

  // POST /api/auth/cancel
  if (path === "/api/auth/cancel" && req.method === "POST") {
    await cancelAuth();
    json(res, { ok: true });
    return;
  }

  // GET /api/files/data
  if (path === "/api/files/data" && req.method === "GET") {
    json(res, listFiles("data", [".json"]));
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
    const filename = decodeURIComponent(dataFileMatch[1]);
    if (filename.includes("..") || filename.includes("/")) {
      error(res, "Invalid filename", 403);
      return;
    }
    try {
      const content = readFileSync(
        resolve(PROJECT_ROOT, "data", filename),
        "utf-8"
      );
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
    try {
      const body = await readBody(req);
      const mode = body.mode as string;
      const chatId = body.chatId as string;
      if (!mode || !chatId) {
        error(res, "Missing 'mode' or 'chatId'");
        return;
      }

      const args: string[] = [mode, chatId];
      if (mode === "messages" && body.limit) {
        args.push("--limit", String(body.limit));
      }
      if (mode === "comments") {
        if (body.posts) args.push("--posts", String(body.posts));
        if (body.commentsPerPost)
          args.push("--comments-per-post", String(body.commentsPerPost));
      }

      const job = spawnJob("parser", args);
      json(res, { jobId: job.id });
    } catch (err: any) {
      error(res, err.message);
    }
    return;
  }

  // POST /api/run/generate
  if (path === "/api/run/generate" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const inputFile = body.inputFile as string;
      const promptFile = body.promptFile as string;
      if (!inputFile || !promptFile) {
        error(res, "Missing 'inputFile' or 'promptFile'");
        return;
      }

      const args = [
        resolve(PROJECT_ROOT, "data", inputFile),
        "--prompt",
        resolve(PROJECT_ROOT, "prompts", promptFile),
      ];

      const job = spawnJob("generator", args);
      json(res, { jobId: job.id });
    } catch (err: any) {
      error(res, err.message);
    }
    return;
  }

  // POST /api/run/send
  if (path === "/api/run/send" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const inputFile = body.inputFile as string;
      if (!inputFile) {
        error(res, "Missing 'inputFile'");
        return;
      }

      const args = [resolve(PROJECT_ROOT, "data", inputFile)];
      if (body.mode) args.push("--mode", String(body.mode));
      if (body.delay) args.push("--delay", String(body.delay));

      const job = spawnJob("sender", args);
      json(res, { jobId: job.id });
    } catch (err: any) {
      error(res, err.message);
    }
    return;
  }

  // GET /api/stream/:jobId
  const streamMatch = path.match(/^\/api\/stream\/([a-f0-9-]+)$/);
  if (streamMatch && req.method === "GET") {
    const job = getJob(streamMatch[1]);
    if (!job) {
      error(res, "Job not found", 404);
      return;
    }
    addSSEListener(job, res);
    return;
  }

  // POST /api/run/:jobId/cancel
  const cancelMatch = path.match(/^\/api\/run\/([a-f0-9-]+)\/cancel$/);
  if (cancelMatch && req.method === "POST") {
    const ok = cancelJob(cancelMatch[1]);
    json(res, { ok });
    return;
  }

  error(res, "Not found", 404);
}
