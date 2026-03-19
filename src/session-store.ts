import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { TgSession, SessionRegistry, ProxyConfig } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSIONS_PATH = resolve(
  __dirname,
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

export function updateSession(
  name: string,
  patch: {
    displayName?: string;
    phone?: string;
    proxy?: ProxyConfig;
    clearProxy?: boolean;
  },
): boolean {
  const reg = loadRegistry();
  const idx = reg.sessions.findIndex((s) => s.name === name);
  if (idx === -1) return false;

  const current = reg.sessions[idx];
  const next: TgSession = {
    ...current,
    ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
    ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
  };

  if (patch.clearProxy) {
    delete next.proxy;
  } else if (patch.proxy) {
    next.proxy = patch.proxy;
  }

  reg.sessions[idx] = next;
  saveRegistry(reg);
  return true;
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
