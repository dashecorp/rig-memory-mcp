---
title: "Memory-plane multi-tenancy: DB-per-tenant (rc#1478)"
type: decision
status: accepted
created: "2026-06-12"
updated: "2026-06-13"
topic: multi-tenancy
source_refs:
  - https://github.com/dashecorp/rig-conductor/issues/1478
  - https://github.com/dashecorp/rig-memory-mcp/issues/19
  - https://github.com/dashecorp/rig-memory-mcp/pull/20
  - https://github.com/dashecorp/rig-memory-mcp/issues/21
---

# Memory-plane multi-tenancy: one DB per tenant (rc#1478)

## Decision

Each tenant's agent memory lives in a **physically separate Postgres+pgvector database**, named
`rig_t_<id>_mem`. **Not** a shared `rig_memory` table with a `tenant_id` column and a retrieval filter.

> *The LLM is the threat model, not the guard.* A forgotten or prompt-injected retrieval predicate on a
> shared table is a cross-tenant leak; a wrong **database connection** simply cannot return another
> tenant's rows. The boundary is the connection, enforced at process startup — there is no per-call
> tenant and no filter to forget.

## How it's enforced

This MCP server is a STDIO server — **one process per agent** — so the tenant boundary is the process,
bound **once** at startup from the server-trusted `TENANT_ID` env var (set by the conductor when it
materializes the agent's pod/session), **never** from an MCP tool argument.

- **Policy** (`tenant.js`, Part 1 / PR #20): slug grammar + reserved blocklist ported verbatim from
  rig-conductor `TenantId` (`^[a-z][a-z0-9]{1,19}$`); `memoryDbName` → `rig_t_<id>_mem`;
  `resolveTenantBinding` (throws on invalid `TENANT_ID`, never defaults); `findForbiddenTenantArg`.
- **Adapter** (`index.js` + `db.js`, Part 2 / #21): with `TENANT_ID` set, `createBackend` **requires** a
  per-tenant `DB_URL`, calls `assertCurrentDatabase(pool, rig_t_<id>_mem)` **before** `initSchema`
  (a wrong-DB DSN can't even create the schema in the wrong place), **disables the SQLite fallback**, and
  is **fatal** on any failure. The `CallTool` handler hard-rejects any forbidden tenant/db argument.
- **Proof** (`test.js` `runTenantIsolationTests`): two real `rig_t_isoa_mem` / `rig_t_isob_mem` DBs with a
  strong negative oracle (A returns A but never B, and vice-versa) + `assertCurrentDatabase` right/wrong-DB
  cases. Load-bearing: it hard-fails rather than silently skipping (`ALLOW_SKIP_ISOLATION_TEST` only
  tolerates a missing-CREATEDB-privilege error, never an isolation regression).

Legacy single-tenant mode (`TENANT_ID` unset) is unchanged — tenant-0 (`invotek`) runs there until its
memory plane is cut over to `rig_t_invotek_mem`.

## Why not the alternatives

- **Shared table + `tenant_id` filter** — rejected: one forgotten/injected predicate leaks across tenants.
- **Postgres RLS (`FORCE ROW LEVEL SECURITY`)** — viable but still one shared DB; a misconfigured policy or
  a `BYPASSRLS` role leaks, and erasure is a `DELETE` (not a `DROP DATABASE`). DB-per-tenant makes Art.17
  erasure a physical per-tenant `DROP DATABASE`.

## Tracked follow-ups

1. **Per-tenant `MEMORY_*` telemetry** — tag the `events.js` `MEMORY_WRITE`/`MEMORY_READ`/`MEMORY_HIT_USED`
   emissions with the resolved tenant so cross-tenant memory cost/usage is attributable in the conductor.
2. **Mandatory `TENANT_ID` at cutover** — once every agent pod is tenant-bound, make `TENANT_ID` required
   (drop the legacy single-tenant path) so a missing binding fails closed instead of using the shared store.
3. **Revisit `assertCurrentDatabase` under pgbouncer** — in transaction-pooling mode `current_database()`
   still reflects the target DB, but verify the assertion holds (and the per-tenant DSN routing) if/when a
   pooler is introduced (gated on the separate security review — third-party-code rule).
4. **Pin `tenant.js` grammar against `TenantId.cs`** — add a CI check that the ported slug grammar +
   reserved blocklist stays byte-for-byte in sync with rig-conductor `src/ConductorE.Core/Domain/TenantId.cs`;
   a drift split-brains the per-tenant DB name (a slug one side accepts and the other rejects).

## Conductor wiring (Part B — separate, on the umbrella)

Injecting the per-tenant `DB_URL`/secret-ref into the agent session (via the conductor's `ITenantResolver`
/ `Tenant` registry) lands when per-tenant agent pods exist — gated on the namespace-per-tenant /
single-tenant-session item (rig-conductor#1482). Tracked on the rc#1478 umbrella, not here.
