/**
 * Event emission to Conductor-E.
 *
 * Mirrors successful memory MCP tool calls as events in Conductor-E's event
 * store (Marten). Payload shape matches `SubmitEventRequest` in
 * dashecorp/conductor-e `src/ConductorE.Core/UseCases/SubmitEvent.cs`:
 * PascalCase fields, UPPER_SNAKE event types.
 *
 * Emitted types (all known to SubmitEvent's MapToEvent switch):
 *   - MEMORY_WRITE     on write_memory
 *   - MEMORY_READ      on read_memories
 *   - MEMORY_HIT_USED  on mark_used
 *
 * `list_recent` and `compact_repo` have no matching Conductor record type
 * (yet) — skipped silently. Add them on the Conductor side if we want them.
 *
 * Fire-and-forget: emission failures log but never break the MCP call.
 * Silent skip when CONDUCTOR_BASE_URL is unset (local dev / standalone).
 *
 * FUTURE: replace with OTel GenAI span emission once the rig has an OTel
 * collector deployed (whitepaper observability.md). Payload shape is close
 * to OTel attributes so the migration is near-lossless.
 */

const CONDUCTOR_BASE_URL = process.env.CONDUCTOR_BASE_URL || "";
const AGENT_ROLE = process.env.AGENT_ROLE || "";
const WRITTEN_BY_AGENT = process.env.WRITTEN_BY_AGENT || AGENT_ROLE;
const AGENT_ID = process.env.AGENT_ID || WRITTEN_BY_AGENT;

const EMIT_TIMEOUT_MS = 2000;

function post(body) {
  if (!CONDUCTOR_BASE_URL) return;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EMIT_TIMEOUT_MS);

  fetch(`${CONDUCTOR_BASE_URL}/api/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: ctrl.signal,
  })
    .then((r) => {
      if (!r.ok) {
        console.error(`[rig-memory] event emit ${body.Type} → ${r.status}`);
      }
    })
    .catch((e) => {
      console.error(`[rig-memory] event emit ${body.Type} failed: ${e.message}`);
    })
    .finally(() => clearTimeout(timer));
}

/**
 * Emitted after a successful write_memory. Conductor record: MemoryWrite.
 * Required: Repo, IssueNumber, AgentId, Scope, Kind, MemoryId, Tokens.
 */
export function emitMemoryWrite({ repo, issueId, scope, kind, memoryId, tokens = 0 }) {
  post({
    Type: "MEMORY_WRITE",
    Repo: repo || "",
    IssueNumber: issueId ?? 0,
    AgentId: AGENT_ID,
    Scope: scope || "",
    Kind: kind || "",
    MemoryId: memoryId || "",
    Tokens: tokens,
  });
}

/**
 * Emitted after a successful read_memories. Conductor record: MemoryRead.
 * Required: Repo, IssueNumber, AgentId, Query, Hits, TokensLoaded.
 */
export function emitMemoryRead({ repo, issueId, query, hits, tokensLoaded = 0 }) {
  post({
    Type: "MEMORY_READ",
    Repo: repo || "",
    IssueNumber: issueId ?? 0,
    AgentId: AGENT_ID,
    Query: query || "",
    Hits: hits ?? 0,
    TokensLoaded: tokensLoaded,
  });
}

/**
 * Emitted after a successful mark_used. Conductor record: MemoryHitUsed.
 * Required: MemoryId, AgentId, UsedInOutput.
 */
export function emitMemoryHitUsed({ memoryId, usedInOutput = true }) {
  post({
    Type: "MEMORY_HIT_USED",
    MemoryId: memoryId || "",
    AgentId: AGENT_ID,
    UsedInOutput: usedInOutput,
  });
}
