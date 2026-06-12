/**
 * Multi-tenancy tenant binding for rig-memory-mcp (rc#1478 — pgvector DB-per-tenant).
 *
 * Hard memory isolation = ONE Postgres+pgvector DATABASE per tenant (`rig_t_<id>_mem`),
 * NOT a shared table with a `tenant_id` filter. "The LLM is the threat model, not the
 * guard": a forgotten or prompt-injected retrieval predicate on a shared table is a leak;
 * a wrong database connection cannot return another tenant's rows.
 *
 * This MCP server is a STDIO server — ONE process per agent — so the tenant boundary is
 * the PROCESS, bound once at startup from a server-trusted env var (`TENANT_ID`, set by
 * the conductor when it materializes the agent's pod/session), NEVER from an MCP tool
 * argument. There is no per-call tenant: the whole process only ever holds one tenant's
 * connection. This module validates that binding and derives the tenant's DB name.
 *
 * The slug grammar + reserved blocklist are PORTED VERBATIM from the rig-conductor
 * `TenantId` value object (`src/ConductorE.Core/Domain/TenantId.cs`, rc#1459/#1477 — the
 * §7 single-validation-chokepoint of the ratified naming convention
 * `docs/2026-06-08-multi-tenancy-tenant-id-naming-convention.md`). Keep them in sync: a
 * slug the conductor accepts but this server rejects (or vice-versa) would split-brain the
 * per-tenant DB name. The DB name `rig_t_<id>_mem` is the frozen convention (NOT the
 * `rig_mem_t_<id>` form in #1478's original body — that predates the ratified convention).
 */

/** The canonical slug pattern — separator-free lowercase ASCII, 2–20 chars, no leading digit. */
export const TENANT_SLUG_PATTERN = /^[a-z][a-z0-9]{1,19}$/;

/**
 * Reserved ids that must never name a tenant — once affixed (`rig_t_<id>_mem`) they would
 * collide with shared/system infra. Ported from TenantId.Reserved (ordinal compare against
 * the already-lowercased id). `invotek` is intentionally NOT reserved (the valid tenant-0 id).
 */
const RESERVED = new Set([
  // generic / control-plane
  "control", "rig", "system", "admin", "shared", "default", "public", "postgres",
  "kube", "flux", "template", "template0", "template1", "test", "unknown", "none", "null",
  // live rig-infra tokens
  "conductor", "valkey", "primary", "replica", "api", "registry", "marten", "pgvector",
  "secrets", "values", "data", "agent", "session", "ar", "ghcr", "node", "lease",
  "nodelease", "manager", "cert", "gmp", "gke",
]);

/**
 * Reserved leading tokens. Postgres reserves the `pg_` identifier/role prefix and k8s
 * reserves `kube-*`; since an id can contain neither `_` nor `-`, the bare leading substring
 * is blocked instead (the broad `pg` block is the #1500 operator decision).
 */
const RESERVED_PREFIXES = ["pg", "kube"];

/**
 * Validate + normalize an untrusted tenant string (trim + lowercase, then format + blocklist
 * + reserved-prefix). Returns the normalized slug, or null on any violation. Never throws,
 * never coalesces to a default — mirrors TenantId.TryCreate.
 *
 * @param {unknown} input
 * @returns {string|null}
 */
export function tryNormalizeTenantSlug(input) {
  if (typeof input !== "string") return null;
  // Normalize at the boundary: trim + lowercase. toLowerCase folds ASCII; any non-ASCII
  // char survives and is then rejected by the ASCII-only regex.
  const normalized = input.trim().toLowerCase();
  if (!TENANT_SLUG_PATTERN.test(normalized)) return null;
  if (RESERVED.has(normalized)) return null;
  for (const prefix of RESERVED_PREFIXES) {
    if (normalized.startsWith(prefix)) return null;
  }
  return normalized;
}

/** Whether `input` would be accepted as a tenant slug. */
export function isValidTenantSlug(input) {
  return tryNormalizeTenantSlug(input) !== null;
}

/**
 * As {@link tryNormalizeTenantSlug} but throws on an invalid slug.
 * @param {unknown} input
 * @returns {string}
 */
export function normalizeTenantSlug(input) {
  const id = tryNormalizeTenantSlug(input);
  if (id === null) {
    throw new Error(
      `Invalid tenant_id (must match ${TENANT_SLUG_PATTERN}, not reserved, not a reserved prefix): ` +
        `'${typeof input === "string" ? input : typeof input}'`
    );
  }
  return id;
}

/**
 * The immutable per-tenant memory database name. Pure concatenation off a validated slug
 * (the slug forbids `_`/`-`, so `rig_t_<id>_mem` is an unambiguous, collision-free boundary).
 * @param {string} validatedSlug a slug already passed through {@link normalizeTenantSlug}
 * @returns {string}
 */
export function memoryDbName(validatedSlug) {
  return `rig_t_${validatedSlug}_mem`;
}

/**
 * Resolve the process's tenant binding from server-trusted env (NOT from any MCP request).
 *
 * - `TENANT_ID` absent/blank → single-tenant / legacy mode (`{ multiTenant: false }`):
 *   behaviour-neutral, exactly today's shared-store behaviour. Tenant-0 (invotek) runs here
 *   until its memory plane is cut over to `rig_t_invotek_mem`.
 * - `TENANT_ID` set → multi-tenant mode: the slug is validated (throws on invalid — a bad
 *   injected binding must fail closed, never default), and the expected DB name is derived.
 *   The caller then REQUIRES a Postgres DSN (no SQLite fallback) and asserts the connection
 *   actually lands on `expectedDb`.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ multiTenant: false } | { multiTenant: true, tenantId: string, expectedDb: string }}
 */
export function resolveTenantBinding(env = process.env) {
  const raw = env.TENANT_ID;
  if (raw == null || String(raw).trim() === "") {
    return { multiTenant: false };
  }
  const tenantId = normalizeTenantSlug(raw); // throws → fail closed on an invalid binding
  return { multiTenant: true, tenantId, expectedDb: memoryDbName(tenantId) };
}

/**
 * Keys an MCP tool argument must NEVER carry — the tenant is bound from server env, never
 * asserted by the (LLM-driven) caller. Used to hard-reject a request that smuggles one.
 */
export const FORBIDDEN_TENANT_ARG_KEYS = ["tenant", "tenant_id", "tenantId", "db", "db_url", "dbUrl"];

/**
 * Reject any attempt to assert a tenant (or a raw DSN) through tool arguments. Returns an
 * error string if a forbidden key is present, else null. Defense-in-depth: the tools define
 * no such argument, so this can only ever fire on a malicious/poisoned call.
 * @param {Record<string, unknown>|undefined} args
 * @returns {string|null}
 */
export function findForbiddenTenantArg(args) {
  if (!args || typeof args !== "object") return null;
  for (const key of FORBIDDEN_TENANT_ARG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      return `tool argument '${key}' is not permitted — tenant binding is server-resolved, never a request argument`;
    }
  }
  return null;
}
