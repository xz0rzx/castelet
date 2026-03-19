import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ServerResponse } from "node:http";
import { getRunningJobsForWorkspace, markTabJobStatus, registerTabJob } from "./workspace-service.js";

export interface Job {
  id: string;
  script: string;
  args: string[];
  session: string | null;
  tabId: string;
  workspaceDir: string;
  process: ChildProcess;
  listeners: Set<ServerResponse>;
  outputFile: string | null;
  done: boolean;
}

const jobs = new Map<string, Job>();

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");

function broadcast(job: Job, event: string, data: string) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of job.listeners) {
    res.write(payload);
  }
}

export function spawnJob(
  script: "parser" | "generator" | "sender",
  args: string[],
  tabId: string,
  workspaceDir: string,
  session?: string,
): Job {
  const sess = session ?? null;

  const runningForTab = getRunningJobsForWorkspace(tabId);
  if (runningForTab.length > 0) {
    throw new Error(`A job is already running in this tab. Wait for it to finish or cancel it.`);
  }

  if (sess) {
    for (const j of jobs.values()) {
      if (!j.done && j.session === sess) {
        throw new Error(`A job is already running on session "${sess}". Wait for it to finish or cancel it.`);
      }
    }
  }

  const id = randomUUID();
  const child = spawn("npx", ["tsx", `src/${script}.ts`, ...args, "--workspace-dir", workspaceDir], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  const job: Job = {
    id,
    script,
    args,
    session: sess,
    tabId,
    workspaceDir,
    process: child,
    listeners: new Set(),
    outputFile: null,
    done: false,
  };
  registerTabJob(id, tabId, script, sess);

  const savedPattern = /^Saved: (.+)$/;

  let stdoutBuf = "";
  child.stdout!.on("data", (chunk: Buffer) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop()!;
    for (const line of lines) {
      broadcast(job, "stdout", line);
      const match = line.match(savedPattern);
      if (match) {
        job.outputFile = match[1];
        markTabJobStatus(job.id, "running", match[1]);
        broadcast(job, "output_file", match[1]);
      }
    }
  });

  let stderrBuf = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString();
    const lines = stderrBuf.split("\n");
    stderrBuf = lines.pop()!;
    for (const line of lines) {
      broadcast(job, "stderr", line);
    }
  });

  child.on("close", (code) => {
    // Flush remaining buffers
    if (stdoutBuf) {
      broadcast(job, "stdout", stdoutBuf);
      const match = stdoutBuf.match(savedPattern);
      if (match) {
        job.outputFile = match[1];
        markTabJobStatus(job.id, "running", match[1]);
        broadcast(job, "output_file", match[1]);
      }
    }
    if (stderrBuf) broadcast(job, "stderr", stderrBuf);

    job.done = true;
    markTabJobStatus(job.id, code === 0 ? "done" : "failed");
    broadcast(job, "exit", String(code ?? 1));

    // Close all SSE connections
    for (const res of job.listeners) {
      res.end();
    }
    job.listeners.clear();
  });

  jobs.set(id, job);
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listActiveJobs(): Array<{ id: string; script: string; session: string | null; done: boolean; tabId: string }> {
  const result: Array<{ id: string; script: string; session: string | null; done: boolean; tabId: string }> = [];
  for (const job of jobs.values()) {
    if (!job.done) {
      result.push({ id: job.id, script: job.script, session: job.session, done: job.done, tabId: job.tabId });
    }
  }
  return result;
}

export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.done) return false;
  job.process.kill("SIGTERM");
  markTabJobStatus(id, "cancelled");
  return true;
}

export function addSSEListener(job: Job, res: ServerResponse) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  job.listeners.add(res);
  res.on("close", () => {
    job.listeners.delete(res);
  });
  // If job already done, send exit immediately
  if (job.done) {
    res.write(`event: exit\ndata: "0"\n\n`);
    res.end();
  }
}

// Cleanup on process exit
function killAllActiveJobs() {
  for (const job of jobs.values()) {
    if (!job.done) {
      job.process.kill("SIGTERM");
    }
  }
}

process.on("SIGINT", () => {
  killAllActiveJobs();
  process.exit(0);
});

process.on("SIGTERM", () => {
  killAllActiveJobs();
  process.exit(0);
});
