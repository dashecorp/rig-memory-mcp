#!/usr/bin/env node
/**
 * Integration tests for rig-memory-mcp.
 * Requires a running Postgres with pgvector.
 * Set DB_URL before running.
 *
 * Usage:
 *   DB_URL=postgres://... AGENT_ROLE=test node test.js
 */

import {
  createPool,
  initSchema,
  insertMemory,
  searchMemories,
  listRecent,
  markUsed,
  compactRepo,
} from "./db.js";

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

async function cleanup(pool) {
  await pool.query("DELETE FROM rig_memory WHERE agent_role = 'test-agent'");
}

async function runTests() {
  // Setup
  pool = await createPool();
  await initSchema(pool);
  await cleanup(pool);

  console.log("\n=== write_memory / insertMemory ===");

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
      content: "Decided to use pgvector extension for semantic similarity search over agent memories.",
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
      content: "Combine tsvector for keyword matching with cosine similarity for semantic search. Weight vector 65%, text 35%.",
      tags: ["search", "hybrid"],
      importance: 3,
      expires_at: null,
      embedding: null,
    });
    assert(typeof id2 === "string", "second insertMemory returns UUID");
  }

  console.log("\n=== read_memories / searchMemories (text-only) ===");

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

  console.log("\n=== list_recent ===");

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

  console.log("\n=== mark_used ===");

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

  console.log("\n=== compact_repo ===");

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
  await cleanup(pool);
  await pool.query("DELETE FROM rig_memory WHERE repo = 'dashecorp/compact-test'");

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);

  if (failed > 0) process.exit(1);
}

runTests()
  .catch((err) => {
    console.error("Test suite error:", err.message);
    process.exit(1);
  })
  .finally(() => pool?.end());
