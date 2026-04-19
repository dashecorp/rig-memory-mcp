# AGENTS.md — rig-memory-mcp

> Session-level rig context lives in [CLAUDE.md](./CLAUDE.md) (which fetches https://rig-research.pages.dev/BRAIN.md on start). This file is repo-local build + convention notes only.

## Build & Test

- Install: `npm install`
- Test (SQLite only — no DB needed): `AGENT_ROLE=test node test.js`
- Test (full — SQLite + Postgres): `DB_URL=postgres://... AGENT_ROLE=test node test.js`
- Migrate dev schema: `node migrate.js`

The SQLite suite always runs. The Postgres suite is skipped when `DB_URL` is unset.

## Purpose

MCP server exposing persistent agent memory backed by Postgres + pgvector. Tools: `read_memories`, `write_memory`, `mark_used`. See `index.js` for the MCP surface and `db.js` for the schema.

## Conventions

- Embedding model: OpenAI `text-embedding-3-small` (configurable via env).
- Scope enum: `repo`, `rig`, `session` — keep in sync with rig-conductor event schema.
- Kind enum: `learning`, `decision`, `error`, `pattern`, `standard`.
- Importance: 1–5. Hit-count auto-tracked via `mark_used`.
- Memory promotion candidate: importance ≥ 4 AND hit_count ≥ 5 (see docs-memory-drift-lint research).

## Gotchas

- Postgres + pgvector extension required for primary backend. Local dev and pods without `DB_URL` use SQLite fallback automatically.
- SQLite default path: `$HOME/.rig-memory/memory.db`. Parent directory is created on startup if it doesn't exist.
- Set `MEMORY_STRICT=true` to make the server exit (rather than fall back) when Postgres auth fails.
- Embedding calls are fire-and-forget; timeout 2s. Failures logged but not propagated.
- Event emission to rig-conductor mirrors MEMORY_WRITE / MEMORY_READ / MEMORY_HIT_USED — payload shape in `events.js`.
