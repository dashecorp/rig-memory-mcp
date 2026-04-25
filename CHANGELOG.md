# Changelog

## [1.2.0](https://github.com/dashecorp/rig-memory-mcp/compare/rig-memory-mcp-v1.1.0...rig-memory-mcp-v1.2.0) (2026-04-25)


### Features

* Add /load-memory slash command ([0b058bb](https://github.com/dashecorp/rig-memory-mcp/commit/0b058bbf15b59fd6d50386c46d90c5548ee0310c))
* Add category support for decisions and errors (v2.6.0) ([7085c1f](https://github.com/dashecorp/rig-memory-mcp/commit/7085c1f34eb5c060b842993b9fca3b5e57f3c2ba))
* Add list_decisions, memory_stats, bulk_cleanup tools (v2.2.0) ([4a66c11](https://github.com/dashecorp/rig-memory-mcp/commit/4a66c111e2ce4430cbbbcf73c6e502651fb2a7b0))
* Add load_comprehensive_memory function (v2.4.0) ([f342b58](https://github.com/dashecorp/rig-memory-mcp/commit/f342b5829858e51991044c705937d189924eeb96))
* Add memory management tools (v2.1.0) ([9df142d](https://github.com/dashecorp/rig-memory-mcp/commit/9df142d0a6b8e86acb511a6021b580c45e4f5717))
* Add memory tiers for usage tracking (v2.7.0) ([ebbf6f9](https://github.com/dashecorp/rig-memory-mcp/commit/ebbf6f9660160540e218673cfb52c16177049bd3))
* Add optional Firestore cloud sync (v2.0.0) ([dbbdb95](https://github.com/dashecorp/rig-memory-mcp/commit/dbbdb95468cbe5957d5b692e2fd85cd401053f9a))
* add PostgreSQL backend for persistent shared memory ([#26](https://github.com/dashecorp/rig-memory-mcp/issues/26)) ([9d21cfc](https://github.com/dashecorp/rig-memory-mcp/commit/9d21cfcb7e83f37f9fe5560b423eafa61ae23a8a))
* Add priority field for decisions, errors, learnings (v2.5.0) ([ddd8e19](https://github.com/dashecorp/rig-memory-mcp/commit/ddd8e19aeff5308f3b8bca9702dd993e9e8eabaa))
* add temporal decay for memory retrieval ([#12](https://github.com/dashecorp/rig-memory-mcp/issues/12)) ([588daf3](https://github.com/dashecorp/rig-memory-mcp/commit/588daf30ca00608fa18db45bf787f9ffa9d14d5d))
* Add workspace-aware session storage (v2.3.0) ([5517118](https://github.com/dashecorp/rig-memory-mcp/commit/5517118bf6206654db8145caf139f24701a8cc7a))
* emit memory_* events to Conductor-E on every tool call ([#6](https://github.com/dashecorp/rig-memory-mcp/issues/6)) ([3fbd40f](https://github.com/dashecorp/rig-memory-mcp/commit/3fbd40fddbbb418ddd716a608b2df473c8b65b2c))
* rewrite as Postgres + pgvector backed MCP server ([#2](https://github.com/dashecorp/rig-memory-mcp/issues/2)) ([5ef1224](https://github.com/dashecorp/rig-memory-mcp/commit/5ef12240835e10ac16f3c5bc8cfcf5b43ebf10f1)), closes [#1](https://github.com/dashecorp/rig-memory-mcp/issues/1)


### Bug Fixes

* add SQLite fallback backend with directory auto-creation ([#5](https://github.com/dashecorp/rig-memory-mcp/issues/5)) ([b826dcd](https://github.com/dashecorp/rig-memory-mcp/commit/b826dcd4d091bc218e288f34be0224eb397b2427)), closes [#3](https://github.com/dashecorp/rig-memory-mcp/issues/3)
* **ci:** replace peter-evans auto-merge with github-script ([#18](https://github.com/dashecorp/rig-memory-mcp/issues/18)) ([598864d](https://github.com/dashecorp/rig-memory-mcp/commit/598864d0a34699e6d9d24e52a091baa875dba668))
* Correct author name in LICENSE and package.json ([a07de6d](https://github.com/dashecorp/rig-memory-mcp/commit/a07de6d4bf5322e9224a7cdd726f4f0430fc5e40))
* Correct author name to Stig-Johnny Stoebakk ([8c3af0f](https://github.com/dashecorp/rig-memory-mcp/commit/8c3af0f63b8b32d6fab4531bfb7c77f242d07297))
* **deps:** update @modelcontextprotocol/sdk to fix ReDoS vulnerability ([064acdc](https://github.com/dashecorp/rig-memory-mcp/commit/064acdcd6785d9c188712057081317a2d8ed0955))
* match Conductor-E event schema (PascalCase + uppercase types) ([#7](https://github.com/dashecorp/rig-memory-mcp/issues/7)) ([51f4d35](https://github.com/dashecorp/rig-memory-mcp/commit/51f4d35d179b1ea5cc8310ec3c723ecacbcf557e))
* populate empty AGENTS.md with repo-local build + convention notes ([#8](https://github.com/dashecorp/rig-memory-mcp/issues/8)) ([63b73e7](https://github.com/dashecorp/rig-memory-mcp/commit/63b73e7fedc09b050ffe1f4a0aea29f2a5281fa0))
* strip undefined values before Firestore sync ([#28](https://github.com/dashecorp/rig-memory-mcp/issues/28)) ([5127d77](https://github.com/dashecorp/rig-memory-mcp/commit/5127d773bd54452b0159b722c0d27e40f00a8679))
* Update copyright year to 2025 ([c9f0c63](https://github.com/dashecorp/rig-memory-mcp/commit/c9f0c63232b9a5be76d80210259547e3f9460856))

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
