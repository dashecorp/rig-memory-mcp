# Copilot Code Review Instructions - claude-memory-mcp

## Project Overview

MCP server providing persistent memory storage for Claude Code sessions. Stores decisions, errors, learnings, context, and sessions in SQLite with optional Firestore cloud sync.

## Architecture

- **Pattern:** MCP SDK handler pattern (stdio transport)
- **Runtime:** Node.js (ES modules)
- **Storage:** SQLite via `better-sqlite3`
- **Cloud sync:** Optional Firestore (`@google-cloud/firestore`)
- **Entry point:** `index.js` (single-file server)
- **Database:** `~/.claude/memory.db`

## Security Focus

- Database path must not be user-controllable (hardcoded to `~/.claude/memory.db`)
- SQL queries must use parameterized statements (never string concatenation)
- Firestore credentials loaded from config file, never from env vars in code
- Memory export/import must validate JSON structure before processing
- Never log memory content (may contain secrets or credentials)

## Code Patterns

### Database
- Use `better-sqlite3` synchronous API (not async)
- All tables created in `initDatabase()` with `IF NOT EXISTS`
- Use `db.prepare().run()` for writes, `.get()` / `.all()` for reads
- Timestamps stored as ISO 8601 strings

### MCP Handlers
- 30+ tools organized by category: decisions, errors, context, learnings, sessions, maintenance
- Each tool has `inputSchema` with JSON Schema validation
- Return `{ content: [{ type: "text", text: ... }] }` format
- Handle errors with `isError: true` in response

### Cloud Sync
- Firestore sync is optional - server works without it
- Config loaded from `~/.claude/memory-config.json`
- Sync operations are idempotent (upsert pattern)

## Common Pitfalls

- `better-sqlite3` is synchronous - no async/await needed for DB operations
- Database file must exist before attaching (context-layer-mcp depends on this)
- `search_all` searches across all tables - ensure indexes exist for searched columns
- `prune` and `archive` modify data permanently - these are destructive operations
- Session data includes `workspace` parameter to avoid conflicts between Claude instances
