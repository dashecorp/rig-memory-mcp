/**
 * Database layer for rig-memory-mcp.
 *
 * Backend: Postgres + pgvector + tsvector hybrid search.
 *
 * Required env var:
 *   DB_URL  — Postgres connection string (e.g. postgres://user:pass@host/db)
 *
 * Optional env vars:
 *   OPENAI_API_KEY   — enables embedding generation (text-embedding-3-small)
 *   OPENAI_BASE_URL  — override OpenAI API base (for compatible endpoints)
 */

import pg from "pg";

const { Pool } = pg;

// ---------- Schema ----------

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS rig_memory (
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

CREATE INDEX IF NOT EXISTS idx_rm_repo          ON rig_memory(repo);
CREATE INDEX IF NOT EXISTS idx_rm_agent_role    ON rig_memory(agent_role);
CREATE INDEX IF NOT EXISTS idx_rm_created_at    ON rig_memory(created_at);
CREATE INDEX IF NOT EXISTS idx_rm_importance    ON rig_memory(importance);
CREATE INDEX IF NOT EXISTS idx_rm_content_tsv   ON rig_memory USING GIN(content_tsv);
`;

// HNSW index created separately — requires pgvector >= 0.5.0
const HNSW_INDEX = `
CREATE INDEX IF NOT EXISTS idx_rm_embedding
  ON rig_memory USING hnsw(embedding vector_cosine_ops);
`;

// ---------- Factory ----------

/** @returns {import('pg').Pool} */
export async function createPool() {
  const dbUrl = process.env.DB_URL;
  if (!dbUrl) {
    throw new Error("DB_URL environment variable is required");
  }

  const pool = new Pool({ connectionString: dbUrl });

  // Test connection
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    throw new Error(`Failed to connect to Postgres: ${err.message}`);
  }

  return pool;
}

/** Initialize schema — idempotent. */
export async function initSchema(pool) {
  // Run statements split by semicolon
  const stmts = SCHEMA.split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const stmt of stmts) {
    await pool.query(stmt);
  }

  // HNSW index — best-effort (requires pgvector >= 0.5)
  try {
    await pool.query(HNSW_INDEX);
  } catch {
    // Fall back gracefully — queries still work, just without HNSW
    console.error("[rig-memory] HNSW index skipped (pgvector < 0.5 or no data)");
  }
}

// ---------- Queries ----------

/**
 * Insert a new memory row.
 *
 * @param {import('pg').Pool} pool
 * @param {object} m
 * @returns {Promise<string>} inserted UUID
 */
export async function insertMemory(pool, m) {
  const { rows } = await pool.query(
    `INSERT INTO rig_memory
       (agent_role, written_by_agent, repo, issue_id, scope, kind, title, content, tags, importance, expires_at, embedding)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING id`,
    [
      m.agent_role,
      m.written_by_agent,
      m.repo,
      m.issue_id ?? null,
      m.scope,
      m.kind,
      m.title,
      m.content,
      m.tags ?? [],
      m.importance ?? 3,
      m.expires_at ?? null,
      m.embedding ?? null,
    ]
  );
  return rows[0].id;
}

/**
 * Hybrid search: tsvector BM25-like + vector cosine similarity.
 * Falls back to text-only when embedding is null.
 *
 * @param {import('pg').Pool} pool
 * @param {object} opts
 * @returns {Promise<Array>}
 */
export async function searchMemories(pool, opts) {
  const { query, agent_role, repo, issue_id, limit = 20, embedding } = opts;

  if (embedding) {
    // Hybrid: weighted sum of text rank + vector similarity
    const { rows } = await pool.query(
      `SELECT
         id, agent_role, written_by_agent, repo, issue_id, scope, kind,
         title, content, tags, importance, created_at, expires_at, hit_count, last_used_at,
         ts_rank(content_tsv, plainto_tsquery('english', $1)) AS text_score,
         (1 - (embedding <=> $2::vector))                     AS vec_score,
         (ts_rank(content_tsv, plainto_tsquery('english', $1)) * 0.35 +
          (1 - (embedding <=> $2::vector)) * 0.65)            AS hybrid_score
       FROM rig_memory
       WHERE
         (expires_at IS NULL OR expires_at > NOW())
         AND ($3::text IS NULL OR agent_role = $3)
         AND ($4::text IS NULL OR repo = $4)
         AND ($5::int  IS NULL OR issue_id  = $5)
         AND (
           content_tsv @@ plainto_tsquery('english', $1)
           OR (embedding IS NOT NULL AND (embedding <=> $2::vector) < 0.7)
         )
       ORDER BY hybrid_score DESC
       LIMIT $6`,
      [query, JSON.stringify(embedding), agent_role ?? null, repo ?? null, issue_id ?? null, limit]
    );
    return rows;
  }

  // Text-only fallback
  const { rows } = await pool.query(
    `SELECT
       id, agent_role, written_by_agent, repo, issue_id, scope, kind,
       title, content, tags, importance, created_at, expires_at, hit_count, last_used_at,
       ts_rank(content_tsv, plainto_tsquery('english', $1)) AS text_score,
       0::float                                             AS vec_score,
       ts_rank(content_tsv, plainto_tsquery('english', $1)) AS hybrid_score
     FROM rig_memory
     WHERE
       content_tsv @@ plainto_tsquery('english', $1)
       AND (expires_at IS NULL OR expires_at > NOW())
       AND ($2::text IS NULL OR agent_role = $2)
       AND ($3::text IS NULL OR repo = $3)
       AND ($4::int  IS NULL OR issue_id  = $4)
     ORDER BY hybrid_score DESC
     LIMIT $5`,
    [query, agent_role ?? null, repo ?? null, issue_id ?? null, limit]
  );
  return rows;
}

/**
 * List most recent memories for an agent+repo.
 *
 * @param {import('pg').Pool} pool
 * @param {object} opts
 * @returns {Promise<Array>}
 */
export async function listRecent(pool, opts) {
  const { agent_role, repo, limit = 10 } = opts;
  const { rows } = await pool.query(
    `SELECT
       id, agent_role, written_by_agent, repo, issue_id, scope, kind,
       title, content, tags, importance, created_at, expires_at, hit_count, last_used_at
     FROM rig_memory
     WHERE
       (expires_at IS NULL OR expires_at > NOW())
       AND ($1::text IS NULL OR agent_role = $1)
       AND ($2::text IS NULL OR repo = $2)
     ORDER BY created_at DESC
     LIMIT $3`,
    [agent_role ?? null, repo ?? null, limit]
  );
  return rows;
}

/**
 * Increment hit_count and set last_used_at for a memory.
 *
 * @param {import('pg').Pool} pool
 * @param {string} id UUID
 * @returns {Promise<boolean>} true if found
 */
export async function markUsed(pool, id) {
  const { rowCount } = await pool.query(
    `UPDATE rig_memory
     SET hit_count = hit_count + 1, last_used_at = NOW()
     WHERE id = $1`,
    [id]
  );
  return rowCount > 0;
}

/**
 * Compact (summarize + prune) memories for a repo older than N days.
 * Groups by scope+kind. Creates a single archive summary per group,
 * then deletes the originals.
 *
 * @param {import('pg').Pool} pool
 * @param {object} opts
 * @param {string} opts.repo
 * @param {number} opts.older_than_days
 * @param {string} opts.agent_role        written_by / agent_role for summary row
 * @param {string} opts.written_by_agent
 * @returns {Promise<{deleted: number, summaries_created: number}>}
 */
export async function compactRepo(pool, opts) {
  const { repo, older_than_days = 30, agent_role, written_by_agent } = opts;
  const cutoff = new Date(Date.now() - older_than_days * 86_400_000).toISOString();

  // Find old memories grouped by scope+kind
  const { rows: groups } = await pool.query(
    `SELECT scope, kind, COUNT(*) AS cnt
     FROM rig_memory
     WHERE repo = $1
       AND created_at < $2
     GROUP BY scope, kind
     HAVING COUNT(*) > 1`,
    [repo, cutoff]
  );

  let deleted = 0;
  let summaries_created = 0;

  for (const { scope, kind } of groups) {
    // Fetch old memories in this group
    const { rows: old } = await pool.query(
      `SELECT id, title, content, tags, importance
       FROM rig_memory
       WHERE repo = $1 AND created_at < $2 AND scope = $3 AND kind = $4
       ORDER BY importance DESC, created_at ASC`,
      [repo, cutoff, scope, kind]
    );

    if (old.length < 2) continue;

    // Build compact summary
    const summaryTitle = `[compacted] ${scope}/${kind} — ${old.length} entries`;
    const summaryContent =
      `Compacted ${old.length} memories (repo: ${repo}, scope: ${scope}, kind: ${kind}).\n\n` +
      old.map((r, i) => `${i + 1}. **${r.title}**\n${r.content}`).join("\n\n---\n\n");
    const allTags = [...new Set(old.flatMap((r) => r.tags))];
    const maxImportance = Math.max(...old.map((r) => r.importance));

    // Insert summary
    await insertMemory(pool, {
      agent_role,
      written_by_agent,
      repo,
      issue_id: null,
      scope,
      kind,
      title: summaryTitle,
      content: summaryContent,
      tags: allTags,
      importance: maxImportance,
      expires_at: null,
      embedding: null,
    });
    summaries_created++;

    // Delete originals
    const ids = old.map((r) => r.id);
    const { rowCount } = await pool.query(
      `DELETE FROM rig_memory WHERE id = ANY($1::uuid[])`,
      [ids]
    );
    deleted += rowCount;
  }

  // Also prune expired entries
  const { rowCount: expiredDeleted } = await pool.query(
    `DELETE FROM rig_memory WHERE repo = $1 AND expires_at IS NOT NULL AND expires_at < NOW()`,
    [repo]
  );
  deleted += expiredDeleted;

  return { deleted, summaries_created };
}
