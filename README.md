# rig-memory-mcp

MCP server providing persistent, searchable memory for the Dashecorp engineering rig agents. Backed by Postgres + pgvector with hybrid BM25 + vector search.

## Quick start

```bash
docker run --rm \
  -e DB_URL=postgres://user:pass@host/db \
  -e AGENT_ROLE=dev-e \
  ghcr.io/dashecorp/rig-memory-mcp:latest
```

Or with Node:

```bash
npm install
DB_URL=postgres://... AGENT_ROLE=dev-e node index.js
```

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `DB_URL` | ✅ | — | Postgres connection string |
| `AGENT_ROLE` | ✅ | — | Role of the agent (e.g. `dev-e`, `review-e`) |
| `WRITTEN_BY_AGENT` | — | `AGENT_ROLE` | Override agent name for writes |
| `REPO` | — | `""` | Default repo slug for `write_memory` |
| `OPENAI_API_KEY` | — | — | Enables semantic embeddings (text-embedding-3-small) |
| `OPENAI_BASE_URL` | — | OpenAI default | Override base URL for OpenAI-compatible endpoints |
| `MEMORY_STRICT` | — | `false` | Exit instead of SQLite-fallback on Postgres failure |

Without `OPENAI_API_KEY`, the server runs in **text-only mode** (BM25/tsvector search only).

## Multi-tenancy (rc#1478 — per-tenant DB isolation)

Each tenant gets a **physically separate Postgres+pgvector database** (`rig_t_<id>_mem`), not a shared table with a `tenant_id` filter. *The LLM is the threat model, not the guard* — a forgotten or prompt-injected retrieval predicate on a shared table is a leak; a wrong database connection simply cannot return another tenant's rows.

**Policy** (`tenant.js`):

- Slug grammar + reserved blocklist + `pg`/`kube` prefix block, **ported verbatim** from rig-conductor's `TenantId` (`^[a-z][a-z0-9]{1,19}$`, 2–20 chars, no leading digit). Keep in sync — a slug the conductor accepts but this server rejects (or vice-versa) splits the per-tenant DB name.
- Frozen per-tenant DB-name convention: `rig_t_<id>_mem`.
- `resolveTenantBinding(env)` reads the server-trusted `TENANT_ID` env var (never an MCP tool argument) and returns either legacy/single-tenant mode (no `TENANT_ID`) or a multi-tenant binding `{ tenantId, expectedDb }` — fail-closed throw on an invalid slug, never default.
- `findForbiddenTenantArg(args)` rejects any tool-call payload that smuggles `tenant`/`tenant_id`/`db`/`db_url`.

**Adapter — now wired (Part 2):** when `TENANT_ID` is set, `createBackend`:

- **requires** a per-tenant Postgres `DB_URL` (the SQLite fallback is **disabled** in multi-tenant mode);
- **asserts** the connection lands on `rig_t_<id>_mem` (`assertCurrentDatabase`) **before** `initSchema`, so a wrong-DB DSN can't even create the schema in the wrong place;
- is **fatal on any failure** (missing DSN, wrong DB, connect error) — it never silently degrades to a shared/SQLite store;
- hard-rejects any tool call carrying a forbidden tenant/db argument (`findForbiddenTenantArg`).

Legacy single-tenant mode (`TENANT_ID` unset) is unchanged. The cross-tenant DB-isolation suite in `test.js` (`runTenantIsolationTests`) proves the boundary with a strong negative oracle (tenant A's DB never returns tenant B's rows, and vice-versa) and is **load-bearing**: it hard-fails rather than silently skipping (the `ALLOW_SKIP_ISOLATION_TEST` opt-out only tolerates a missing-CREATEDB-privilege error, never an isolation regression).

> **Conductor wiring (Part B of rc#1478)** — injecting the per-tenant `DB_URL`/secret-ref into the agent session via the P0 `ITenantResolver` / `Tenant` registry — lands when per-tenant agent pods exist (gated on the namespace-per-tenant item #1482).

## Database schema

```sql
CREATE TABLE rig_memory (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_role      TEXT        NOT NULL,
  written_by_agent TEXT       NOT NULL,
  repo            TEXT        NOT NULL,
  issue_id        INT,
  scope           TEXT        NOT NULL,
  kind            TEXT        NOT NULL,
  title           TEXT        NOT NULL,
  content         TEXT        NOT NULL,
  tags            TEXT[]      NOT NULL DEFAULT '{}',
  importance      SMALLINT    NOT NULL DEFAULT 3,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ,
  hit_count       INT         NOT NULL DEFAULT 0,
  last_used_at    TIMESTAMPTZ,
  embedding       VECTOR(1536),
  content_tsv     TSVECTOR    GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || content)) STORED
);
```

Requires Postgres 12+ and [pgvector](https://github.com/pgvector/pgvector) extension.

### Indexes

| Index | Type | Purpose |
|---|---|---|
| `idx_rm_content_tsv` | GIN | Full-text search (tsvector) |
| `idx_rm_embedding` | HNSW | Vector cosine search |
| `idx_rm_repo` | B-tree | Repo filter |
| `idx_rm_agent_role` | B-tree | Agent filter |
| `idx_rm_created_at` | B-tree | Recency queries |

## MCP tools

### `write_memory`

Store a memory. Agent identity and default repo come from env vars.

| Param | Type | Required | Description |
|---|---|---|---|
| `scope` | string | ✅ | e.g. `session`, `project`, `repo`, `global` |
| `kind` | string | ✅ | e.g. `decision`, `error`, `learning`, `pattern` |
| `title` | string | ✅ | Short searchable title (≤ 120 chars) |
| `content` | string | ✅ | Full memory content |
| `tags` | string[] | — | Tags for filtering |
| `importance` | number | — | 1–5, default 3 |
| `repo` | string | — | Override default repo |
| `issue_id` | number | — | GitHub issue number |
| `expires_at` | string | — | ISO-8601 expiry timestamp |

### `read_memories`

Hybrid search (BM25 tsvector + cosine vector similarity). Returns up to `limit` ranked results.

| Param | Type | Required | Description |
|---|---|---|---|
| `query` | string | ✅ | Natural-language search query |
| `agent_role` | string | — | Filter by agent role |
| `repo` | string | — | Filter by repo slug |
| `issue_id` | number | — | Filter by issue number |
| `limit` | number | — | Max results (default 20) |

Results include `hybrid_score`, `text_score`, `vec_score` fields.

### `list_recent`

Return most-recently written memories for an agent/repo.

| Param | Type | Required | Description |
|---|---|---|---|
| `agent_role` | string | — | Filter by agent role |
| `repo` | string | — | Filter by repo slug |
| `limit` | number | — | Max results (default 10) |

### `mark_used`

Increment `hit_count` on a memory and set `last_used_at`. Call this when a retrieved memory was actually helpful.

| Param | Type | Required | Description |
|---|---|---|---|
| `memory_id` | string | ✅ | UUID of the memory |

### `compact_repo`

Summarize and prune old memories for a repo. Groups entries by `scope`+`kind`, collapses groups into one summary memory, deletes originals. Also purges expired entries.

| Param | Type | Required | Description |
|---|---|---|---|
| `repo` | string | ✅ | Repo slug to compact |
| `older_than_days` | number | — | Only compact memories older than N days (default 30) |

## Hybrid search

When `OPENAI_API_KEY` is set, each write embeds `title + content` using `text-embedding-3-small` (1536 dims). Search combines:

```
hybrid_score = text_rank × 0.35 + (1 − cosine_distance) × 0.65
```

Without embeddings, search falls back to tsvector-only (`ts_rank`).

## Running with Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "rig-memory": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "DB_URL",
        "-e", "AGENT_ROLE",
        "-e", "OPENAI_API_KEY",
        "ghcr.io/dashecorp/rig-memory-mcp:latest"
      ],
      "env": {
        "DB_URL": "postgres://...",
        "AGENT_ROLE": "dev-e",
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

## Development

```bash
# Install deps
npm install

# Run integration tests (requires Postgres with pgvector)
DB_URL=postgres://rig:rig@localhost/rig_memory_test AGENT_ROLE=test node test.js

# Start with Docker Compose (spins up pgvector locally)
docker compose up
```

## Docker

Images are published to GHCR on every push to `main`:

```
ghcr.io/dashecorp/rig-memory-mcp:latest
ghcr.io/dashecorp/rig-memory-mcp:sha-<commit>
```

> Rig orchestrator renamed rig-conductor → rig-conductor on 2026-04-19 (dashecorp/infra#76).

> E2E smoke #2 passed on 2026-04-19 after rig-gitops#105 fixed the stale DB_URL hostname.

> Phase 7 smoke passed 2026-04-20 — image/DB/agentId/persona renamed to rig-conductor.
