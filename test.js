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

import pg from "pg";
import {
  createPool,
  initSchema,
  assertCurrentDatabase,
  insertMemory,
  searchMemories,
  listRecent,
  markUsed,
  compactRepo,
  createSqliteBackend,
} from "./db.js";

const { Pool } = pg;
import {
  tryNormalizeTenantSlug,
  isValidTenantSlug,
  normalizeTenantSlug,
  memoryDbName,
  resolveTenantBinding,
  findForbiddenTenantArg,
} from "./tenant.js";
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

// ---------- Tenant-binding tests (rc#1478, pure — no DB) ----------

function runTenantTests() {
  console.log("\n=== Tenant: slug validation (ported from TenantId) ===");

  // Valid slugs
  for (const ok of ["invotek", "acme", "ab", "a1", "tenant1x", "abcdefghij0123456789"]) {
    assert(isValidTenantSlug(ok), `valid slug accepted: '${ok}'`);
    assert(tryNormalizeTenantSlug(ok) === ok, `valid slug normalizes to itself: '${ok}'`);
  }
  // Trim + lowercase normalization
  assert(tryNormalizeTenantSlug("  Acme  ") === "acme", "trims + lowercases ' Acme '");

  // Invalid: format. NB 'Inv' is intentionally NOT here — it lowercases to the valid 'inv'
  // (normalization runs before validation), asserted separately below.
  for (const bad of [
    "",                       // empty
    "a",                      // too short (min 2)
    "1abc",                   // leading digit
    "tenant-probe",           // hyphen (separator forbidden)
    "tenant_probe",           // underscore (separator forbidden)
    "abcdefghij0123456789x",  // 21 chars (max 20)
    "föö",                    // non-ASCII homoglyph
    "a; DROP DATABASE x; --", // injection
    "a b",                    // space
  ]) {
    assert(!isValidTenantSlug(bad), `invalid slug rejected: ${JSON.stringify(bad)}`);
    assert(tryNormalizeTenantSlug(bad) === null, `invalid slug → null: ${JSON.stringify(bad)}`);
  }
  // 'Inv' → 'inv' is genuinely valid (lowercasing happens first)
  assert(tryNormalizeTenantSlug("Inv") === "inv", "'Inv' normalizes to valid 'inv'");

  // Invalid: reserved tokens + reserved prefixes
  for (const reserved of ["rig", "control", "postgres", "public", "default", "admin", "kube", "flux"]) {
    assert(!isValidTenantSlug(reserved), `reserved token rejected: '${reserved}'`);
  }
  for (const pfx of ["pgfoo", "pg1", "kubexyz", "kube1"]) {
    assert(!isValidTenantSlug(pfx), `reserved-prefix slug rejected: '${pfx}'`);
  }
  // Non-string inputs
  for (const x of [null, undefined, 42, {}, []]) {
    assert(tryNormalizeTenantSlug(x) === null, `non-string → null: ${JSON.stringify(x) ?? String(x)}`);
  }
  // normalizeTenantSlug throws on invalid
  let threw = false;
  try { normalizeTenantSlug("tenant-probe"); } catch { threw = true; }
  assert(threw, "normalizeTenantSlug throws on an invalid slug");

  console.log("\n=== Tenant: memory DB name (frozen rig_t_<id>_mem) ===");
  assert(memoryDbName("invotek") === "rig_t_invotek_mem", "memoryDbName('invotek') = rig_t_invotek_mem");
  assert(memoryDbName("acme") === "rig_t_acme_mem", "memoryDbName('acme') = rig_t_acme_mem");

  console.log("\n=== Tenant: resolveTenantBinding ===");
  assert(resolveTenantBinding({}).multiTenant === false, "no TENANT_ID → single-tenant/legacy");
  assert(resolveTenantBinding({ TENANT_ID: "" }).multiTenant === false, "blank TENANT_ID → legacy");
  assert(resolveTenantBinding({ TENANT_ID: "   " }).multiTenant === false, "whitespace TENANT_ID → legacy");
  const b = resolveTenantBinding({ TENANT_ID: "acme" });
  assert(b.multiTenant === true, "TENANT_ID set → multi-tenant");
  assert(b.tenantId === "acme" && b.expectedDb === "rig_t_acme_mem", "binding carries id + expectedDb");
  // Invalid TENANT_ID must throw (fail closed, never default)
  let bthrew = false;
  try { resolveTenantBinding({ TENANT_ID: "rig" }); } catch { bthrew = true; }
  assert(bthrew, "reserved TENANT_ID throws (fail closed)");

  console.log("\n=== Tenant: forbidden tool-arg guard ===");
  assert(findForbiddenTenantArg(undefined) === null, "no args → null");
  assert(findForbiddenTenantArg({ query: "x" }) === null, "clean args → null");
  for (const key of ["tenant", "tenant_id", "tenantId", "db", "db_url", "dbUrl"]) {
    assert(findForbiddenTenantArg({ [key]: "x" }) !== null, `forbidden arg '${key}' is rejected`);
  }
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

// ---------- Cross-tenant DB-isolation tests (rc#1478 Part 2) ----------

/** Build a DSN for a specific database off DB_URL by swapping the path. */
function dbUrlForDatabase(name) {
  const u = new URL(process.env.DB_URL);
  u.pathname = "/" + name;
  return u.toString();
}

/**
 * Proves the per-tenant memory boundary IS the database: two real `rig_t_isoa_mem` / `rig_t_isob_mem`
 * databases, each tenant writes its own marker, and a STRONG NEGATIVE ORACLE — A returns A but NEVER B,
 * and vice-versa — so the test fails if isolation regresses rather than passing on an always-empty
 * result. Also verifies `assertCurrentDatabase` passes on the right DB and throws on a wrong one.
 *
 * Requires CREATEDB (the pgvector CI service container has it). A privilege failure here is what the
 * load-bearing skip-latch in main() refuses to swallow silently.
 */
async function runTenantIsolationTests() {
  console.log("\n=== Cross-tenant DB isolation (rc#1478 Part 2) ===");
  const dbA = "rig_t_isoa_mem";
  const dbB = "rig_t_isob_mem";

  // Admin connection (DB_URL's own database) to create/drop the two tenant DBs. CREATE DATABASE throws
  // insufficient_privilege (42501) without CREATEDB — surfaced to the skip-latch, never silently passed.
  const admin = await createPool();
  for (const db of [dbA, dbB]) {
    await admin.query(`DROP DATABASE IF EXISTS ${db}`);
    await admin.query(`CREATE DATABASE ${db}`);
  }

  const poolA = new Pool({ connectionString: dbUrlForDatabase(dbA) });
  const poolB = new Pool({ connectionString: dbUrlForDatabase(dbB) });
  try {
    // assertCurrentDatabase: right DB passes, wrong DB fails closed.
    await assertCurrentDatabase(poolA, dbA);
    assert(true, `assertCurrentDatabase passes on the correct DB (${dbA})`);
    let wrongThrew = false;
    try { await assertCurrentDatabase(poolA, dbB); } catch { wrongThrew = true; }
    assert(wrongThrew, "assertCurrentDatabase throws on a wrong-DB connection (fail closed)");

    await initSchema(poolA);
    await initSchema(poolB);

    // Each tenant writes ONLY its own marker into ONLY its own database.
    await insertMemory(poolA, {
      agent_role: "iso", written_by_agent: "iso", repo: "iso/repo", scope: "s", kind: "k",
      title: "marker-A", content: "alpha-only secret", tags: [], importance: 3, expires_at: null, embedding: null,
    });
    await insertMemory(poolB, {
      agent_role: "iso", written_by_agent: "iso", repo: "iso/repo", scope: "s", kind: "k",
      title: "marker-B", content: "beta-only secret", tags: [], importance: 3, expires_at: null, embedding: null,
    });

    // Strong negative oracle: A sees A but NEVER B, and vice-versa.
    const aTitles = (await listRecent(poolA, { agent_role: null, repo: null, limit: 100 })).map((r) => r.title);
    assert(aTitles.includes("marker-A"), "tenant A's DB contains marker-A");
    assert(!aTitles.includes("marker-B"), "tenant A's DB does NOT contain marker-B (cross-tenant isolation)");

    const bTitles = (await listRecent(poolB, { agent_role: null, repo: null, limit: 100 })).map((r) => r.title);
    assert(bTitles.includes("marker-B"), "tenant B's DB contains marker-B");
    assert(!bTitles.includes("marker-A"), "tenant B's DB does NOT contain marker-A (cross-tenant isolation)");
  } finally {
    await poolA.end();
    await poolB.end();
    for (const db of [dbA, dbB]) {
      try { await admin.query(`DROP DATABASE IF EXISTS ${db}`); } catch { /* best effort cleanup */ }
    }
    await admin.end();
  }
}

// ---------- Main ----------

async function main() {
  console.log("=== Tenant Binding Tests (rc#1478) ===");
  runTenantTests();

  console.log("\n=== SQLite Backend Tests ===");
  await runSqliteTests();

  if (process.env.DB_URL) {
    console.log("\n=== Postgres Backend Tests ===");
    try {
      await runPostgresTests();
    } finally {
      await pool?.end();
    }

    // Cross-tenant DB-isolation suite — LOAD-BEARING. It MUST actually run; a silent skip (e.g. a future
    // least-privilege role without CREATEDB) would turn the only proof of memory isolation into a no-op.
    // Hard-fail unless explicitly opted out via ALLOW_SKIP_ISOLATION_TEST=true — and even then ONLY for a
    // CREATEDB-privilege error; a real isolation assertion failure always fails the suite.
    try {
      await runTenantIsolationTests();
    } catch (e) {
      const isCreateDbPriv =
        e.code === "42501" ||
        /permission denied to create database|must be superuser|CREATEDB/i.test(e.message || "");
      if (isCreateDbPriv && process.env.ALLOW_SKIP_ISOLATION_TEST === "true") {
        console.warn(`\n[isolation] SKIPPED (ALLOW_SKIP_ISOLATION_TEST=true): ${e.message}`);
      } else {
        console.error(
          `\n[isolation] FAILED (load-bearing — not skippable without ALLOW_SKIP_ISOLATION_TEST): ${e.message}`
        );
        if (failed === 0) failed++;
      }
    }
  } else {
    console.log("\n(Postgres + isolation tests skipped — DB_URL not set)");
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Test suite error:", err.message);
  process.exit(1);
});
