/**
 * Event emission to Conductor-E.
 *
 * Every successful memory tool call mirrors to Conductor-E's /api/events
 * endpoint so the rig's central event store / dashboards see memory activity
 * alongside cli_started, token_usage, heartbeat, etc.
 *
 * Fire-and-forget: emission failures never break the MCP call. Silent skip
 * when CONDUCTOR_BASE_URL is unset (local dev / standalone use).
 *
 * FUTURE: replace with OTel GenAI span emission once the rig has an OTel
 * collector deployed (whitepaper observability.md). Until then, the JSON
 * POST keeps the same payload shape so the migration is lossless.
 */

const CONDUCTOR_BASE_URL = process.env.CONDUCTOR_BASE_URL || "";
const AGENT_ROLE = process.env.AGENT_ROLE || "";
const WRITTEN_BY_AGENT = process.env.WRITTEN_BY_AGENT || AGENT_ROLE;
const AGENT_ID = process.env.AGENT_ID || WRITTEN_BY_AGENT;

const EMIT_TIMEOUT_MS = 2000;

/**
 * Emit a memory event to Conductor-E. Non-blocking; errors are logged but swallowed.
 *
 * @param {string} type - event type, e.g. "memory_written", "memory_read"
 * @param {object} payload - event-specific fields (merged with agent identity)
 */
export function emitEvent(type, payload = {}) {
  if (!CONDUCTOR_BASE_URL) return;

  const body = {
    type,
    agentId: AGENT_ID,
    agentRole: AGENT_ROLE,
    writtenByAgent: WRITTEN_BY_AGENT,
    timestamp: new Date().toISOString(),
    ...payload,
  };

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
        console.error(`[rig-memory] event emit ${type} → ${r.status}`);
      }
    })
    .catch((e) => {
      // Swallow — never let telemetry break the tool call.
      console.error(`[rig-memory] event emit ${type} failed: ${e.message}`);
    })
    .finally(() => clearTimeout(timer));
}
