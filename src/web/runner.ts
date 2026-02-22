import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ServerResponse } from "node:http";

export interface Job {
  id: string;
  script: string;
  args: string[];
  process: ChildProcess;
  listeners: Set<ServerResponse>;
  outputFile: string | null;
  done: boolean;
}

const jobs = new Map<string, Job>();
let activeJob: Job | null = null;

const PROJECT_ROOT = resolve(import.meta.dirname, "..", "..");

function broadcast(job: Job, event: string, data: string) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of job.listeners) {
    res.write(payload);
  }
}

export function spawnJob(script: string, args: string[]): Job {
  if (activeJob && !activeJob.done) {
    throw new Error("A job is already running. Wait for it to finish or cancel it.");
  }

  const id = randomUUID();
  const child = spawn("npx", ["tsx", `src/${script}.ts`, ...args], {
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });

  const job: Job = {
    id,
    script,
    args,
    process: child,
    listeners: new Set(),
    outputFile: null,
    done: false,
  };

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
        broadcast(job, "output_file", match[1]);
      }
    }
    if (stderrBuf) broadcast(job, "stderr", stderrBuf);

    job.done = true;
    activeJob = null;
    broadcast(job, "exit", String(code ?? 1));

    // Close all SSE connections
    for (const res of job.listeners) {
      res.end();
    }
    job.listeners.clear();
  });

  jobs.set(id, job);
  activeJob = job;
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job || job.done) return false;
  job.process.kill("SIGTERM");
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
process.on("SIGINT", () => {
  if (activeJob && !activeJob.done) {
    activeJob.process.kill("SIGTERM");
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  if (activeJob && !activeJob.done) {
    activeJob.process.kill("SIGTERM");
  }
  process.exit(0);
});
