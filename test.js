#!/usr/bin/env node
/**
 * Integration tests for rig-memory-mcp.
 *
 * SQLite suite: always runs (no external dependencies).
 *   Uses a temp directory that is created and cleaned up automatically.
 *
 * Postgres suite: runs when DB_URL is set. Requires Postgres + pgvector.
 *   Usage: DB_URL=postgres://... AGENT_ROLE=ci-test node test.js
 */

import {
  createPool,
  initSchema,
  insertMemory,
  searchMemories,
  listRecent,
  markUsed,
  compactRepo,
  createSqliteBackend,
} from "./db.js";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

let pool;
let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) {
    console.error(`  FAIL: ${msg}`);
    failed++;
    throw new Error(msg);
  }
  console.log(`  pass: ${msg}`);
  passed++;
}

async function cleanupPg(pool) {
  await pool.query("DELETE FROM rig_memory WHERE agent_role = 'test-agent'");
}

// ---------- SQLite tests ----------

async function runSqliteTests() {
  // Use a nested path under a fresh temp dir to exercise mkdirSync behaviour
  const tmpBase = join(tmpdir(), `rig-memory-test-${Date.now()}`);
  const dbPath = join(tmpBase, "nested", "dir", "memory.db");

  try {
    console.log("\n=== SQLite: directory auto-creation ===");

    assert(!existsSync(tmpBase), "temp dir absent before test");
    const backend = createSqliteBackend(dbPath);
    assert(existsSync(tmpBase), "createSqliteBackend created parent directories");

    console.log("\n=== SQLite: insertMemory ===");

    const id1 = await backend.insertMemory({
      agent_role: "test-agent",
      written_by_agent: "test-agent",
      repo: "dashecorp/sqlite-test",
      issue_id: 1,
      scope: "project",
      kind: "decision",
      title: "SQLite test decision",
      content: "Testing the SQLite backend for the memory MCP server.",
      tags: ["sqlite", "test"],
      importance: 3,
      expires_at: null,
    });
    assert(typeof id1 === "string" && id1.length === 36, "insertMemory returns UUID");

    const id2 = await backend.insertMemory({
      agent_role: "test-agent",
      written_by_agent: "test-agent",
      repo: "dashecorp/sqlite-test",
      issue_id: null,
      scope: "session",
      kind: "learning",
      title: "SQLite FTS5 search works",
      content: "Full-text search via FTS5 virtual table on title and content columns.",
      tags: ["fts5", "search"],
      importance: 2,
      expires_at: null,
    });
    assert(typeof id2 === "string" && id2.length === 36, "second insertMemory returns UUID");
    assert(id1 !== id2, "IDs are unique");

    console.log("\n=== SQLite: searchMemories ===");

    const results = await backend.searchMemories({
      query: "SQLite backend",
      agent_role: null,
      repo: null,
      issue_id: null,
      limit: 10,
    });
    assert(results.length >= 1, "searchMemories returns at least 1 result");
    assert(results.some((r) => r.title.includes("SQLite")), "result title matches query");
    assert(typeof results[0].text_score === "number", "text_score is numeric");
    assert(results[0].vec_score === 0, "vec_score is 0 (no vectors in SQLite mode)");
    assert(Array.isArray(results[0].tags), "tags returned as arrays not raw strings");

    const filtered = await backend.searchMemories({
      query: "FTS5",
      agent_role: "test-agent",
      repo: "dashecorp/sqlite-test",
      issue_id: null,
      limit: 5,
    });
    assert(filtered.length >= 1, "filtered searchMemories returns results");

    const empty = await backend.searchMemories({
      query: "xyzzy frob nonsense",
      agent_role: null,
      repo: null,
      issue_id: null,
      limit: 5,
    });
    assert(Array.isArray(empty), "no-match search returns empty array");
    assert(empty.length === 0, "no-match search returns zero results");

    // Query with unbalanced parenthesis — triggers FTS5 parse error → LIKE fallback
    const likeResult = await backend.searchMemories({
      query: "(unbalanced sqlite",
      agent_role: null,
      repo: null,
      issue_id: null,
      limit: 5,
    });
    assert(Array.isArray(likeResult), "special-char query falls back to LIKE, returns array");

    console.log("\n=== SQLite: listRecent ===");

    const recent = await backend.listRecent({
      agent_role: "test-agent",
      repo: "dashecorp/sqlite-test",
      limit: 5,
    });
    assert(recent.length === 2, "listRecent returns both memories");
    assert(recent[0].created_at >= recent[1].created_at, "ordered by created_at DESC");
    assert(Array.isArray(recent[0].tags), "tags are arrays in listRecent");

    const recentAll = await backend.listRecent({ agent_role: null, repo: null, limit: 100 });
    assert(Array.isArray(recentAll), "listRecent without filters returns array");

    console.log("\n=== SQLite: markUsed ===");

    const found = await backend.markUsed(id1);
    assert(found === true, "markUsed returns true for existing memory");

    const notFound = await backend.markUsed("00000000-0000-0000-0000-000000000000");
    assert(notFound === false, "markUsed returns false for unknown UUID");

    // Verify hit_count via listRecent
    const afterMark = await backend.listRecent({
      agent_role: "test-agent",
      repo: "dashecorp/sqlite-test",
      limit: 10,
    });
    const marked = afterMark.find((r) => r.id === id1);
    assert(marked !== undefined, "marked memory found in listRecent");
    assert(marked.hit_count === 1, "hit_count incremented to 1");
    assert(marked.last_used_at !== null, "last_used_at set after markUsed");

    // Second markUsed increments further
    await backend.markUsed(id1);
    const afterMark2 = await backend.listRecent({
      agent_role: "test-agent",
      repo: "dashecorp/sqlite-test",
      limit: 10,
    });
    const marked2 = afterMark2.find((r) => r.id === id1);
    assert(marked2.hit_count === 2, "hit_count increments on second markUsed call");

    console.log("\n=== SQLite: compactRepo ===");

    const oldDate = new Date(Date.now() - 40 * 86_400_000).toISOString();
    for (let i = 0; i < 3; i++) {
      const id = await backend.insertMemory({
        agent_role: "test-agent",
        written_by_agent: "test-agent",
        repo: "dashecorp/sqlite-compact",
        scope: "project",
        kind: "learning",
        title: `Old learning #${i + 1}`,
        content: `Content for old learning ${i + 1}`,
        tags: ["old"],
        importance: 2,
        expires_at: null,
      });
      // Backdate via the underlying DB handle so they fall within compaction window
      backend._db.prepare("UPDATE rig_memory SET created_at = ? WHERE id = ?").run(oldDate, id);
    }

    const compactResult = await backend.compactRepo({
      repo: "dashecorp/sqlite-compact",
      older_than_days: 30,
      agent_role: "test-agent",
      written_by_agent: "test-agent",
    });
    assert(
      compactResult.deleted === 3,
      `compact deleted 3 old memories, got ${compactResult.deleted}`
    );
    assert(compactResult.summaries_created === 1, "compact created 1 summary");

    // Summary must be searchable
    const summaries = await backend.searchMemories({
      query: "compacted",
      agent_role: null,
      repo: null,
      issue_id: null,
      limit: 5,
    });
    assert(summaries.length >= 1, "summary memory is searchable after compaction");

    // Expired-entry pruning
    const expiredId = await backend.insertMemory({
      agent_role: "test-agent",
      written_by_agent: "test-agent",
      repo: "dashecorp/sqlite-compact",
      scope: "session",
      kind: "context",
      title: "Expired memory",
      content: "Should be pruned by compactRepo",
      tags: [],
      importance: 1,
      expires_at: "2000-01-01T00:00:00Z",
    });
    const pruneResult = await backend.compactRepo({
      repo: "dashecorp/sqlite-compact",
      older_than_days: 30,
      agent_role: "test-agent",
      written_by_agent: "test-agent",
    });
    assert(pruneResult.deleted >= 1, "compact prunes expired entries");
    const expiredCheck = backend._db
      .prepare("SELECT id FROM rig_memory WHERE id = ?")
      .get(expiredId);
    assert(expiredCheck == null, "expired entry removed from DB");

    await backend.close();
  } finally {
    rmSync(tmpBase, { recursive: true, force: true });
  }
}

// ---------- Postgres tests ----------

async function runPostgresTests() {
  // Setup
  pool = await createPool();
  await initSchema(pool);
  await cleanupPg(pool);

  console.log("\n=== Postgres: write_memory / insertMemory ===");

  let id1;
  {
    id1 = await insertMemory(pool, {
      agent_role: "test-agent",
      written_by_agent: "test-agent",
      repo: "dashecorp/test-repo",
      issue_id: 42,
      scope: "project",
      kind: "decision",
      title: "Use pgvector for semantic search",
      content:
        "Decided to use pgvector extension for semantic similarity search over agent memories.",
      tags: ["postgres", "pgvector", "search"],
      importance: 4,
      expires_at: null,
      embedding: null,
    });
    assert(typeof id1 === "string" && id1.length === 36, "insertMemory returns UUID");
  }

  let id2;
  {
    id2 = await insertMemory(pool, {
      agent_role: "test-agent",
      written_by_agent: "test-agent",
      repo: "dashecorp/test-repo",
      issue_id: null,
      scope: "session",
      kind: "learning",
      title: "Hybrid BM25 + vector search pattern",
      content:
        "Combine tsvector for keyword matching with cosine similarity for semantic search. Weight vector 65%, text 35%.",
      tags: ["search", "hybrid"],
      importance: 3,
      expires_at: null,
      embedding: null,
    });
    assert(typeof id2 === "string", "second insertMemory returns UUID");
  }

  console.log("\n=== Postgres: read_memories / searchMemories (text-only) ===");

  {
    const results = await searchMemories(pool, {
      query: "pgvector semantic search",
      agent_role: null,
      repo: null,
      issue_id: null,
      limit: 10,
      embedding: null,
    });
    assert(results.length >= 1, "text search returns at least 1 result");
    assert(results[0].title.includes("pgvector"), "top result matches query");
  }

  {
    const results = await searchMemories(pool, {
      query: "hybrid search",
      agent_role: "test-agent",
      repo: "dashecorp/test-repo",
      issue_id: null,
      limit: 5,
      embedding: null,
    });
    assert(results.length >= 1, "filtered text search returns results");
  }

  {
    // Query that matches nothing
    const results = await searchMemories(pool, {
      query: "xyzzy frob nonsense",
      agent_role: null,
      repo: null,
      issue_id: null,
      limit: 5,
      embedding: null,
    });
    assert(Array.isArray(results), "no-match search returns empty array");
  }

  console.log("\n=== Postgres: list_recent ===");

  {
    const results = await listRecent(pool, {
      agent_role: "test-agent",
      repo: "dashecorp/test-repo",
      limit: 5,
    });
    assert(results.length >= 2, "list_recent returns both memories");
    assert(results[0].created_at >= results[1].created_at, "ordered by created_at DESC");
  }

  {
    const results = await listRecent(pool, { agent_role: null, repo: null, limit: 100 });
    assert(Array.isArray(results), "list_recent without filters returns array");
  }

  console.log("\n=== Postgres: mark_used ===");

  {
    const found = await markUsed(pool, id1);
    assert(found === true, "mark_used returns true for existing memory");

    const { rows } = await pool.query(
      "SELECT hit_count, last_used_at FROM rig_memory WHERE id = $1",
      [id1]
    );
    assert(rows[0].hit_count === 1, "hit_count incremented to 1");
    assert(rows[0].last_used_at !== null, "last_used_at set");
  }

  {
    await markUsed(pool, id1);
    const { rows } = await pool.query(
      "SELECT hit_count FROM rig_memory WHERE id = $1",
      [id1]
    );
    assert(rows[0].hit_count === 2, "hit_count increments on second call");
  }

  {
    const notFound = await markUsed(pool, "00000000-0000-0000-0000-000000000000");
    assert(notFound === false, "mark_used returns false for unknown UUID");
  }

  console.log("\n=== Postgres: compact_repo ===");

  {
    // Insert several old-looking memories by backdating them
    const oldDate = new Date(Date.now() - 40 * 86_400_000).toISOString();
    for (let i = 0; i < 3; i++) {
      const { rows } = await pool.query(
        `INSERT INTO rig_memory
           (agent_role, written_by_agent, repo, scope, kind, title, content, tags, importance)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [
          "test-agent",
          "test-agent",
          "dashecorp/compact-test",
          "project",
          "learning",
          `Old learning #${i + 1}`,
          `Content for old learning ${i + 1}`,
          ["old"],
          2,
        ]
      );
      // Backdate
      await pool.query(
        "UPDATE rig_memory SET created_at = $1 WHERE id = $2",
        [oldDate, rows[0].id]
      );
    }

    const result = await compactRepo(pool, {
      repo: "dashecorp/compact-test",
      older_than_days: 30,
      agent_role: "test-agent",
      written_by_agent: "test-agent",
    });

    assert(result.deleted === 3, `compact deleted 3 old memories, got ${result.deleted}`);
    assert(result.summaries_created === 1, "compact created 1 summary");

    // Verify summary exists
    const { rows: summary } = await pool.query(
      "SELECT title FROM rig_memory WHERE repo = $1 AND title LIKE '%compacted%'",
      ["dashecorp/compact-test"]
    );
    assert(summary.length === 1, "summary memory was created");
    assert(summary[0].title.includes("compacted"), "summary title tagged as compacted");
  }

  {
    // Test expired entry pruning
    const { rows } = await pool.query(
      `INSERT INTO rig_memory
         (agent_role, written_by_agent, repo, scope, kind, title, content, expires_at)
       VALUES ('test-agent','test-agent','dashecorp/compact-test','session','context','Expired mem','Gone','2000-01-01T00:00:00Z')
       RETURNING id`
    );
    const expiredId = rows[0].id;
    const result = await compactRepo(pool, {
      repo: "dashecorp/compact-test",
      older_than_days: 30,
      agent_role: "test-agent",
      written_by_agent: "test-agent",
    });
    assert(result.deleted >= 1, "compact prunes expired entries");
    const check = await pool.query("SELECT id FROM rig_memory WHERE id = $1", [expiredId]);
    assert(check.rows.length === 0, "expired entry removed from DB");
  }

  // Cleanup
  await cleanupPg(pool);
  await pool.query("DELETE FROM rig_memory WHERE repo = 'dashecorp/compact-test'");
}

// ---------- Main ----------

async function main() {
  console.log("=== SQLite Backend Tests ===");
  await runSqliteTests();

  if (process.env.DB_URL) {
    console.log("\n=== Postgres Backend Tests ===");
    try {
      await runPostgresTests();
    } finally {
      await pool?.end();
    }
  } else {
    console.log("\n(Postgres tests skipped — DB_URL not set)");
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test suite error:", err.message);
  process.exit(1);
});
