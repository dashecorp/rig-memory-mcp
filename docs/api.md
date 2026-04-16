---
title: rig-memory-mcp API Reference
description: MCP tool API for the Postgres+pgvector backed agent memory server
type: reference
queries:
  - rig memory mcp tools
  - write_memory read_memories list_recent mark_used compact_repo
  - agent memory postgres pgvector
updated: 2026-04-16
---

# rig-memory-mcp API Reference

Postgres + pgvector backed MCP memory server. Provides 5 tools for writing, searching, and managing agent memories.

## Configuration

| Env var | Required | Description |
|---|---|---|
| `DB_URL` | ✅ | Postgres connection string |
| `AGENT_ROLE` | ✅ | Calling agent's role identifier |
| `WRITTEN_BY_AGENT` | — | Agent name stamped on writes (defaults to `AGENT_ROLE`) |
| `REPO` | — | Default repo slug for writes |
| `OPENAI_API_KEY` | — | Enables vector embeddings |
| `OPENAI_BASE_URL` | — | Override OpenAI base URL |

## Tools

### `write_memory`

Persist a new memory entry with optional vector embedding.

**Parameters**

| Name | Type | Required | Description |
|---|---|---|---|
| `scope` | string | ✅ | Logical scope: `session`, `project`, `repo`, `global` |
| `kind` | string | ✅ | Memory type: `decision`, `error`, `learning`, `pattern`, `context`, `standard` |
| `title` | string | ✅ | Short title (≤ 120 chars) |
| `content` | string | ✅ | Full content |
| `tags` | string[] | — | Tags for filtering (default `[]`) |
| `importance` | integer | — | 1 (low) – 5 (critical), default `3` |
| `repo` | string | — | Repo slug, overrides `REPO` env var |
| `issue_id` | integer | — | GitHub issue number |
| `expires_at` | string | — | ISO-8601 expiry (memory hidden after this) |

**Returns**

```json
{
  "id": "uuid",
  "message": "Memory saved (id: uuid)",
  "embedded": true
}
```

---

### `read_memories`

Hybrid search using BM25 tsvector + cosine vector similarity.

**Parameters**

| Name | Type | Required | Description |
|---|---|---|---|
| `query` | string | ✅ | Natural-language search query |
| `agent_role` | string | — | Filter by agent role |
| `repo` | string | — | Filter by repo slug |
| `issue_id` | integer | — | Filter by issue number |
| `limit` | integer | — | Max results, default `20` |

**Returns**

```json
{
  "memories": [
    {
      "id": "uuid",
      "title": "...",
      "content": "...",
      "scope": "project",
      "kind": "decision",
      "importance": 4,
      "hybrid_score": 0.82,
      "text_score": 0.61,
      "vec_score": 0.94,
      ...
    }
  ],
  "total": 3,
  "mode": "hybrid"
}
```

`mode` is `"hybrid"` when embeddings are available, `"text-only"` otherwise.

Scoring formula (hybrid mode):
```
hybrid_score = text_score × 0.35 + vec_score × 0.65
```

---

### `list_recent`

Return the most recently written memories, newest first.

**Parameters**

| Name | Type | Required | Description |
|---|---|---|---|
| `agent_role` | string | — | Filter by agent role |
| `repo` | string | — | Filter by repo slug |
| `limit` | integer | — | Max results, default `10` |

**Returns**

```json
{
  "memories": [ ... ],
  "total": 5
}
```

---

### `mark_used`

Record that a retrieved memory was actually used. Increments `hit_count` and updates `last_used_at`. Call this after applying a memory's content to your work.

**Parameters**

| Name | Type | Required | Description |
|---|---|---|---|
| `memory_id` | string | ✅ | UUID of the memory |

**Returns**

```json
{ "found": true, "memory_id": "uuid" }
```

---

### `compact_repo`

Summarize and prune old memories for a repo:

1. Finds memories older than `older_than_days` grouped by `scope`+`kind`
2. For groups with ≥ 2 entries, collapses them into a single summary memory
3. Deletes the originals
4. Purges any expired entries (`expires_at < NOW()`)

**Parameters**

| Name | Type | Required | Description |
|---|---|---|---|
| `repo` | string | ✅ | Repo slug to compact |
| `older_than_days` | integer | — | Age threshold (default `30`) |

**Returns**

```json
{
  "repo": "dashecorp/my-repo",
  "deleted": 12,
  "summaries_created": 3,
  "message": "Compacted dashecorp/my-repo: deleted 12 memories, created 3 summaries"
}
```

## Memory object fields

| Field | Type | Description |
|---|---|---|
| `id` | UUID | Primary key |
| `agent_role` | string | Role of the agent that wrote this |
| `written_by_agent` | string | Name of the agent instance |
| `repo` | string | Repo slug |
| `issue_id` | integer\|null | GitHub issue number |
| `scope` | string | Logical scope |
| `kind` | string | Memory type |
| `title` | string | Short title |
| `content` | string | Full content |
| `tags` | string[] | Tags |
| `importance` | integer | 1–5 |
| `created_at` | timestamp | Creation time (UTC) |
| `expires_at` | timestamp\|null | Expiry time |
| `hit_count` | integer | Times marked as used |
| `last_used_at` | timestamp\|null | Last `mark_used` call |
