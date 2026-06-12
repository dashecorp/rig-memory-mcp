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
  assertCurrentDatabase,
  insertMemory,
  searchMemories,
  listRecent,
  markUsed,
  compactRepo,
  createSqliteBackend,
} from "./db.js";
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

// ---------- Tenant DB-isolation tests (rc#1478) ----------

/**
 * Prove HARD per-tenant isolation: two real per-tenant databases (rig_t_isoa_mem,
 * rig_t_isob_mem), a write under tenant A is NEVER visible from tenant B's connection —
 * because B's pool is connected to a DIFFERENT DATABASE, not because a filter excluded it.
 * Also proves assertCurrentDatabase fails closed on a wrong connection.
 *
 * STRONG NEGATIVE ORACLE: each tenant writes its OWN marker, and the cross-tenant assertions
 * check that B's query RETURNS B's marker but NOT A's (and vice-versa) — not merely that the
 * result set is empty. An always-returns-nothing query bug therefore cannot masquerade as
 * isolation: the test only passes if the query actually works AND is physically isolated.
 *
 * Requires CREATEDB privilege (the CI pgvector superuser has it). Returns `true` when the
 * isolation assertions actually ran, `false` when it had to skip (no CREATEDB) — the caller
 * (main) HARD-FAILS on a skip in the security lane so this load-bearing test can never
 * silently no-op while CI reports green. A constrained local env may opt out explicitly with
 * ALLOW_SKIP_ISOLATION_TEST=true.
 *
 * @returns {Promise<boolean>} true iff the cross-tenant isolation assertions executed
 */
async function runTenantIsolationTests() {
  console.log("\n=== Postgres: tenant DB-per-tenant isolation (rc#1478) ===");

  const dbA = memoryDbName("isoa"); // rig_t_isoa_mem
  const dbB = memoryDbName("isob"); // rig_t_isob_mem

  // Derive a per-DB DSN from the admin DB_URL by swapping the database name.
  const dsnFor = (dbName) => {
    const u = new URL(process.env.DB_URL);
    u.pathname = `/${dbName}`;
    return u.toString();
  };

  // Create the two tenant databases (DROP first for idempotency). CREATE/DROP DATABASE cannot
  // run in a transaction — pg auto-commits single statements, so these are fine.
  try {
    for (const db of [dbA, dbB]) {
      await pool.query(`DROP DATABASE IF EXISTS ${db}`);
      await pool.query(`CREATE DATABASE ${db}`);
    }
  } catch (e) {
    console.log(`  skip: cannot CREATE DATABASE (${e.message}) — needs CREATEDB`);
    return false; // caller hard-fails in the security lane unless ALLOW_SKIP_ISOLATION_TEST=true
  }

  const A_TITLE = "TENANT-A-ONLY pgvector isolation marker";
  const B_TITLE = "TENANT-B-ONLY pgvector isolation marker";

  const { Pool } = (await import("pg")).default;
  let poolA, poolB;
  try {
    poolA = new Pool({ connectionString: dsnFor(dbA) });
    poolB = new Pool({ connectionString: dsnFor(dbB) });

    // assertCurrentDatabase passes for the right name, throws for the wrong one.
    const okName = await assertCurrentDatabase(poolA, dbA);
    assert(okName === dbA, `assertCurrentDatabase passes when connected to ${dbA}`);
    let mismatchThrew = false;
    try { await assertCurrentDatabase(poolA, dbB); } catch { mismatchThrew = true; }
    assert(mismatchThrew, "assertCurrentDatabase throws when expected != actual (fail closed)");

    // Init schema in each tenant DB, then each tenant writes its OWN marker.
    await initSchema(poolA);
    await initSchema(poolB);
    const mk = (title) => ({
      agent_role: "iso-agent", written_by_agent: "iso-agent", repo: "dashecorp/iso-test",
      scope: "project", kind: "decision", title,
      content: `${title} — must surface ONLY under its own tenant's database.`,
      tags: ["iso"], importance: 5,
    });
    await insertMemory(poolA, mk(A_TITLE));
    await insertMemory(poolB, mk(B_TITLE));

    const search = (p) => searchMemories(p, {
      query: "isolation marker", agent_role: null, repo: null, issue_id: null, limit: 10, embedding: null,
    });

    // STRONG ORACLE — A sees ONLY A; the same query under B sees ONLY B. The query demonstrably
    // works (each returns its own marker), so "B never returns A" is genuine isolation, not an
    // always-empty result. This is the load-bearing cross-tenant-bleed proof.
    const aHits = await search(poolA);
    assert(aHits.some((r) => r.title === A_TITLE), "tenant A's query returns A's own marker (query works)");
    assert(!aHits.some((r) => r.title === B_TITLE), "tenant A NEVER returns tenant B's marker (DB isolation, not a filter)");

    const bHits = await search(poolB);
    assert(bHits.some((r) => r.title === B_TITLE), "tenant B's query returns B's own marker (query works)");
    assert(!bHits.some((r) => r.title === A_TITLE), "tenant B NEVER returns tenant A's marker (DB isolation, not a filter)");

    // listRecent is likewise physically scoped to each tenant's database.
    const aRecent = await listRecent(poolA, { agent_role: null, repo: null, limit: 100 });
    assert(aRecent.some((r) => r.title === A_TITLE), "tenant A listRecent shows A's marker");
    assert(!aRecent.some((r) => r.title === B_TITLE), "tenant A listRecent NEVER shows tenant B's marker");
    const bRecent = await listRecent(poolB, { agent_role: null, repo: null, limit: 100 });
    assert(bRecent.some((r) => r.title === B_TITLE), "tenant B listRecent shows B's marker");
    assert(!bRecent.some((r) => r.title === A_TITLE), "tenant B listRecent NEVER shows tenant A's marker");

    return true; // the isolation assertions executed
  } finally {
    await poolA?.end();
    await poolB?.end();
    // Drop the tenant DBs (can't drop a DB with open connections — pools are closed above).
    for (const db of [dbA, dbB]) {
      try { await pool.query(`DROP DATABASE IF EXISTS ${db}`); } catch { /* best-effort cleanup */ }
    }
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
      const isolationRan = await runTenantIsolationTests();
      // The cross-tenant isolation suite is the load-bearing proof of the rig's top-stated
      // failure mode (memory bleed). It must never silently skip-and-pass: when DB_URL is set
      // (the security lane), a skip is a HARD FAIL unless explicitly opted out for a constrained
      // local env. This stops a future least-privilege PG role from turning it into a no-op while
      // CI stays green.
      const allowSkip = process.env.ALLOW_SKIP_ISOLATION_TEST === "true";
      assert(
        isolationRan || allowSkip,
        "cross-tenant DB-isolation suite executed (needs CREATEDB; set ALLOW_SKIP_ISOLATION_TEST=true to bypass in a constrained env)"
      );
      if (!isolationRan && allowSkip) {
        console.log("  WARN: isolation suite skipped via ALLOW_SKIP_ISOLATION_TEST — the core security property was NOT exercised this run");
      }
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
