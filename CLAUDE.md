# CLAUDE.md — rig-memory-mcp

MCP server providing persistent, searchable agent memory backed by Postgres + pgvector.

## Project structure

```
rig-memory-mcp/
├── index.js       # MCP server — tool definitions and handlers
├── db.js          # Postgres layer — schema, queries
├── test.js        # Integration tests (requires Postgres+pgvector)
├── Dockerfile     # Production image (node:22-alpine)
├── package.json
├── README.md
└── docs/
    └── api.md     # Full tool API reference
```

## Tech stack

| Component | Choice |
|---|---|
| Runtime | Node.js 22 (ES modules) |
| DB | Postgres 16 + pgvector |
| Text search | tsvector / ts_rank |
| Vector search | pgvector cosine similarity (HNSW index) |
| Embeddings | OpenAI text-embedding-3-small (optional) |
| MCP SDK | @modelcontextprotocol/sdk |

## Key design decisions

| Decision | Rationale |
|---|---|
| Single `rig_memory` table | Unified schema across all memory types; scope/kind fields differentiate |
| Generated tsvector column | No manual sync needed; always consistent with content |
| HNSW index (not IVFFlat) | No training data required; better cold-start performance |
| Embeddings optional | Server works without OPENAI_API_KEY; text search only |
| hit_count + last_used_at | Tracks which memories are actually useful (mark_used metric) |
| compact_repo groups by scope+kind | Groups related memories for meaningful summaries |

## Environment variables

| Var | Required | Description |
|---|---|---|
| `DB_URL` | ✅ | Postgres connection string |
| `AGENT_ROLE` | ✅ | Agent's role (stamped on all writes) |
| `WRITTEN_BY_AGENT` | — | Defaults to AGENT_ROLE |
| `REPO` | — | Default repo for writes |
| `OPENAI_API_KEY` | — | Enables embedding generation |
| `OPENAI_BASE_URL` | — | Override OpenAI base URL |

## Running tests

```bash
# Requires pgvector-enabled Postgres
DB_URL=postgres://rig:rig@localhost/rig_memory_test AGENT_ROLE=test node test.js
```

CI uses `pgvector/pgvector:pg16` service container.

## Adding a new tool

1. Define it in `TOOLS` array in `index.js`
2. Add a `case` in the `CallToolRequestSchema` handler
3. Add DB helper in `db.js` if needed
4. Add integration test in `test.js`
5. Update `docs/api.md`

## Schema changes

The schema is applied via `initSchema()` in `db.js` — it's idempotent (`CREATE IF NOT EXISTS`).
For destructive changes, write a migration query and run it manually against production.

The `content_tsv` column is a generated column — never insert into it directly.
