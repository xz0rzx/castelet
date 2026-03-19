# Per-Tab Sessions (Strict Isolation)

## Current Model

The app now runs in strict workspace mode:

- each browser tab has a `tabId` (`sessionStorage`)
- all stateful API calls include `X-Tab-Id`
- backend persists tab workspace state in SQLite (`data/workspaces.db`)
- parse/generate/send data files are isolated per tab in `data/workspaces/<tabId>/data`

## What This Prevents

- no silent fallback to global/default sessions
- no cross-tab access to generated/parsed files
- no cross-tab job stream/cancel access
- invalid session selection fails explicitly

## Session + Proxy Behavior

- session selection is scoped to the tab workspace (not global active session)
- parse/send resolve only the workspace-selected (or explicitly validated) session
- proxy is loaded from the resolved session and applied by `createClient`
- if proxy check fails, auth/operations fail fast

## Auth Behavior

- auth is scoped by tab
- each tab can run independent auth flow state
- auth state transitions are persisted in SQLite

## Compatibility

- requests missing `X-Tab-Id` are rejected with `400`
- existing frontend now auto-injects the header via centralized fetch wrapper
