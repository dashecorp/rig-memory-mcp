#!/usr/bin/env node

/**
 * rig-memory-mcp — Postgres + pgvector backed MCP memory server.
 *
 * Required env vars:
 *   DB_URL          Postgres connection string
 *   AGENT_ROLE      Role of the running agent (e.g. "dev-e")
 *
 * Optional env vars:
 *   WRITTEN_BY_AGENT  Defaults to AGENT_ROLE
 *   REPO              Default repo slug for writes (e.g. "dashecorp/my-repo")
 *   OPENAI_API_KEY    Enables vector embeddings (text-embedding-3-small)
 *   OPENAI_BASE_URL   Override OpenAI base URL (for compatible endpoints)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import {
  createPool,
  initSchema,
  insertMemory,
  searchMemories,
  listRecent,
  markUsed,
  compactRepo,
} from "./db.js";

// ---------- Config ----------

const AGENT_ROLE = process.env.AGENT_ROLE;
const WRITTEN_BY_AGENT = process.env.WRITTEN_BY_AGENT || AGENT_ROLE;
const DEFAULT_REPO = process.env.REPO || "";

if (!AGENT_ROLE) {
  console.error("[rig-memory] FATAL: AGENT_ROLE env var is required");
  process.exit(1);
}

// ---------- Embeddings (optional) ----------

let openaiClient = null;

async function initEmbeddings() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("[rig-memory] OPENAI_API_KEY not set — running text-only mode");
    return;
  }

  try {
    const { default: OpenAI } = await import("openai");
    openaiClient = new OpenAI({
      apiKey,
      baseURL: process.env.OPENAI_BASE_URL,
    });
    console.error("[rig-memory] Embeddings enabled (text-embedding-3-small)");
  } catch {
    console.error("[rig-memory] Failed to load openai — text-only mode");
  }
}

/** Generate a 1536-dim embedding, or null if unavailable. */
async function embed(text) {
  if (!openaiClient) return null;
  try {
    const res = await openaiClient.embeddings.create({
      model: "text-embedding-3-small",
      input: text,
    });
    return res.data[0].embedding;
  } catch (err) {
    console.error("[rig-memory] Embedding error:", err.message);
    return null;
  }
}

// ---------- Tool definitions ----------

const TOOLS = [
  {
    name: "write_memory",
    description:
      "Persist a memory to the shared Postgres store. " +
      "Agent identity (role, repo) is taken from server env vars.",
    inputSchema: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          description:
            "Logical scope: 'session', 'project', 'repo', 'global', etc.",
        },
        kind: {
          type: "string",
          description:
            "Memory kind: 'decision', 'error', 'learning', 'pattern', 'standard', 'context', etc.",
        },
        title: {
          type: "string",
          description: "Short, searchable title (≤ 120 chars).",
        },
        content: {
          type: "string",
          description: "Full memory content.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of tags for filtering.",
          default: [],
        },
        importance: {
          type: "number",
          description: "Importance 1 (low) – 5 (critical). Default 3.",
          minimum: 1,
          maximum: 5,
          default: 3,
        },
        repo: {
          type: "string",
          description:
            "Target repo slug (overrides REPO env var if provided).",
        },
        issue_id: {
          type: "number",
          description: "Optional GitHub issue number this memory is tied to.",
        },
        expires_at: {
          type: "string",
          description:
            "Optional ISO-8601 expiry timestamp. Memory is hidden after this date.",
        },
      },
      required: ["scope", "kind", "title", "content"],
    },
  },
  {
    name: "read_memories",
    description:
      "Retrieve memories using hybrid BM25 (tsvector) + vector search. " +
      "All filter params are optional — omit to search broadly.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Natural-language search query.",
        },
        agent_role: {
          type: "string",
          description: "Filter by agent role.",
        },
        repo: {
          type: "string",
          description: "Filter by repo slug.",
        },
        issue_id: {
          type: "number",
          description: "Filter by GitHub issue number.",
        },
        limit: {
          type: "number",
          description: "Max results to return (default 20).",
          default: 20,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "list_recent",
    description: "List the most recently written memories for an agent/repo.",
    inputSchema: {
      type: "object",
      properties: {
        agent_role: {
          type: "string",
          description: "Filter by agent role.",
        },
        repo: {
          type: "string",
          description: "Filter by repo slug.",
        },
        limit: {
          type: "number",
          description: "Max results (default 10).",
          default: 10,
        },
      },
    },
  },
  {
    name: "mark_used",
    description:
      "Record that a memory was retrieved and used. Increments hit_count.",
    inputSchema: {
      type: "object",
      properties: {
        memory_id: {
          type: "string",
          description: "UUID of the memory to mark as used.",
        },
      },
      required: ["memory_id"],
    },
  },
  {
    name: "compact_repo",
    description:
      "Summarize and prune old memories for a repo. " +
      "Groups entries by scope+kind, collapses groups into a single summary, " +
      "then deletes the originals. Also purges expired entries.",
    inputSchema: {
      type: "object",
      properties: {
        repo: {
          type: "string",
          description: "Repo slug to compact.",
        },
        older_than_days: {
          type: "number",
          description: "Only compact memories older than N days (default 30).",
          default: 30,
        },
      },
      required: ["repo"],
    },
  },
];

// ---------- Server ----------

async function main() {
  // DB
  const pool = await createPool();
  await initSchema(pool);
  console.error("[rig-memory] Postgres connected, schema ready");

  // Embeddings (best-effort)
  await initEmbeddings();

  // MCP server
  const server = new Server(
    { name: "rig-memory-mcp", version: "2.0.0" },
    { capabilities: { tools: {} } }
  );

  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;

    try {
      switch (name) {
        case "write_memory": {
          const repo = args.repo || DEFAULT_REPO;
          if (!repo) {
            return err("repo is required (pass as arg or set REPO env var)");
          }

          const embedding = await embed(`${args.title}\n\n${args.content}`);

          const id = await insertMemory(pool, {
            agent_role: AGENT_ROLE,
            written_by_agent: WRITTEN_BY_AGENT,
            repo,
            issue_id: args.issue_id ?? null,
            scope: args.scope,
            kind: args.kind,
            title: args.title,
            content: args.content,
            tags: args.tags ?? [],
            importance: args.importance ?? 3,
            expires_at: args.expires_at ?? null,
            embedding,
          });

          return ok({
            id,
            message: `Memory saved (id: ${id})`,
            embedded: embedding !== null,
          });
        }

        case "read_memories": {
          const embedding = await embed(args.query);

          const rows = await searchMemories(pool, {
            query: args.query,
            agent_role: args.agent_role ?? null,
            repo: args.repo ?? null,
            issue_id: args.issue_id ?? null,
            limit: args.limit ?? 20,
            embedding,
          });

          return ok({
            memories: rows.map(formatMemory),
            total: rows.length,
            mode: embedding ? "hybrid" : "text-only",
          });
        }

        case "list_recent": {
          const rows = await listRecent(pool, {
            agent_role: args.agent_role ?? null,
            repo: args.repo ?? null,
            limit: args.limit ?? 10,
          });

          return ok({
            memories: rows.map(formatMemory),
            total: rows.length,
          });
        }

        case "mark_used": {
          const found = await markUsed(pool, args.memory_id);
          return ok({ found, memory_id: args.memory_id });
        }

        case "compact_repo": {
          const result = await compactRepo(pool, {
            repo: args.repo,
            older_than_days: args.older_than_days ?? 30,
            agent_role: AGENT_ROLE,
            written_by_agent: WRITTEN_BY_AGENT,
          });

          return ok({
            repo: args.repo,
            deleted: result.deleted,
            summaries_created: result.summaries_created,
            message:
              `Compacted ${args.repo}: deleted ${result.deleted} memories, ` +
              `created ${result.summaries_created} summaries`,
          });
        }

        default:
          return err(`Unknown tool: ${name}`);
      }
    } catch (e) {
      console.error(`[rig-memory] Tool error (${name}):`, e.message);
      return err(e.message);
    }
  });

  // Start stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[rig-memory] MCP server running on stdio");
}

// ---------- Helpers ----------

function ok(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function err(msg) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: msg }) }],
    isError: true,
  };
}

function formatMemory(row) {
  return {
    id: row.id,
    agent_role: row.agent_role,
    written_by_agent: row.written_by_agent,
    repo: row.repo,
    issue_id: row.issue_id,
    scope: row.scope,
    kind: row.kind,
    title: row.title,
    content: row.content,
    tags: row.tags,
    importance: row.importance,
    created_at: row.created_at,
    expires_at: row.expires_at,
    hit_count: row.hit_count,
    last_used_at: row.last_used_at,
    // search scores (present on read_memories results)
    text_score: row.text_score,
    vec_score: row.vec_score,
    hybrid_score: row.hybrid_score,
  };
}

main().catch((err) => {
  console.error("[rig-memory] Fatal error:", err.message);
  process.exit(1);
});
