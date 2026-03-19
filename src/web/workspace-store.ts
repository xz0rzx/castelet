import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";
import type { ProxyConfig } from "../types.js";

export type AuthStep = "phone" | "code" | "password" | "done" | "error" | "cancelled";
export type JobStatus = "running" | "done" | "failed" | "cancelled";
export type JobScript = "parser" | "generator" | "sender";

export interface WorkspaceRecord {
  tabId: string;
  selectedSessionName: string | null;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export interface AuthFlowRecord {
  id: string;
  tabId: string;
  sessionName: string;
  step: AuthStep;
  phone: string | null;
  errorMessage: string | null;
  proxy: ProxyConfig | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface JobRecord {
  id: string;
  tabId: string;
  sessionName: string | null;
  script: JobScript;
  status: JobStatus;
  outputFile: string | null;
  startedAt: string;
  endedAt: string | null;
}

const DATA_DIR = resolve(process.cwd(), "data");
const DB_PATH = resolve(DATA_DIR, "workspaces.db");

if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function nowIso(): string {
  return new Date().toISOString();
}

function parseProxy(value: string | null): ProxyConfig | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as ProxyConfig;
  } catch {
    return null;
  }
}

function mapWorkspaceRow(row: any): WorkspaceRecord {
  return {
    tabId: row.tab_id,
    selectedSessionName: row.selected_session_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
  };
}

function mapAuthFlowRow(row: any): AuthFlowRecord {
  return {
    id: row.id,
    tabId: row.tab_id,
    sessionName: row.session_name,
    step: row.step,
    phone: row.phone,
    errorMessage: row.error_message,
    proxy: parseProxy(row.proxy_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function mapJobRow(row: any): JobRecord {
  return {
    id: row.id,
    tabId: row.tab_id,
    sessionName: row.session_name,
    script: row.script,
    status: row.status,
    outputFile: row.output_file,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

export function initWorkspaceStore(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      tab_id TEXT PRIMARY KEY,
      selected_session_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS auth_flows (
      id TEXT PRIMARY KEY,
      tab_id TEXT NOT NULL,
      session_name TEXT NOT NULL,
      step TEXT NOT NULL,
      phone TEXT,
      error_message TEXT,
      proxy_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY(tab_id) REFERENCES workspaces(tab_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      tab_id TEXT NOT NULL,
      session_name TEXT,
      script TEXT NOT NULL,
      status TEXT NOT NULL,
      output_file TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      FOREIGN KEY(tab_id) REFERENCES workspaces(tab_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_workspaces_last_seen ON workspaces(last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_tab_status ON jobs(tab_id, status);
    CREATE INDEX IF NOT EXISTS idx_auth_tab_step ON auth_flows(tab_id, step);
  `);
}

export function ensureWorkspace(tabId: string): WorkspaceRecord {
  const existing = db
    .prepare("SELECT * FROM workspaces WHERE tab_id = ?")
    .get(tabId);
  const ts = nowIso();
  if (!existing) {
    db.prepare(`
      INSERT INTO workspaces(tab_id, selected_session_name, created_at, updated_at, last_seen_at)
      VALUES (?, NULL, ?, ?, ?)
    `).run(tabId, ts, ts, ts);
  } else {
    db.prepare(`
      UPDATE workspaces
      SET updated_at = ?, last_seen_at = ?
      WHERE tab_id = ?
    `).run(ts, ts, tabId);
  }
  return getWorkspace(tabId)!;
}

export function getWorkspace(tabId: string): WorkspaceRecord | null {
  const row = db
    .prepare("SELECT * FROM workspaces WHERE tab_id = ?")
    .get(tabId);
  if (!row) return null;
  return mapWorkspaceRow(row);
}

export function setWorkspaceSelectedSession(tabId: string, sessionName: string | null): void {
  ensureWorkspace(tabId);
  const ts = nowIso();
  db.prepare(`
    UPDATE workspaces
    SET selected_session_name = ?, updated_at = ?, last_seen_at = ?
    WHERE tab_id = ?
  `).run(sessionName, ts, ts, tabId);
}

export function heartbeatWorkspace(tabId: string): void {
  ensureWorkspace(tabId);
}

export function createAuthFlow(
  flowId: string,
  tabId: string,
  sessionName: string,
  proxy: ProxyConfig | undefined,
): void {
  ensureWorkspace(tabId);
  const ts = nowIso();
  db.prepare(`
    INSERT INTO auth_flows(
      id, tab_id, session_name, step, phone, error_message, proxy_json, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, 'phone', NULL, NULL, ?, ?, ?, NULL)
  `).run(flowId, tabId, sessionName, proxy ? JSON.stringify(proxy) : null, ts, ts);
}

export function getAuthFlowById(flowId: string): AuthFlowRecord | null {
  const row = db.prepare("SELECT * FROM auth_flows WHERE id = ?").get(flowId);
  if (!row) return null;
  return mapAuthFlowRow(row);
}

export function getActiveAuthFlowForTab(tabId: string): AuthFlowRecord | null {
  const row = db.prepare(`
    SELECT * FROM auth_flows
    WHERE tab_id = ? AND step NOT IN ('done', 'error', 'cancelled')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(tabId);
  if (!row) return null;
  return mapAuthFlowRow(row);
}

export function getLatestAuthFlowForTab(tabId: string): AuthFlowRecord | null {
  const row = db.prepare(`
    SELECT * FROM auth_flows
    WHERE tab_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(tabId);
  if (!row) return null;
  return mapAuthFlowRow(row);
}

export function updateAuthFlowStep(flowId: string, step: AuthStep): void {
  const ts = nowIso();
  db.prepare(`
    UPDATE auth_flows
    SET step = ?, updated_at = ?, completed_at = CASE WHEN ? IN ('done', 'error', 'cancelled') THEN ? ELSE completed_at END
    WHERE id = ?
  `).run(step, ts, step, ts, flowId);
}

export function updateAuthFlowPhone(flowId: string, phone: string): void {
  const ts = nowIso();
  db.prepare(`
    UPDATE auth_flows
    SET phone = ?, updated_at = ?
    WHERE id = ?
  `).run(phone, ts, flowId);
}

export function updateAuthFlowError(flowId: string, error: string | null): void {
  const ts = nowIso();
  db.prepare(`
    UPDATE auth_flows
    SET error_message = ?, updated_at = ?, step = CASE WHEN ? IS NULL THEN step ELSE 'error' END, completed_at = CASE WHEN ? IS NULL THEN completed_at ELSE ? END
    WHERE id = ?
  `).run(error, ts, error, error, ts, flowId);
}

export function createJob(
  id: string,
  tabId: string,
  script: JobScript,
  sessionName: string | null,
): void {
  ensureWorkspace(tabId);
  const ts = nowIso();
  db.prepare(`
    INSERT INTO jobs(id, tab_id, session_name, script, status, output_file, started_at, ended_at)
    VALUES (?, ?, ?, ?, 'running', NULL, ?, NULL)
  `).run(id, tabId, sessionName, script, ts);
}

export function updateJobStatus(id: string, status: JobStatus, outputFile?: string | null): void {
  const ts = nowIso();
  db.prepare(`
    UPDATE jobs
    SET status = ?, ended_at = CASE WHEN ? = 'running' THEN ended_at ELSE ? END, output_file = COALESCE(?, output_file)
    WHERE id = ?
  `).run(status, status, ts, outputFile ?? null, id);
}

export function getRunningJobsForTab(tabId: string): JobRecord[] {
  const rows = db.prepare(`
    SELECT * FROM jobs
    WHERE tab_id = ? AND status = 'running'
  `).all(tabId);
  return rows.map(mapJobRow);
}

export function deleteStaleWorkspaces(olderThanIso: string): string[] {
  const staleRows = db.prepare(`
    SELECT tab_id FROM workspaces
    WHERE last_seen_at < ?
  `).all(olderThanIso) as Array<{ tab_id: string }>;
  if (!staleRows.length) return [];
  const ids = staleRows.map((r) => r.tab_id);
  const delStmt = db.prepare("DELETE FROM workspaces WHERE tab_id = ?");
  const tx = db.transaction((tabIds: string[]) => {
    for (const id of tabIds) delStmt.run(id);
  });
  tx(ids);
  return ids;
}
