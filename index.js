#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { createDatabase } from "./db.js";

// Configuration
const CONFIG_PATH = join(homedir(), ".claude", "memory-config.json");
let firestoreSync = null;

// Load config if exists
function loadConfig() {
  if (existsSync(CONFIG_PATH)) {
    try {
      return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    } catch (e) {
      console.error("Failed to load config:", e.message);
    }
  }
  return {};
}

const config = loadConfig();

// Firestore sync module (lazy loaded)
async function initFirestoreSync() {
  if (!config.firestore?.enabled) return null;

  try {
    const { Firestore } = await import("@google-cloud/firestore");

    const firestoreConfig = {
      projectId: config.firestore.projectId,
    };

    if (config.firestore.keyFilePath) {
      firestoreConfig.keyFilename = config.firestore.keyFilePath;
    }

    const firestore = new Firestore(firestoreConfig);
    const collectionPrefix = config.firestore.collectionPrefix || "claude-memory";

    console.error(`Firestore sync enabled: project=${config.firestore.projectId}, prefix=${collectionPrefix}`);

    return {
      firestore,
      collectionPrefix,

      async syncToCloud(table, data) {
        try {
          const docId = `${data.project || 'global'}_${data.id || Date.now()}`;
          await firestore.collection(`${collectionPrefix}_${table}`).doc(docId).set({
            ...data,
            syncedAt: new Date().toISOString(),
            machine: config.machineId || "unknown",
          }, { merge: true });
        } catch (e) {
          console.error(`Firestore sync error (${table}):`, e.message);
        }
      },

      async pullFromCloud(table, project) {
        try {
          const snapshot = await firestore
            .collection(`${collectionPrefix}_${table}`)
            .where("project", "==", project)
            .get();

          return snapshot.docs.map(doc => doc.data());
        } catch (e) {
          console.error(`Firestore pull error (${table}):`, e.message);
          return [];
        }
      },
    };
  } catch (e) {
    console.error("Failed to initialize Firestore:", e.message);
    console.error("Install with: npm install @google-cloud/firestore");
    return null;
  }
}

// Helper function for relative time
function getTimeAgo(timestamp) {
  const now = new Date();
  const then = new Date(timestamp);
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return then.toLocaleDateString();
}

// Temporal decay configuration
const DECAY_LAMBDA = {
  learnings: 0.005,   // half-life ~140 days
  errors: 0.01,       // half-life ~70 days
  decisions: 0.002,   // half-life ~350 days
};

function normalizeTimestamp(ts) {
  if (!ts) return null;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(ts)) {
    return ts.replace(' ', 'T') + 'Z';
  }
  return ts;
}

function computeDecayFactor(createdAt, type) {
  if (!createdAt) return 1;
  const lambda = DECAY_LAMBDA[type] || 0.005;
  const now = Date.now();
  const created = new Date(normalizeTimestamp(createdAt)).getTime();
  const daysSince = (now - created) / (1000 * 60 * 60 * 24);
  return Math.exp(-lambda * daysSince);
}

function formatAge(createdAt) {
  if (!createdAt) return '';
  const now = Date.now();
  const created = new Date(normalizeTimestamp(createdAt)).getTime();
  const days = Math.floor((now - created) / (1000 * 60 * 60 * 24));
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (days < 365) return `${months}mo ago`;
  const years = Math.floor(days / 365);
  return `${years}y ago`;
}

function applyTemporalDecay(results, type, timestampField = 'created_at') {
  return results.map(r => ({
    ...r,
    _decayFactor: computeDecayFactor(r[timestampField], type),
    _age: formatAge(r[timestampField]),
  }));
}

// Create MCP server
const server = new Server(
  {
    name: "claude-memory",
    version: "3.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Database instance (initialized in main())
let db;

// Define tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const syncTools = firestoreSync ? [
    {
      name: "sync_to_cloud",
      description: "Manually sync all local memory to Firestore cloud storage",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project to sync (or 'all' for everything)" },
        },
        required: ["project"],
      },
    },
    {
      name: "pull_from_cloud",
      description: "Pull memory from Firestore cloud for a project",
      inputSchema: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project to pull" },
        },
        required: ["project"],
      },
    },
  ] : [];

  return {
    tools: [
      {
        name: "remember_decision",
        description: "Store a project decision with its rationale for future reference",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name (e.g., 'cutie', 'nutri-e')" },
            decision: { type: "string", description: "What was decided" },
            rationale: { type: "string", description: "Why this decision was made" },
            date: { type: "string", description: "Date of decision (YYYY-MM-DD), defaults to today" },
            category: { type: "string", description: "Category (e.g., 'architecture', 'security', 'api', 'ui', 'devops')" },
          },
          required: ["project", "decision"],
        },
      },
      {
        name: "recall_decisions",
        description: "Retrieve past decisions for a project. Optionally weight results by recency via the temporal_decay flag (default false for decisions).",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
            search: { type: "string", description: "Optional search term" },
            category: { type: "string", description: "Filter by category (e.g., 'architecture', 'security')" },
            limit: { type: "number", description: "Max results (default 10)" },
            temporal_decay: { type: "boolean", description: "Weight results by recency (default false for decisions)" },
          },
          required: ["project"],
        },
      },
      {
        name: "list_decisions",
        description: "List recent decisions for a project without requiring a search term",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
            limit: { type: "number", description: "Max results (default 10)" },
          },
          required: ["project"],
        },
      },
      {
        name: "remember_error",
        description: "Store an error and its solution for future reference",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
            error_pattern: { type: "string", description: "Error message or pattern to match" },
            solution: { type: "string", description: "How the error was fixed" },
            context: { type: "string", description: "Additional context about when this occurs" },
            category: { type: "string", description: "Category (e.g., 'build', 'runtime', 'api', 'database', 'auth')" },
          },
          required: ["project", "error_pattern", "solution"],
        },
      },
      {
        name: "find_solution",
        description: "Search for solutions to an error. Results are weighted by recency (temporal decay) by default.",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
            error: { type: "string", description: "Error message to search for" },
            category: { type: "string", description: "Filter by category (e.g., 'build', 'runtime', 'api')" },
            temporal_decay: { type: "boolean", description: "Weight results by recency (default true for errors)" },
          },
          required: ["project", "error"],
        },
      },
      {
        name: "set_context",
        description: "Store a key-value pair for a project (e.g., SDK version, URLs)",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
            key: { type: "string", description: "Context key (e.g., 'sdk_version', 'api_url')" },
            value: { type: "string", description: "Context value" },
          },
          required: ["project", "key", "value"],
        },
      },
      {
        name: "get_context",
        description: "Get stored context for a project",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
            key: { type: "string", description: "Optional specific key to retrieve" },
          },
          required: ["project"],
        },
      },
      {
        name: "remember_learning",
        description: "Store a general learning or insight",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name (optional, null for global)" },
            category: { type: "string", description: "Category (e.g., 'pattern', 'gotcha', 'best-practice')" },
            content: { type: "string", description: "The learning content" },
          },
          required: ["category", "content"],
        },
      },
      {
        name: "recall_learnings",
        description: "Retrieve past learnings. Results are weighted by recency (temporal decay) by default.",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name (also includes global learnings)" },
            search: { type: "string", description: "Optional search term" },
            limit: { type: "number", description: "Max results (default 20)" },
            temporal_decay: { type: "boolean", description: "Weight results by recency (default true for learnings)" },
          },
          required: ["project"],
        },
      },
      {
        name: "delete_context",
        description: "Remove a context key from a project",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
            key: { type: "string", description: "Context key to delete" },
          },
          required: ["project", "key"],
        },
      },
      {
        name: "list_errors",
        description: "List all stored errors for a project",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
            limit: { type: "number", description: "Max results (default 10)" },
          },
          required: ["project"],
        },
      },
      {
        name: "search_all",
        description: "Search across all memory types (decisions, errors, learnings, context). Results are weighted by recency (temporal decay) by default.",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
            query: { type: "string", description: "Search term" },
            temporal_decay: { type: "boolean", description: "Weight results by recency (default true)" },
          },
          required: ["project", "query"],
        },
      },
      {
        name: "save_session",
        description: "Save current work session state (call before ending session)",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
            workspace: { type: "string", description: "Workspace name (e.g., 'claude-3', 'claude-5') - use to avoid conflicts between Claude instances" },
            task: { type: "string", description: "What you're working on (e.g., 'Issue #22 - Firestore migration')" },
            status: { type: "string", description: "Current status (e.g., 'in-progress', 'blocked', 'ready-for-review')" },
            notes: { type: "string", description: "Next steps or important context for resuming" },
          },
          required: ["project", "task"],
        },
      },
      {
        name: "get_session",
        description: "Get last saved session state (call at session start to resume work)",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
            workspace: { type: "string", description: "Workspace name (e.g., 'claude-3', 'claude-5') - if not provided, returns all sessions for project" },
          },
          required: ["project"],
        },
      },
      {
        name: "clear_session",
        description: "Clear session state when work is complete",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
            workspace: { type: "string", description: "Workspace name (e.g., 'claude-3', 'claude-5') - if not provided, clears all sessions for project" },
          },
          required: ["project"],
        },
      },
      {
        name: "memory_status",
        description: "Get a summary of all memory for a project - call this at session start to quickly recall context",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
          },
          required: ["project"],
        },
      },
      {
        name: "load_comprehensive_memory",
        description: "Load comprehensive memory for a project with higher limits - use this for thorough session starts. Returns 30 decisions, 50 learnings, 15 errors, all context, and all sessions. Results are sorted by temporal decay (recent items ranked higher).",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
            include_global: { type: "boolean", description: "Also load global context (default: true)" },
            temporal_decay: { type: "boolean", description: "Weight results by recency (default true)" },
          },
          required: ["project"],
        },
      },
      {
        name: "archive",
        description: "Archive old decisions, errors, or learnings by ID (they won't appear in queries but aren't deleted)",
        inputSchema: {
          type: "object",
          properties: {
            type: { type: "string", description: "Type to archive: 'decision', 'error', or 'learning'" },
            id: { type: "number", description: "ID of the item to archive" },
          },
          required: ["type", "id"],
        },
      },
      {
        name: "set_priority",
        description: "Set priority level for a decision, error, or learning. Higher priority items are loaded first in queries.",
        inputSchema: {
          type: "object",
          properties: {
            type: { type: "string", description: "Type: 'decision', 'error', or 'learning'" },
            id: { type: "number", description: "ID of the item" },
            priority: { type: "number", description: "Priority level: 0 = normal (default), 1 = high, 2 = critical" },
          },
          required: ["type", "id", "priority"],
        },
      },
      {
        name: "prune",
        description: "Permanently delete archived items older than specified days",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name (or 'all' for all projects)" },
            days: { type: "number", description: "Delete archived items older than this many days (default: 90)" },
          },
          required: ["project"],
        },
      },
      {
        name: "export_memory",
        description: "Export all memory for a project to JSON format",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name" },
            include_archived: { type: "boolean", description: "Include archived items (default: false)" },
          },
          required: ["project"],
        },
      },
      {
        name: "import_memory",
        description: "Import memory from JSON format (merges with existing data)",
        inputSchema: {
          type: "object",
          properties: {
            json_data: { type: "string", description: "JSON string containing memory data to import" },
          },
          required: ["json_data"],
        },
      },
      {
        name: "memory_stats",
        description: "Get detailed memory usage statistics including counts per project and database size",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Optional: filter stats to a specific project" },
          },
          required: [],
        },
      },
      {
        name: "bulk_cleanup",
        description: "Bulk delete old or archived items from memory",
        inputSchema: {
          type: "object",
          properties: {
            project: { type: "string", description: "Project name (or 'all' for all projects)" },
            type: { type: "string", description: "Type to clean: 'decisions', 'errors', 'learnings', or 'all'" },
            older_than_days: { type: "number", description: "Delete items older than this many days" },
            archived_only: { type: "boolean", description: "Only delete archived items (default: true)" },
          },
          required: ["project", "older_than_days"],
        },
      },
      ...syncTools,
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "remember_decision": {
        const date = args.date || new Date().toISOString().split("T")[0];
        const id = await db.insertDecision(args.project, date, args.decision, args.rationale || null, args.category || null);

        if (firestoreSync) {
          await firestoreSync.syncToCloud("decisions", {
            id, project: args.project, date,
            decision: args.decision, rationale: args.rationale, category: args.category,
          });
        }

        const categoryText = args.category ? ` [${args.category}]` : '';
        return { content: [{ type: "text", text: `Decision stored for ${args.project}${categoryText}${firestoreSync ? ' (synced)' : ''}` }] };
      }

      case "recall_decisions": {
        let results;
        if (args.category) {
          results = await db.getDecisionsByCategory(args.project, args.category, args.limit || 10);
        } else if (args.search) {
          results = await db.searchDecisions(args.project, `%${args.search}%`);
        } else {
          results = await db.getDecisions(args.project, args.limit || 10);
        }
        for (const r of results) await db.trackDecisionAccess(r.id);
        if (args.temporal_decay) {
          results = applyTemporalDecay(results, 'decisions', 'date');
        }
        return {
          content: [{
            type: "text",
            text: results.length > 0
              ? results.map(r => {
                  const categoryTag = r.category ? ` [${r.category}]` : '';
                  const age = r._age ? ` (${r._age})` : '';
                  return `[${r.date}]${categoryTag}${age} ${r.decision}\n  Rationale: ${r.rationale || 'N/A'}`;
                }).join("\n\n")
              : "No decisions found for this project"
          }]
        };
      }

      case "list_decisions": {
        const results = await db.getDecisions(args.project, args.limit || 10);
        return {
          content: [{
            type: "text",
            text: results.length > 0
              ? results.map(r => {
                  const categoryTag = r.category ? ` [${r.category}]` : '';
                  return `[ID:${r.id}] [${r.date}]${categoryTag} ${r.decision}\n  Rationale: ${r.rationale || 'N/A'}`;
                }).join("\n\n")
              : "No decisions found for this project"
          }]
        };
      }

      case "remember_error": {
        const id = await db.insertError(args.project, args.error_pattern, args.solution, args.context || null, args.category || null);

        if (firestoreSync) {
          await firestoreSync.syncToCloud("errors", {
            id, project: args.project,
            error_pattern: args.error_pattern, solution: args.solution,
            context: args.context, category: args.category,
          });
        }

        const categoryText = args.category ? ` [${args.category}]` : '';
        return { content: [{ type: "text", text: `Error solution stored for ${args.project}${categoryText}${firestoreSync ? ' (synced)' : ''}` }] };
      }

      case "find_solution": {
        const pattern = `%${args.error}%`;
        let results;
        if (args.category) {
          results = await db.findSolutionByCategory(args.project, args.category, pattern);
        } else {
          results = await db.findSolution(args.project, pattern);
        }
        for (const r of results) await db.trackErrorAccess(r.id);
        if (args.temporal_decay !== false) {
          results = applyTemporalDecay(results, 'errors');
        }
        return {
          content: [{
            type: "text",
            text: results.length > 0
              ? results.map(r => {
                  const categoryTag = r.category ? ` [${r.category}]` : '';
                  const age = r._age ? ` (${r._age})` : '';
                  return `Error:${categoryTag}${age} ${r.error_pattern}\nSolution: ${r.solution}\nContext: ${r.context || 'N/A'}`;
                }).join("\n\n---\n\n")
              : "No matching solutions found"
          }]
        };
      }

      case "set_context": {
        await db.upsertContext(args.project, args.key, args.value);

        if (firestoreSync) {
          await firestoreSync.syncToCloud("context", {
            id: `${args.project}_${args.key}`,
            project: args.project, key: args.key, value: args.value,
          });
        }

        return { content: [{ type: "text", text: `Context ${args.key} set for ${args.project}${firestoreSync ? ' (synced)' : ''}` }] };
      }

      case "get_context": {
        if (args.key) {
          const result = await db.getContextValue(args.project, args.key);
          return {
            content: [{
              type: "text",
              text: result ? `${args.key}: ${result.value}` : `No value found for ${args.key}`
            }]
          };
        } else {
          const results = await db.getContext(args.project);
          return {
            content: [{
              type: "text",
              text: results.length > 0
                ? results.map(r => `${r.key}: ${r.value}`).join("\n")
                : "No context stored for this project"
            }]
          };
        }
      }

      case "remember_learning": {
        const id = await db.insertLearning(args.project || null, args.category, args.content);

        if (firestoreSync) {
          await firestoreSync.syncToCloud("learnings", {
            id, project: args.project, category: args.category, content: args.content,
          });
        }

        return { content: [{ type: "text", text: `Learning stored (${args.category})${firestoreSync ? ' (synced)' : ''}` }] };
      }

      case "recall_learnings": {
        let results;
        if (args.search) {
          results = await db.searchLearnings(args.project, `%${args.search}%`);
        } else {
          results = await db.getLearnings(args.project, args.limit || 20);
        }
        for (const r of results) await db.trackLearningAccess(r.id);
        if (args.temporal_decay !== false) {
          results = applyTemporalDecay(results, 'learnings');
        }
        return {
          content: [{
            type: "text",
            text: results.length > 0
              ? results.map(r => {
                  const age = r._age ? ` (${r._age})` : '';
                  return `[${r.category}]${age} ${r.content}${r.project ? '' : ' (global)'}`;
                }).join("\n\n")
              : "No learnings found"
          }]
        };
      }

      case "delete_context": {
        const changes = await db.deleteContext(args.project, args.key);
        return {
          content: [{
            type: "text",
            text: changes > 0
              ? `Deleted context key '${args.key}' from ${args.project}`
              : `No context key '${args.key}' found for ${args.project}`
          }]
        };
      }

      case "list_errors": {
        const results = await db.getRecentErrors(args.project, args.limit || 10);
        return {
          content: [{
            type: "text",
            text: results.length > 0
              ? results.map(r => {
                  const categoryTag = r.category ? ` [${r.category}]` : '';
                  return `[ID:${r.id}]${categoryTag} ${r.error_pattern}\n  Solution: ${r.solution}\n  Context: ${r.context || 'N/A'}`;
                }).join("\n\n")
              : "No errors stored for this project"
          }]
        };
      }

      case "search_all": {
        const pattern = `%${args.query}%`;
        let decisions = await db.searchDecisions(args.project, pattern);
        let errors = await db.findSolution(args.project, pattern);
        let learnings = await db.searchLearnings(args.project, pattern);
        const contexts = await db.searchContext(args.project, pattern);

        if (args.temporal_decay !== false) {
          decisions = applyTemporalDecay(decisions, 'decisions', 'date');
          errors = applyTemporalDecay(errors, 'errors');
          learnings = applyTemporalDecay(learnings, 'learnings');
        }

        let output = [];
        if (decisions.length > 0) {
          output.push("=== DECISIONS ===\n" + decisions.map(r => {
            const age = r._age ? ` (${r._age})` : '';
            return `[${r.date}]${age} ${r.decision}`;
          }).join("\n"));
        }
        if (errors.length > 0) {
          output.push("=== ERRORS ===\n" + errors.map(r => {
            const age = r._age ? ` (${r._age})` : '';
            return `${age ? age + ' ' : ''}${r.error_pattern}: ${r.solution}`;
          }).join("\n"));
        }
        if (learnings.length > 0) {
          output.push("=== LEARNINGS ===\n" + learnings.map(r => {
            const age = r._age ? ` (${r._age})` : '';
            return `[${r.category}]${age} ${r.content}`;
          }).join("\n"));
        }
        if (contexts.length > 0) {
          output.push("=== CONTEXT ===\n" + contexts.map(r => `${r.key}: ${r.value}`).join("\n"));
        }

        return {
          content: [{
            type: "text",
            text: output.length > 0 ? output.join("\n\n") : `No results found for '${args.query}'`
          }]
        };
      }

      case "save_session": {
        const workspace = args.workspace || null;
        await db.upsertSession(args.project, workspace, args.task, args.status || 'in-progress', args.notes || null);

        if (firestoreSync) {
          await firestoreSync.syncToCloud("sessions", {
            id: workspace ? `${args.project}:${workspace}` : args.project,
            project: args.project, workspace, task: args.task,
            status: args.status, notes: args.notes,
          });
        }

        const workspaceInfo = workspace ? ` (workspace: ${workspace})` : '';
        return { content: [{ type: "text", text: `Session saved for ${args.project}${workspaceInfo}: ${args.task}${firestoreSync ? ' (synced)' : ''}` }] };
      }

      case "get_session": {
        const workspace = args.workspace;
        if (workspace !== undefined) {
          const session = await db.getSession(args.project, workspace);
          if (session) {
            const timeAgo = getTimeAgo(session.updated_at);
            const workspaceInfo = session.workspace ? ` [${session.workspace}]` : '';
            return {
              content: [{
                type: "text",
                text: `Last session${workspaceInfo} (${timeAgo}):\nTask: ${session.task}\nStatus: ${session.status || 'in-progress'}\nNotes: ${session.notes || 'None'}`
              }]
            };
          }
          return { content: [{ type: "text", text: "No saved session found" }] };
        } else {
          const sessions = await db.getAllSessions(args.project);
          if (sessions.length > 0) {
            const output = sessions.map(session => {
              const timeAgo = getTimeAgo(session.updated_at);
              const workspaceInfo = session.workspace ? `[${session.workspace}] ` : '[default] ';
              return `${workspaceInfo}(${timeAgo}):\n  Task: ${session.task}\n  Status: ${session.status || 'in-progress'}\n  Notes: ${session.notes || 'None'}`;
            }).join('\n\n');
            return { content: [{ type: "text", text: output }] };
          }
          return { content: [{ type: "text", text: "No saved session found" }] };
        }
      }

      case "clear_session": {
        const workspace = args.workspace;
        if (workspace !== undefined) {
          const changes = await db.deleteSession(args.project, workspace);
          const workspaceInfo = workspace ? ` (workspace: ${workspace})` : '';
          return {
            content: [{
              type: "text",
              text: changes > 0 ? `Session cleared for ${args.project}${workspaceInfo}` : "No session to clear"
            }]
          };
        } else {
          const changes = await db.deleteAllSessions(args.project);
          return {
            content: [{
              type: "text",
              text: changes > 0 ? `All sessions cleared for ${args.project} (${changes} session(s))` : "No sessions to clear"
            }]
          };
        }
      }

      case "memory_status": {
        const sessions = await db.getAllSessions(args.project);
        const contextItems = await db.getContext(args.project);
        const decisions = await db.getDecisions(args.project, 5);
        const learnings = await db.getLearnings(args.project, 5);
        const errors = await db.getRecentErrors(args.project, 3);
        const globalLearnings = await db.getGlobalLearnings(5);

        let output = [`# Memory Status for ${args.project}\n`];

        if (sessions.length > 0) {
          output.push(`## Active Sessions (${sessions.length})`);
          for (const session of sessions) {
            const timeAgo = getTimeAgo(session.updated_at);
            const workspaceLabel = session.workspace ? `[${session.workspace}]` : '[default]';
            output.push(`### ${workspaceLabel} (${timeAgo})`);
            output.push(`**Task:** ${session.task}`);
            output.push(`**Status:** ${session.status || 'in-progress'}`);
            if (session.notes) output.push(`**Notes:** ${session.notes}`);
            output.push('');
          }
        }

        if (contextItems.length > 0) {
          output.push(`## Context (${contextItems.length} items)`);
          contextItems.forEach(c => output.push(`- **${c.key}:** ${c.value}`));
          output.push('');
        }

        if (decisions.length > 0) {
          output.push(`## Recent Decisions`);
          decisions.forEach(d => output.push(`- [${d.date}] ${d.decision}`));
          output.push('');
        }

        const allLearnings = [...learnings, ...globalLearnings.filter(g => !learnings.find(l => l.id === g.id))];
        if (allLearnings.length > 0) {
          output.push(`## Learnings`);
          allLearnings.slice(0, 5).forEach(l => output.push(`- [${l.category}] ${l.content}${l.project ? '' : ' (global)'}`));
          output.push('');
        }

        if (errors.length > 0) {
          output.push(`## Recent Error Solutions`);
          errors.forEach(e => output.push(`- **${e.error_pattern}**: ${e.solution}`));
          output.push('');
        }

        const stats = {
          decisions: await db.countTable("decisions", args.project),
          errors: await db.countTable("errors", args.project),
          learnings: await db.countTable("learnings", args.project),
          context: contextItems.length,
        };
        output.push(`## Stats`);
        output.push(`Decisions: ${stats.decisions} | Errors: ${stats.errors} | Learnings: ${stats.learnings} | Context: ${stats.context}`);
        output.push(`\nBackend: ${db.type}`);

        return { content: [{ type: "text", text: output.join('\n') }] };
      }

      case "load_comprehensive_memory": {
        const includeGlobal = args.include_global !== false;
        const useDecay = args.temporal_decay !== false;

        const DECISION_LIMIT = 30;
        const LEARNING_LIMIT = 50;
        const ERROR_LIMIT = 15;

        const sessions = await db.getAllSessions(args.project);
        const contextItems = await db.getContext(args.project);
        let decisions = await db.getDecisions(args.project, DECISION_LIMIT);
        let learnings = await db.getLearnings(args.project, LEARNING_LIMIT);
        let errors = await db.getRecentErrors(args.project, ERROR_LIMIT);

        if (useDecay) {
          decisions = applyTemporalDecay(decisions, 'decisions', 'date');
          learnings = applyTemporalDecay(learnings, 'learnings');
          errors = applyTemporalDecay(errors, 'errors');
        }

        let globalContext = [];
        let globalLearnings = [];
        if (includeGlobal) {
          globalContext = await db.getContext('global');
          globalLearnings = await db.getGlobalLearnings(20);
        }

        let output = [`# Comprehensive Memory for ${args.project}\n`];
        output.push(`_Loaded with higher limits: ${DECISION_LIMIT} decisions, ${LEARNING_LIMIT} learnings, ${ERROR_LIMIT} errors | Backend: ${db.type}_\n`);

        if (includeGlobal && globalContext.length > 0) {
          output.push(`## Global Context`);
          globalContext.forEach(c => output.push(`- **${c.key}:** ${c.value}`));
          output.push('');
        }

        if (sessions.length > 0) {
          output.push(`## Active Sessions (${sessions.length})`);
          for (const session of sessions) {
            const timeAgo = getTimeAgo(session.updated_at);
            const workspaceLabel = session.workspace ? `[${session.workspace}]` : '[default]';
            output.push(`### ${workspaceLabel} (${timeAgo})`);
            output.push(`**Task:** ${session.task}`);
            output.push(`**Status:** ${session.status || 'in-progress'}`);
            if (session.notes) output.push(`**Notes:** ${session.notes}`);
            output.push('');
          }
        }

        if (contextItems.length > 0) {
          output.push(`## Project Context (${contextItems.length} items)`);
          contextItems.forEach(c => output.push(`- **${c.key}:** ${c.value}`));
          output.push('');
        }

        const priorityIcon = (p) => p === 2 ? '!! ' : p === 1 ? '! ' : '';
        const getTier = (item) => {
          const accessCount = item.access_count || 0;
          const lastAccessed = item.last_accessed ? new Date(item.last_accessed) : null;
          const now = new Date();
          const daysSinceAccess = lastAccessed ? (now - lastAccessed) / (1000 * 60 * 60 * 24) : Infinity;
          if (accessCount >= 5 || daysSinceAccess <= 7) return 'hot';
          if (accessCount >= 2 || daysSinceAccess <= 30) return 'warm';
          return 'cold';
        };
        const tierIcon = (tier) => tier === 'hot' ? '[HOT] ' : tier === 'warm' ? '[WARM] ' : '';

        if (decisions.length > 0) {
          const highPriorityCount = decisions.filter(d => (d.priority || 0) > 0).length;
          const hotCount = decisions.filter(d => getTier(d) === 'hot').length;
          output.push(`## Decisions (${decisions.length}${highPriorityCount ? `, ${highPriorityCount} priority` : ''}${hotCount ? `, ${hotCount} hot` : ''})`);
          decisions.forEach(d => {
            const categoryTag = d.category ? `[${d.category}] ` : '';
            const tier = tierIcon(getTier(d));
            const age = d._age ? ` _(${d._age})_` : '';
            output.push(`- ${priorityIcon(d.priority)}${tier}**[${d.date}]** ${categoryTag}${d.decision}${age}`);
            if (d.rationale) output.push(`  _Rationale: ${d.rationale}_`);
          });
          output.push('');
        }

        let allLearnings = [...learnings];
        if (includeGlobal) {
          let globalLearningsToAdd = globalLearnings.filter(g => !allLearnings.find(l => l.id === g.id));
          if (useDecay) {
            globalLearningsToAdd = applyTemporalDecay(globalLearningsToAdd, 'learnings');
          }
          allLearnings.push(...globalLearningsToAdd);
        }
        if (useDecay && allLearnings.length > 0) {
          allLearnings = applyTemporalDecay(allLearnings, 'learnings');
        }
        if (allLearnings.length > 0) {
          const highPriorityCount = allLearnings.filter(l => (l.priority || 0) > 0).length;
          const hotCount = allLearnings.filter(l => getTier(l) === 'hot').length;
          output.push(`## Learnings (${allLearnings.length}${highPriorityCount ? `, ${highPriorityCount} priority` : ''}${hotCount ? `, ${hotCount} hot` : ''})`);
          allLearnings.forEach(l => {
            const tier = tierIcon(getTier(l));
            const age = l._age ? ` _(${l._age})_` : '';
            output.push(`- ${priorityIcon(l.priority)}${tier}[${l.category}] ${l.content}${l.project ? '' : ' _(global)_'}${age}`);
          });
          output.push('');
        }

        if (errors.length > 0) {
          const highPriorityCount = errors.filter(e => (e.priority || 0) > 0).length;
          const hotCount = errors.filter(e => getTier(e) === 'hot').length;
          output.push(`## Error Solutions (${errors.length}${highPriorityCount ? `, ${highPriorityCount} priority` : ''}${hotCount ? `, ${hotCount} hot` : ''})`);
          errors.forEach(e => {
            const categoryTag = e.category ? `[${e.category}] ` : '';
            const tier = tierIcon(getTier(e));
            const age = e._age ? ` _(${e._age})_` : '';
            output.push(`- ${priorityIcon(e.priority)}${tier}${categoryTag}**${e.error_pattern}**${age}`);
            output.push(`  Solution: ${e.solution}`);
            if (e.context) output.push(`  Context: ${e.context}`);
          });
          output.push('');
        }

        const stats = {
          decisions: await db.countTable("decisions", args.project),
          errors: await db.countTable("errors", args.project),
          learnings: await db.countTable("learnings", args.project),
          context: contextItems.length,
        };
        output.push(`## Total Available`);
        output.push(`Decisions: ${stats.decisions} (loaded: ${decisions.length}) | Errors: ${stats.errors} (loaded: ${errors.length}) | Learnings: ${stats.learnings} (loaded: ${allLearnings.length}) | Context: ${stats.context}`);

        return { content: [{ type: "text", text: output.join('\n') }] };
      }

      case "archive": {
        const tableMap = { 'decision': 'decisions', 'error': 'errors', 'learning': 'learnings' };
        const table = tableMap[args.type];
        if (!table) {
          return { content: [{ type: "text", text: `Invalid type: ${args.type}. Use 'decision', 'error', or 'learning'` }] };
        }

        const changes = await db.archive(table, args.id);
        return {
          content: [{
            type: "text",
            text: changes > 0 ? `Archived ${args.type} #${args.id}` : `No ${args.type} found with ID ${args.id}`
          }]
        };
      }

      case "set_priority": {
        const tableMap = { 'decision': 'decisions', 'error': 'errors', 'learning': 'learnings' };
        const table = tableMap[args.type];
        if (!table) {
          return { content: [{ type: "text", text: `Invalid type: ${args.type}. Use 'decision', 'error', or 'learning'` }] };
        }

        const priority = args.priority;
        if (priority < 0 || priority > 2) {
          return { content: [{ type: "text", text: `Invalid priority: ${priority}. Use 0 (normal), 1 (high), or 2 (critical)` }] };
        }

        const priorityLabels = ['normal', 'high', 'critical'];
        const changes = await db.setPriority(table, args.id, priority);
        return {
          content: [{
            type: "text",
            text: changes > 0
              ? `Set ${args.type} #${args.id} priority to ${priorityLabels[priority]} (${priority})`
              : `No ${args.type} found with ID ${args.id}`
          }]
        };
      }

      case "prune": {
        const days = args.days || 90;
        const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const totalDeleted = await db.prune(args.project, cutoffDate, ['decisions', 'errors', 'learnings']);
        return { content: [{ type: "text", text: `Pruned ${totalDeleted} archived items older than ${days} days` }] };
      }

      case "export_memory": {
        const includeArchived = args.include_archived || false;
        const data = await db.exportProject(args.project, includeArchived);
        data.project = args.project;
        data.exported_at = new Date().toISOString();

        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
      }

      case "import_memory": {
        try {
          const data = JSON.parse(args.json_data);
          let imported = { decisions: 0, errors: 0, context: 0, learnings: 0 };

          if (data.decisions) {
            for (const d of data.decisions) {
              try {
                await db.insertDecision(d.project, d.date, d.decision, d.rationale, d.category || null);
                imported.decisions++;
              } catch { /* skip duplicates */ }
            }
          }

          if (data.errors) {
            for (const e of data.errors) {
              try {
                await db.insertError(e.project, e.error_pattern, e.solution, e.context, e.category || null);
                imported.errors++;
              } catch { /* skip duplicates */ }
            }
          }

          if (data.context) {
            for (const c of data.context) {
              await db.upsertContext(c.project, c.key, c.value);
              imported.context++;
            }
          }

          if (data.learnings) {
            for (const l of data.learnings) {
              try {
                await db.insertLearning(l.project, l.category, l.content);
                imported.learnings++;
              } catch { /* skip duplicates */ }
            }
          }

          if (data.session) {
            await db.upsertSession(data.session.project, data.session.workspace || null, data.session.task, data.session.status, data.session.notes);
          }

          return {
            content: [{
              type: "text",
              text: `Imported: ${imported.decisions} decisions, ${imported.errors} errors, ${imported.context} context items, ${imported.learnings} learnings`
            }]
          };
        } catch (e) {
          return { content: [{ type: "text", text: `Import failed: ${e.message}` }] };
        }
      }

      case "memory_stats": {
        let output = [`# Memory Statistics\n`, `Backend: ${db.type}\n`];

        if (db.type === "sqlite") {
          try {
            const { statSync } = await import("fs");
            const stats = statSync(db.dbPath);
            const sizeKB = (stats.size / 1024).toFixed(2);
            const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
            output.push(`Database size: ${stats.size > 1024 * 1024 ? `${sizeMB} MB` : `${sizeKB} KB`}\n`);
          } catch { /* ignore */ }
        }

        if (args.project) {
          const stats = await db.getDetailedStats(args.project);
          if (stats) {
            output.push(`## Project: ${args.project}`);
            output.push(`- Decisions: ${stats.decisions.total} (${stats.decisions.archived || 0} archived)`);
            output.push(`- Errors: ${stats.errors.total} (${stats.errors.archived || 0} archived)`);
            output.push(`- Learnings: ${stats.learnings.total} (${stats.learnings.archived || 0} archived)`);
            output.push(`- Context keys: ${stats.context.total}`);
          }
        } else {
          const projects = await db.getAllProjects();

          output.push(`## All Projects (${projects.length} total)\n`);

          for (const { project } of projects) {
            const s = await db.getProjectStats(project);
            output.push(`**${project}**: ${s.decisions} decisions, ${s.errors} errors, ${s.learnings} learnings, ${s.context} context`);
          }

          const globalLearnings = await db.getGlobalLearningsCount();
          output.push(`\n**Global learnings**: ${globalLearnings}`);

          const totals = {
            decisions: await db.countTable("decisions", null, true),
            errors: await db.countTable("errors", null, true),
            learnings: await db.countTable("learnings", null, true),
            context: await db.countTable("context", null, true),
            archived: await db.getTotalArchived(),
          };
          output.push(`\n## Totals`);
          output.push(`- Total decisions: ${totals.decisions}`);
          output.push(`- Total errors: ${totals.errors}`);
          output.push(`- Total learnings: ${totals.learnings}`);
          output.push(`- Total context keys: ${totals.context}`);
          output.push(`- Total archived items: ${totals.archived}`);
        }

        return { content: [{ type: "text", text: output.join('\n') }] };
      }

      case "bulk_cleanup": {
        const days = args.older_than_days;
        const archivedOnly = args.archived_only !== false;
        const typeFilter = args.type || 'all';
        const cutoffDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

        const tables = typeFilter === 'all'
          ? ['decisions', 'errors', 'learnings']
          : [typeFilter].filter(t => ['decisions', 'errors', 'learnings'].includes(t));

        const { total, perTable } = await db.bulkCleanup(args.project, cutoffDate, tables, archivedOnly);

        const details = Object.entries(perTable)
          .map(([table, count]) => `${table}: ${count}`)
          .join(', ');

        return {
          content: [{
            type: "text",
            text: `Deleted ${total} items older than ${days} days${archivedOnly ? ' (archived only)' : ''}\n${details}`
          }]
        };
      }

      // Cloud sync tools
      case "sync_to_cloud": {
        if (!firestoreSync) {
          return { content: [{ type: "text", text: "Firestore sync not enabled. Configure in ~/.claude/memory-config.json" }] };
        }
        // Firestore sync only works well with SQLite export
        const tables = ["decisions", "errors", "context", "learnings"];
        let synced = 0;
        for (const table of tables) {
          const data = await db.exportProject(args.project === "all" ? "%" : args.project, true);
          const rows = data[table] || [];
          for (const row of rows) {
            await firestoreSync.syncToCloud(table, row);
            synced++;
          }
        }
        return { content: [{ type: "text", text: `Synced ${synced} records to Firestore` }] };
      }

      case "pull_from_cloud": {
        if (!firestoreSync) {
          return { content: [{ type: "text", text: "Firestore sync not enabled. Configure in ~/.claude/memory-config.json" }] };
        }

        const tables = ["decisions", "errors", "context", "learnings"];
        let pulled = 0;

        for (const table of tables) {
          const cloudRecords = await firestoreSync.pullFromCloud(table, args.project);
          for (const record of cloudRecords) {
            try {
              if (table === "decisions") {
                await db.insertDecision(record.project, record.date, record.decision, record.rationale, record.category || null);
              } else if (table === "errors") {
                await db.insertError(record.project, record.error_pattern, record.solution, record.context, record.category || null);
              } else if (table === "context") {
                await db.upsertContext(record.project, record.key, record.value);
              } else if (table === "learnings") {
                await db.insertLearning(record.project, record.category, record.content);
              }
              pulled++;
            } catch { /* skip duplicates */ }
          }
        }

        return { content: [{ type: "text", text: `Pulled ${pulled} records from Firestore` }] };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }] };
    }
  } catch (error) {
    return { content: [{ type: "text", text: `Error: ${error.message}` }] };
  }
});

// Start server
async function main() {
  firestoreSync = await initFirestoreSync();
  db = await createDatabase(config);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Claude Memory MCP server running (v3.0.0) [${db.type}]${firestoreSync ? ' [Firestore enabled]' : ''}`);
}

main().catch(console.error);
