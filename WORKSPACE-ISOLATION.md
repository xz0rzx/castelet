# Workspace Isolation Architecture

## Overview

Castelet uses strict per-tab isolation for all runtime workflows:

- tab identity (`tabId`) is generated client-side and sent on every stateful request
- workspace state is persisted in SQLite (`data/workspaces.db`)
- artifacts are stored under `data/workspaces/<tabId>/...`

This prevents accidental cross-tab session/proxy mix-ups.

## Components

- `src/web/workspace-store.ts`
  - SQLite schema and CRUD for workspaces, auth flows, and jobs
- `src/web/workspace-service.ts`
  - service helpers for tab lifecycle, workspace paths, file access, and cleanup
- `src/web/api.ts`
  - strict `X-Tab-Id` enforcement and workspace-scoped API routing
- `src/web/auth-handler.ts`
  - tab-scoped runtime auth with persisted auth flow state
- `src/web/runner.ts`
  - job ownership by tab and workspace-aware process execution

## Data Storage

- DB: `data/workspaces.db`
  - `workspaces`: selected session + heartbeat
  - `auth_flows`: per-tab auth progression and errors
  - `jobs`: tab-owned runtime jobs and outputs
- FS: `data/workspaces/<tabId>/`
  - `data/` for parse/generate artifacts
  - `logs/` reserved for runtime/log retention

## Runtime Rules

- every stateful route requires a valid `X-Tab-Id` (or `tabId` query for SSE)
- parse/send must resolve a valid selected session; no implicit global fallback
- job stream/cancel only works for jobs owned by the same tab
- workspace file APIs are path-scoped to that tab directory

## Cleanup

- server runs periodic stale workspace cleanup (default TTL: 7 days)
- stale DB records and workspace directories are deleted together
