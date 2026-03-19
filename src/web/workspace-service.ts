import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createAuthFlow,
  createJob,
  deleteStaleWorkspaces,
  ensureWorkspace,
  getActiveAuthFlowForTab,
  getLatestAuthFlowForTab,
  getRunningJobsForTab,
  getWorkspace,
  heartbeatWorkspace,
  initWorkspaceStore,
  setWorkspaceSelectedSession,
  updateAuthFlowError,
  updateAuthFlowPhone,
  updateAuthFlowStep,
  updateJobStatus,
  type AuthStep,
  type JobScript,
  type JobStatus,
} from "./workspace-store.js";
import type { ProxyConfig } from "../types.js";

const WORKSPACES_ROOT = resolve(process.cwd(), "data", "workspaces");

export function initWorkspaceServices(): void {
  initWorkspaceStore();
  if (!existsSync(WORKSPACES_ROOT)) {
    mkdirSync(WORKSPACES_ROOT, { recursive: true });
  }
}

export function isValidTabId(tabId: string): boolean {
  return /^[a-zA-Z0-9_-]{8,128}$/.test(tabId);
}

export function ensureTabWorkspace(tabId: string): void {
  ensureWorkspace(tabId);
  ensureWorkspaceDirs(tabId);
}

export function touchTabWorkspace(tabId: string): void {
  heartbeatWorkspace(tabId);
  ensureWorkspaceDirs(tabId);
}

export function getWorkspaceSelectedSession(tabId: string): string | null {
  return getWorkspace(tabId)?.selectedSessionName ?? null;
}

export function setTabWorkspaceSelectedSession(tabId: string, sessionName: string | null): void {
  setWorkspaceSelectedSession(tabId, sessionName);
}

export function startTabAuthFlow(flowId: string, tabId: string, sessionName: string, proxy?: ProxyConfig): void {
  createAuthFlow(flowId, tabId, sessionName, proxy);
}

export function getTabActiveAuthFlow(tabId: string) {
  return getActiveAuthFlowForTab(tabId);
}

export function getTabLatestAuthFlow(tabId: string) {
  return getLatestAuthFlowForTab(tabId);
}

export function setAuthFlowStep(flowId: string, step: AuthStep): void {
  updateAuthFlowStep(flowId, step);
}

export function setAuthFlowPhone(flowId: string, phone: string): void {
  updateAuthFlowPhone(flowId, phone);
}

export function setAuthFlowError(flowId: string, error: string | null): void {
  updateAuthFlowError(flowId, error);
}

export function registerTabJob(id: string, tabId: string, script: JobScript, sessionName: string | null): void {
  createJob(id, tabId, script, sessionName);
}

export function markTabJobStatus(id: string, status: JobStatus, outputFile?: string | null): void {
  updateJobStatus(id, status, outputFile);
}

export function getRunningJobsForWorkspace(tabId: string) {
  return getRunningJobsForTab(tabId);
}

export function getWorkspacePaths(tabId: string): {
  rootDir: string;
  dataDir: string;
  logsDir: string;
} {
  const rootDir = resolve(WORKSPACES_ROOT, tabId);
  return {
    rootDir,
    dataDir: resolve(rootDir, "data"),
    logsDir: resolve(rootDir, "logs"),
  };
}

export function ensureWorkspaceDirs(tabId: string): {
  rootDir: string;
  dataDir: string;
  logsDir: string;
} {
  const paths = getWorkspacePaths(tabId);
  if (!existsSync(paths.rootDir)) mkdirSync(paths.rootDir, { recursive: true });
  if (!existsSync(paths.dataDir)) mkdirSync(paths.dataDir, { recursive: true });
  if (!existsSync(paths.logsDir)) mkdirSync(paths.logsDir, { recursive: true });
  return paths;
}

export function listWorkspaceDataFiles(tabId: string): Array<{ name: string; size: number; mtime: string }> {
  const { dataDir } = ensureWorkspaceDirs(tabId);
  return readdirSync(dataDir)
    .map((name) => ({ name, fullPath: join(dataDir, name) }))
    .filter(({ name, fullPath }) => name.endsWith(".json") && statSync(fullPath).isFile())
    .map(({ name, fullPath }) => {
      const stat = statSync(fullPath);
      return { name, size: stat.size, mtime: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.mtime.localeCompare(a.mtime));
}

export function resolveWorkspaceDataFile(tabId: string, filename: string): string {
  const { dataDir } = ensureWorkspaceDirs(tabId);
  if (!filename || filename.includes("..") || filename.includes("/")) {
    throw new Error("Invalid filename");
  }
  const full = resolve(dataDir, filename);
  if (!full.startsWith(dataDir)) {
    throw new Error("Invalid filename");
  }
  return full;
}

export function cleanupStaleWorkspaces(ttlMs: number): string[] {
  const olderThanIso = new Date(Date.now() - ttlMs).toISOString();
  const deletedTabIds = deleteStaleWorkspaces(olderThanIso);
  for (const tabId of deletedTabIds) {
    const { rootDir } = getWorkspacePaths(tabId);
    if (existsSync(rootDir)) {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }
  return deletedTabIds;
}
