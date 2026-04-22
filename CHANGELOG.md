# Changelog

## [2.1.1] — 2026-04-17

### Bug Fixes

* **SQLite startup crash** — `createSqliteBackend()` now calls `mkdirSync(dir, { recursive: true })`
  before opening the DB, so parent directories (`$HOME/.rig-memory/`) are created automatically.
  Previously the process exited with `TypeError: Cannot open database because the directory does
  not exist` whenever Postgres was unavailable (fixes #3).
* **Log prefix** — all `console.error` lines now use `[rig-memory]` instead of the stale v1
  `[claude-memory]` prefix.
* **Event schema** — payload fields renamed to PascalCase to match rig-conductor's
  `SubmitEventRequest` contract (`MEMORY_WRITE`, `MEMORY_READ`, `MEMORY_HIT_USED`). v2.1.0
  was emitting camelCase types that returned HTTP 400.

### Features

* **`MEMORY_STRICT` env var** — set `MEMORY_STRICT=true` to make the server exit (rather than
  fall back to SQLite) when Postgres authentication fails.
* **`SQLITE_PATH` env var** — override the default SQLite database path
  (`$HOME/.rig-memory/memory.db`).
* **SQLite test suite** — `test.js` now includes a full SQLite backend suite (directory
  auto-creation, all five CRUD ops, FTS5 special-char fallback, tag deserialisation, compaction).
  Runs without `DB_URL`.

## [2.1.0] — 2026-04-17

### Features

* **Event emission** — every MCP tool call mirrors a structured event to rig-conductor's
  `/api/events` endpoint (`MEMORY_WRITE`, `MEMORY_READ`, `MEMORY_HIT_USED`). Fire-and-forget
  with a 2-second timeout; failures are logged but never surface to the caller. Disabled when
  `CONDUCTOR_BASE_URL` is unset.

## [2.0.0] — 2026-04-16

### Features (rewrite)

* Replaced SQLite/Firestore backend with **Postgres + pgvector** hybrid search.
* New `rig_memory` schema: `tsvector` BM25 + cosine vector similarity (`text-embedding-3-small`).
  Hybrid score = text × 0.35 + vector × 0.65.
* Five MCP tools: `write_memory`, `read_memories`, `list_recent`, `mark_used`, `compact_repo`.
* SQLite + FTS5 **fallback backend** — used automatically when `DB_URL` is unset.
* `compact_repo` — groups old memories by `scope`+`kind`, collapses to single summary, prunes
  originals and expired entries.
* Dockerfile + GitHub Packages publish workflow.

---

## [1.1.0] — 2026-03-05 (legacy claude-memory-mcp)

See [historical changelog](https://github.com/Stig-Johnny/claude-memory-mcp/blob/main/CHANGELOG.md)
for v1.x entries (SQLite/Firestore era).
