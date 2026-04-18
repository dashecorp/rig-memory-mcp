# AGENTS.md — rig-memory-mcp

> Session-level rig context lives in [CLAUDE.md](./CLAUDE.md) (which fetches https://rig-research.pages.dev/BRAIN.md on start). This file is repo-local build + convention notes only.

## Build & Test

- Install: `npm install`
- Test: `npm test`
- Migrate dev schema: `node migrate.js`

## Purpose

MCP server exposing persistent agent memory backed by Postgres + pgvector. Tools: `read_memories`, `write_memory`, `mark_used`. See `index.js` for the MCP surface and `db.js` for the schema.

## Conventions

- Embedding model: OpenAI `text-embedding-3-small` (configurable via env).
- Scope enum: `repo`, `rig`, `session` — keep in sync with Conductor-E event schema.
- Kind enum: `learning`, `decision`, `error`, `pattern`, `standard`.
- Importance: 1–5. Hit-count auto-tracked via `mark_used`.
- Memory promotion candidate: importance ≥ 4 AND hit_count ≥ 5 (see docs-memory-drift-lint research).

## Gotchas

- Postgres + pgvector extension required. Local dev uses SQLite fallback (migration path in `db.js`).
- Embedding calls are fire-and-forget; timeout 2s. Failures logged but not propagated.
- Event emission to Conductor-E mirrors MEMORY_WRITE / MEMORY_READ / MEMORY_HIT_USED — payload shape in `events.js`.
