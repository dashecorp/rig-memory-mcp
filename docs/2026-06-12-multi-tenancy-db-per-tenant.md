---
title: "Multi-tenancy: pgvector DB-per-tenant memory isolation (rc#1478)"
description: "rig-memory-mcp gives each tenant a physically separate Postgres+pgvector database (rig_t_<id>_mem), bound once per process from a server-trusted TENANT_ID — never a shared table with a tenant filter, never an MCP tool argument. The connection IS the isolation boundary; multi-tenant mode requires a per-tenant DSN, asserts it lands on the right database, and has no SQLite fallback. Part A (this server) is complete; Part B (conductor injection of the per-tenant DSN) lands with per-tenant agent pods (#1482)."
type: decision
status: accepted
audience: both
updated: 2026-06-12
---

# pgvector DB-per-tenant memory isolation (rc#1478)

Second of the three rig data planes to be hard-siloed per tenant (after the Marten event store, before agent-session PVCs). Cross-tenant memory bleed is the **top failure mode** in the multi-tenancy proposal: a prompt-injected issue/PR/Discord body most easily triggers it if retrieval is soft-filtered. The non-negotiable: **hard memory isolation shipped before a 2nd tenant's data lands.**

## Decision: the connection is the boundary, not a filter

Each tenant's agent memory lives in a **separate Postgres+pgvector database**, `rig_t_<id>_mem`. There is **no `tenant_id` column** on `rig_memory` and **no retrieval-time tenant `WHERE` filter**. *The LLM is the threat model, not the guard:* a forgotten or LLM-influenced predicate on a shared table is a leak; a wrong database connection **cannot** return another tenant's rows. The worst case degrades from "silent cross-tenant read" to "connection error / refuse-to-start."

The DB name is `rig_t_<id>_mem` — the **frozen naming convention** (rc#1488), a pure concatenation off a validated slug. (Note: #1478's original body wrote `rig_mem_t_<id>`; that predates the ratified convention. `rig_t_<id>_mem` is authoritative and matches the event-store `rig_t_<id>_evt`, roles `rig_t_<id>_app`/`_ro`, namespace `tenant-<id>`, etc.)

## Why process-level binding (not a per-request pool registry)

#1478's sketch described a "tenant-keyed pool registry: resolve tenant_id → DSN → cached Pool per request." That assumes a shared HTTP server multiplexing tenants. **rig-memory-mcp is a stdio server — one process per agent.** The agent pod is already single-tenant for its whole lifetime (the namespace-per-tenant item), so the natural and *strongest* boundary is the **process**: it only ever holds one tenant's connection, so there is literally no code path from which one tenant's request could reach another's database. That is a stronger guarantee than a per-request registry (which keeps every tenant's pool in one address space).

So the binding is: **`TENANT_ID` env var, set by the conductor at pod/session materialization, read once at startup.** It is never an MCP tool argument; a request that smuggles `tenant`/`tenant_id`/`db`/`db_url` is hard-rejected (`findForbiddenTenantArg`).

## Fail-closed startup (multi-tenant mode = `TENANT_ID` set)

1. **Validate the slug** (`tenant.js`, ported verbatim from rig-conductor `TenantId`: `^[a-z][a-z0-9]{1,19}$` + reserved blocklist + `pg`/`kube` prefix block). Invalid → fatal. Never coalesce to a default.
2. **Require a per-tenant `DB_URL`.** No SQLite fallback — a single file could silently merge two tenants. Missing DSN → fatal.
3. **Assert the live connection lands on `rig_t_<id>_mem`** (`assertCurrentDatabase` → `SELECT current_database()`). A misconfigured DSN pointing at the wrong (or a shared) database → fatal. This is the defense-in-depth that makes a bad injection fail closed rather than silently cross the boundary.
4. **`initSchema` per tenant DB** (idempotent `CREATE EXTENSION vector`, table, GIN + HNSW). The server **never `CREATE DATABASE`s** — provisioning `rig_t_<id>_mem` is a deliberate operator/onboarding step (mirrors `TenantSeedService` no-auto-provision). An unknown tenant's DB does not exist → the connection fails → refuse to start.

**Single-tenant / legacy mode** (`TENANT_ID` unset) is unchanged: Postgres (`DB_URL`) with SQLite fallback. Tenant-0 (`invotek`) runs here until its memory plane is cut over to `rig_t_invotek_mem` (a later migration, paired with the event-store cutover).

## Right to erasure

DB-per-tenant makes Art.17 erasure of the memory plane a single `DROP DATABASE rig_t_<id>_mem` — complete and orphan-free (no rows stranded in a shared table, no read models to scrub). This is the defensible erasure primitive the GDPR pack (#1486) relies on for the memory plane.

## Tests (`test.js`)

- **Tenant binding (pure, always runs):** slug validation incl. injection / homoglyph / reserved / reserved-prefix; `Inv`→`inv` normalization; `rig_t_<id>_mem` derivation; `resolveTenantBinding` legacy-vs-multi + fail-closed throw on reserved id; forbidden-arg guard.
- **DB-per-tenant isolation (Postgres suite):** create two real databases `rig_t_isoa_mem` / `rig_t_isob_mem`; a write under A is **never** returned by `searchMemories`/`listRecent` under B (and vice-versa) — proven by hitting the **wrong database**, not by asserting a filter excluded it; `assertCurrentDatabase` passes on match and throws on mismatch. (Needs CREATEDB; logs a skip if unavailable.)

Verified locally against `pgvector/pgvector:pg16`: 121/121 pass, and the three fail-closed startup paths (no-DSN, wrong-DB, right-DB) behave as specified.

## Scope: Part A done, Part B staged

- **Part A — rig-memory-mcp (this repo): COMPLETE.** Per-tenant DB binding, fail-closed startup, no-shared-table guarantee, erasure primitive, tests, docs.
- **Part B — rig-conductor wiring: STAGED behind #1482.** Injecting the per-tenant memory DSN/secret-ref into the agent session uses the P0 `ITenantResolver` / `Tenant` registry, but it hangs off **per-tenant agent-pod materialization**, which does not exist until the namespace-per-tenant item (#1482) lands. This server is ready for that injection now (set `TENANT_ID` + a `rig_t_<id>_mem` DSN). Tracked as the remaining half of #1478.

The per-tenant `DB_URL` must ultimately be delivered as a tenant-prefixed secret-ref resolved by the Agent-Secrets-Broker under the session's bound tenant (the ratified `<provider>:tenant-<id>/…` grammar, #1479) — never a raw cross-tenant DSN through an MCP argument.

## Tracked follow-ups — MUST land before any 2nd tenant goes active

These are out of scope for Part A (they don't affect the single-tenant invotek deployment and the #1493 onboarding gate blocks a 2nd active tenant until conversion exists), but they are the residual edges an adversarial review surfaced. Tracked here, not absorbed silently into "Part B":

1. **Tag MEMORY_* telemetry with the tenant.** `events.js` emits `MEMORY_WRITE`/`MEMORY_READ`/`MEMORY_HIT_USED` to the conductor's shared event plane carrying `repo`/`scope`/`memoryId` and the LLM-controlled raw `query` string, **untagged**. The DB-per-tenant boundary does not cover this out-of-band emission. `tenant.tenantId` is in scope at emit time — thread it onto every emit and have the conductor route/scope `MEMORY_*` per tenant. (Pre-existing behaviour; no regression here, but a metadata/query-string egress that must close before a 2nd tenant.)
2. **Make `TENANT_ID` mandatory at cutover.** Blank/unset `TENANT_ID` = legacy shared-store mode by design (the tenant-0 contract). Once a 2nd tenant exists, a dropped/blanked `TENANT_ID` while `DB_URL` names a `rig_t_*_mem` database would degrade a real tenant to legacy mode. Belt-and-suspenders: once multi-tenant, treat unset/blank `TENANT_ID` as fatal, or refuse legacy mode when `DB_URL` names a `rig_t_*_mem` database.
3. **Revisit `assertCurrentDatabase` if a connection pooler lands.** `SELECT current_database()` reflects whatever DB a pooler routed this checkout to; under transaction/statement pooling a later query could land elsewhere. Keep memory on a direct, non-pooled DSN, or use a session-bound non-spoofable check. (Inert today — no pgbouncer on this plane.)
4. **Pin `tenant.js`'s grammar against rig-conductor `TenantId.cs`** with a contract/fixture test so future drift is caught, not trusted (the module header already warns "keep in sync").
