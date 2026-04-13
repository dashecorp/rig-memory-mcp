/**
 * Database abstraction layer for claude-memory-mcp.
 *
 * Supports two backends:
 * - SQLite (default, local dev) via better-sqlite3
 * - PostgreSQL (k8s agents, shared memory) via pg
 *
 * Selection order:
 * 1. DATABASE_URL env var → Postgres
 * 2. memory-config.json postgres.connectionString → Postgres
 * 3. Fallback → SQLite at ~/.claude/memory.db
 */

import Database from "better-sqlite3";
import { homedir } from "os";
import { join } from "path";

// ---------- Schema ----------

const SQLITE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    date TEXT NOT NULL,
    decision TEXT NOT NULL,
    rationale TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    synced_at TEXT,
    archived INTEGER DEFAULT 0,
    priority INTEGER DEFAULT 0,
    category TEXT,
    access_count INTEGER DEFAULT 0,
    last_accessed TEXT
  );
  CREATE TABLE IF NOT EXISTS errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    error_pattern TEXT NOT NULL,
    solution TEXT NOT NULL,
    context TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    synced_at TEXT,
    archived INTEGER DEFAULT 0,
    priority INTEGER DEFAULT 0,
    category TEXT,
    access_count INTEGER DEFAULT 0,
    last_accessed TEXT
  );
  CREATE TABLE IF NOT EXISTS context (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    synced_at TEXT,
    UNIQUE(project, key)
  );
  CREATE TABLE IF NOT EXISTS learnings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT,
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    synced_at TEXT,
    archived INTEGER DEFAULT 0,
    priority INTEGER DEFAULT 0,
    access_count INTEGER DEFAULT 0,
    last_accessed TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    workspace TEXT,
    task TEXT NOT NULL,
    status TEXT,
    notes TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    synced_at TEXT,
    UNIQUE(project, workspace)
  );
  CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project);
  CREATE INDEX IF NOT EXISTS idx_errors_project ON errors(project);
  CREATE INDEX IF NOT EXISTS idx_context_project ON context(project);
  CREATE INDEX IF NOT EXISTS idx_learnings_project ON learnings(project);
  CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
`;

const PG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS decisions (
    id SERIAL PRIMARY KEY,
    project TEXT NOT NULL,
    date TEXT NOT NULL,
    decision TEXT NOT NULL,
    rationale TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    synced_at TEXT,
    archived INTEGER DEFAULT 0,
    priority INTEGER DEFAULT 0,
    category TEXT,
    access_count INTEGER DEFAULT 0,
    last_accessed TIMESTAMPTZ
  );
  CREATE TABLE IF NOT EXISTS errors (
    id SERIAL PRIMARY KEY,
    project TEXT NOT NULL,
    error_pattern TEXT NOT NULL,
    solution TEXT NOT NULL,
    context TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    synced_at TEXT,
    archived INTEGER DEFAULT 0,
    priority INTEGER DEFAULT 0,
    category TEXT,
    access_count INTEGER DEFAULT 0,
    last_accessed TIMESTAMPTZ
  );
  CREATE TABLE IF NOT EXISTS context (
    id SERIAL PRIMARY KEY,
    project TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    synced_at TEXT,
    UNIQUE(project, key)
  );
  CREATE TABLE IF NOT EXISTS learnings (
    id SERIAL PRIMARY KEY,
    project TEXT,
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    synced_at TEXT,
    archived INTEGER DEFAULT 0,
    priority INTEGER DEFAULT 0,
    access_count INTEGER DEFAULT 0,
    last_accessed TIMESTAMPTZ
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id SERIAL PRIMARY KEY,
    project TEXT NOT NULL,
    workspace TEXT NOT NULL DEFAULT '',
    task TEXT NOT NULL,
    status TEXT,
    notes TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    synced_at TEXT,
    UNIQUE(project, workspace)
  );
  CREATE INDEX IF NOT EXISTS idx_decisions_project ON decisions(project);
  CREATE INDEX IF NOT EXISTS idx_errors_project ON errors(project);
  CREATE INDEX IF NOT EXISTS idx_context_project ON context(project);
  CREATE INDEX IF NOT EXISTS idx_learnings_project ON learnings(project);
  CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
`;

// ---------- SQLite Backend ----------

class SqliteBackend {
  constructor(dbPath) {
    this.db = new Database(dbPath);
    this.db.exec(SQLITE_SCHEMA);
    this.type = "sqlite";
    this._runMigrations();
  }

  _runMigrations() {
    // Migrations for existing databases that don't have newer columns
    const migrations = [
      "ALTER TABLE decisions ADD COLUMN archived INTEGER DEFAULT 0",
      "ALTER TABLE errors ADD COLUMN archived INTEGER DEFAULT 0",
      "ALTER TABLE learnings ADD COLUMN archived INTEGER DEFAULT 0",
      "ALTER TABLE decisions ADD COLUMN priority INTEGER DEFAULT 0",
      "ALTER TABLE errors ADD COLUMN priority INTEGER DEFAULT 0",
      "ALTER TABLE learnings ADD COLUMN priority INTEGER DEFAULT 0",
      "ALTER TABLE decisions ADD COLUMN category TEXT",
      "ALTER TABLE errors ADD COLUMN category TEXT",
      "ALTER TABLE decisions ADD COLUMN access_count INTEGER DEFAULT 0",
      "ALTER TABLE decisions ADD COLUMN last_accessed TEXT",
      "ALTER TABLE errors ADD COLUMN access_count INTEGER DEFAULT 0",
      "ALTER TABLE errors ADD COLUMN last_accessed TEXT",
      "ALTER TABLE learnings ADD COLUMN access_count INTEGER DEFAULT 0",
      "ALTER TABLE learnings ADD COLUMN last_accessed TEXT",
    ];
    for (const sql of migrations) {
      try { this.db.exec(sql); } catch { /* column already exists */ }
    }

    // Workspace migration for sessions
    try {
      const tableInfo = this.db.prepare("PRAGMA table_info(sessions)").all();
      if (!tableInfo.some(c => c.name === "workspace")) {
        this.db.exec(`
          CREATE TABLE sessions_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project TEXT NOT NULL, workspace TEXT, task TEXT NOT NULL,
            status TEXT, notes TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            synced_at TEXT, UNIQUE(project, workspace)
          );
          INSERT INTO sessions_new (id, project, task, status, notes, updated_at, synced_at)
            SELECT id, project, task, status, notes, updated_at, synced_at FROM sessions;
          DROP TABLE sessions;
          ALTER TABLE sessions_new RENAME TO sessions;
          CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
        `);
      }
    } catch { /* already migrated */ }
  }

  // -- Decisions --
  async insertDecision(project, date, decision, rationale, category) {
    const r = this.db.prepare(
      "INSERT INTO decisions (project, date, decision, rationale, category) VALUES (?, ?, ?, ?, ?)"
    ).run(project, date, decision, rationale, category);
    return r.lastInsertRowid;
  }

  async getDecisions(project, limit) {
    return this.db.prepare(
      "SELECT * FROM decisions WHERE project = ? AND (archived IS NULL OR archived = 0) ORDER BY priority DESC, date DESC LIMIT ?"
    ).all(project, limit);
  }

  async getDecisionsByCategory(project, category, limit) {
    return this.db.prepare(
      "SELECT * FROM decisions WHERE project = ? AND category = ? AND (archived IS NULL OR archived = 0) ORDER BY priority DESC, date DESC LIMIT ?"
    ).all(project, category, limit);
  }

  async searchDecisions(project, pattern) {
    return this.db.prepare(
      "SELECT * FROM decisions WHERE project = ? AND (archived IS NULL OR archived = 0) AND (decision LIKE ? OR rationale LIKE ?) ORDER BY priority DESC, date DESC"
    ).all(project, pattern, pattern);
  }

  async trackDecisionAccess(id) {
    this.db.prepare("UPDATE decisions SET access_count = COALESCE(access_count, 0) + 1, last_accessed = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  }

  // -- Errors --
  async insertError(project, errorPattern, solution, context, category) {
    const r = this.db.prepare(
      "INSERT INTO errors (project, error_pattern, solution, context, category) VALUES (?, ?, ?, ?, ?)"
    ).run(project, errorPattern, solution, context, category);
    return r.lastInsertRowid;
  }

  async findSolution(project, pattern) {
    return this.db.prepare(
      "SELECT * FROM errors WHERE project = ? AND (archived IS NULL OR archived = 0) AND error_pattern LIKE ? ORDER BY priority DESC, created_at DESC LIMIT 5"
    ).all(project, pattern);
  }

  async findSolutionByCategory(project, category, pattern) {
    return this.db.prepare(
      "SELECT * FROM errors WHERE project = ? AND category = ? AND (archived IS NULL OR archived = 0) AND error_pattern LIKE ? ORDER BY priority DESC, created_at DESC LIMIT 5"
    ).all(project, category, pattern);
  }

  async getRecentErrors(project, limit) {
    return this.db.prepare(
      "SELECT * FROM errors WHERE project = ? AND (archived IS NULL OR archived = 0) ORDER BY priority DESC, created_at DESC LIMIT ?"
    ).all(project, limit);
  }

  async trackErrorAccess(id) {
    this.db.prepare("UPDATE errors SET access_count = COALESCE(access_count, 0) + 1, last_accessed = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  }

  // -- Context --
  async upsertContext(project, key, value) {
    this.db.prepare(
      "INSERT INTO context (project, key, value, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(project, key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"
    ).run(project, key, value);
  }

  async getContext(project) {
    return this.db.prepare("SELECT key, value FROM context WHERE project = ?").all(project);
  }

  async getContextValue(project, key) {
    return this.db.prepare("SELECT value FROM context WHERE project = ? AND key = ?").get(project, key);
  }

  async deleteContext(project, key) {
    const r = this.db.prepare("DELETE FROM context WHERE project = ? AND key = ?").run(project, key);
    return r.changes;
  }

  // -- Learnings --
  async insertLearning(project, category, content) {
    const r = this.db.prepare(
      "INSERT INTO learnings (project, category, content) VALUES (?, ?, ?)"
    ).run(project, category, content);
    return r.lastInsertRowid;
  }

  async getLearnings(project, limit) {
    return this.db.prepare(
      "SELECT * FROM learnings WHERE (project = ? OR project IS NULL) AND (archived IS NULL OR archived = 0) ORDER BY priority DESC, created_at DESC LIMIT ?"
    ).all(project, limit);
  }

  async searchLearnings(project, pattern) {
    return this.db.prepare(
      "SELECT * FROM learnings WHERE (project = ? OR project IS NULL) AND (archived IS NULL OR archived = 0) AND content LIKE ? ORDER BY priority DESC, created_at DESC"
    ).all(project, pattern);
  }

  async getGlobalLearnings(limit) {
    return this.db.prepare(
      "SELECT * FROM learnings WHERE project IS NULL AND (archived IS NULL OR archived = 0) ORDER BY created_at DESC LIMIT ?"
    ).all(limit);
  }

  async trackLearningAccess(id) {
    this.db.prepare("UPDATE learnings SET access_count = COALESCE(access_count, 0) + 1, last_accessed = CURRENT_TIMESTAMP WHERE id = ?").run(id);
  }

  // -- Sessions --
  async upsertSession(project, workspace, task, status, notes) {
    this.db.prepare(
      "INSERT INTO sessions (project, workspace, task, status, notes, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(project, workspace) DO UPDATE SET task = excluded.task, status = excluded.status, notes = excluded.notes, updated_at = CURRENT_TIMESTAMP"
    ).run(project, workspace, task, status, notes);
  }

  async getSession(project, workspace) {
    return this.db.prepare(
      "SELECT * FROM sessions WHERE project = ? AND (workspace = ? OR (workspace IS NULL AND ? IS NULL))"
    ).get(project, workspace, workspace);
  }

  async deleteSession(project, workspace) {
    const r = this.db.prepare(
      "DELETE FROM sessions WHERE project = ? AND (workspace = ? OR (workspace IS NULL AND ? IS NULL))"
    ).run(project, workspace, workspace);
    return r.changes;
  }

  async deleteAllSessions(project) {
    const r = this.db.prepare("DELETE FROM sessions WHERE project = ?").run(project);
    return r.changes;
  }

  async getAllSessions(project) {
    return this.db.prepare("SELECT * FROM sessions WHERE project = ? ORDER BY updated_at DESC").all(project);
  }

  // -- Archive / Priority --
  async archive(table, id) {
    const r = this.db.prepare(`UPDATE ${table} SET archived = 1 WHERE id = ?`).run(id);
    return r.changes;
  }

  async setPriority(table, id, priority) {
    const r = this.db.prepare(`UPDATE ${table} SET priority = ? WHERE id = ?`).run(priority, id);
    return r.changes;
  }

  // -- Prune / Cleanup --
  async prune(project, cutoffDate, tables) {
    let total = 0;
    for (const table of tables) {
      let q = `DELETE FROM ${table} WHERE archived = 1 AND created_at < ?`;
      let r;
      if (project !== "all") {
        r = this.db.prepare(q + " AND project = ?").run(cutoffDate, project);
      } else {
        r = this.db.prepare(q).run(cutoffDate);
      }
      total += r.changes;
    }
    return total;
  }

  async bulkCleanup(project, cutoffDate, tables, archivedOnly) {
    let total = 0;
    const perTable = {};
    for (const table of tables) {
      const conds = ["created_at < ?"];
      const params = [cutoffDate];
      if (archivedOnly) conds.push("archived = 1");
      if (project !== "all") { conds.push("project = ?"); params.push(project); }
      const r = this.db.prepare(`DELETE FROM ${table} WHERE ${conds.join(" AND ")}`).run(...params);
      perTable[table] = r.changes;
      total += r.changes;
    }
    return { total, perTable };
  }

  // -- Search All --
  async searchContext(project, pattern) {
    return this.db.prepare(
      "SELECT key, value FROM context WHERE project = ? AND (key LIKE ? OR value LIKE ?)"
    ).all(project, pattern, pattern);
  }

  // -- Stats --
  async countTable(table, project, includeArchived) {
    const archived = includeArchived ? "" : "AND (archived IS NULL OR archived = 0)";
    if (project) {
      const condition = table === "learnings" ? "(project = ? OR project IS NULL)" : "project = ?";
      return this.db.prepare(`SELECT COUNT(*) as count FROM ${table} WHERE ${condition} ${archived}`).get(project).count;
    }
    return this.db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get().count;
  }

  async getDetailedStats(project) {
    if (project) {
      return {
        decisions: this.db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) as archived FROM decisions WHERE project = ?").get(project),
        errors: this.db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) as archived FROM errors WHERE project = ?").get(project),
        learnings: this.db.prepare("SELECT COUNT(*) as total, SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) as archived FROM learnings WHERE project = ?").get(project),
        context: this.db.prepare("SELECT COUNT(*) as total FROM context WHERE project = ?").get(project),
      };
    }
    return null;
  }

  async getAllProjects() {
    return this.db.prepare(`
      SELECT DISTINCT project FROM (
        SELECT project FROM decisions
        UNION SELECT project FROM errors
        UNION SELECT project FROM context
        UNION SELECT project FROM learnings WHERE project IS NOT NULL
      ) ORDER BY project
    `).all();
  }

  async getProjectStats(project) {
    return {
      decisions: this.db.prepare("SELECT COUNT(*) as count FROM decisions WHERE project = ?").get(project).count,
      errors: this.db.prepare("SELECT COUNT(*) as count FROM errors WHERE project = ?").get(project).count,
      learnings: this.db.prepare("SELECT COUNT(*) as count FROM learnings WHERE project = ?").get(project).count,
      context: this.db.prepare("SELECT COUNT(*) as count FROM context WHERE project = ?").get(project).count,
    };
  }

  async getTotalArchived() {
    return this.db.prepare(`
      SELECT (SELECT COUNT(*) FROM decisions WHERE archived = 1) +
             (SELECT COUNT(*) FROM errors WHERE archived = 1) +
             (SELECT COUNT(*) FROM learnings WHERE archived = 1) as count
    `).get().count;
  }

  async getGlobalLearningsCount() {
    return this.db.prepare("SELECT COUNT(*) as count FROM learnings WHERE project IS NULL").get().count;
  }

  // -- Export / Import --
  async exportProject(project, includeArchived) {
    const filter = includeArchived ? "" : "AND (archived IS NULL OR archived = 0)";
    return {
      decisions: this.db.prepare(`SELECT * FROM decisions WHERE project = ? ${filter}`).all(project),
      errors: this.db.prepare(`SELECT * FROM errors WHERE project = ? ${filter}`).all(project),
      context: this.db.prepare("SELECT * FROM context WHERE project = ?").all(project),
      learnings: this.db.prepare(`SELECT * FROM learnings WHERE project = ? ${filter}`).all(project),
      sessions: this.db.prepare("SELECT * FROM sessions WHERE project = ?").all(project),
    };
  }

  // -- DB path (for stats) --
  get dbPath() {
    return this._dbPath;
  }
}

// ---------- PostgreSQL Backend ----------

class PostgresBackend {
  constructor(pool) {
    this.pool = pool;
    this.type = "postgres";
  }

  async initialize() {
    // Split PG_SCHEMA into individual statements
    const statements = PG_SCHEMA
      .split(";")
      .map(s => s.trim())
      .filter(s => s.length > 0);
    for (const stmt of statements) {
      await this.pool.query(stmt);
    }
  }

  // Helper: single row
  async _get(sql, params) {
    const { rows } = await this.pool.query(sql, params);
    return rows[0] || null;
  }

  // Helper: multiple rows
  async _all(sql, params) {
    const { rows } = await this.pool.query(sql, params);
    return rows;
  }

  // Helper: execute with row count
  async _run(sql, params) {
    const { rowCount } = await this.pool.query(sql, params);
    return rowCount;
  }

  // Helper: insert returning id
  async _insert(sql, params) {
    const { rows } = await this.pool.query(sql + " RETURNING id", params);
    return rows[0].id;
  }

  // -- Decisions --
  async insertDecision(project, date, decision, rationale, category) {
    return this._insert(
      "INSERT INTO decisions (project, date, decision, rationale, category) VALUES ($1, $2, $3, $4, $5)",
      [project, date, decision, rationale, category]
    );
  }

  async getDecisions(project, limit) {
    return this._all(
      "SELECT * FROM decisions WHERE project = $1 AND (archived IS NULL OR archived = 0) ORDER BY priority DESC, date DESC LIMIT $2",
      [project, limit]
    );
  }

  async getDecisionsByCategory(project, category, limit) {
    return this._all(
      "SELECT * FROM decisions WHERE project = $1 AND category = $2 AND (archived IS NULL OR archived = 0) ORDER BY priority DESC, date DESC LIMIT $3",
      [project, category, limit]
    );
  }

  async searchDecisions(project, pattern) {
    return this._all(
      "SELECT * FROM decisions WHERE project = $1 AND (archived IS NULL OR archived = 0) AND (decision ILIKE $2 OR rationale ILIKE $2) ORDER BY priority DESC, date DESC",
      [project, pattern]
    );
  }

  async trackDecisionAccess(id) {
    await this.pool.query("UPDATE decisions SET access_count = COALESCE(access_count, 0) + 1, last_accessed = NOW() WHERE id = $1", [id]);
  }

  // -- Errors --
  async insertError(project, errorPattern, solution, context, category) {
    return this._insert(
      "INSERT INTO errors (project, error_pattern, solution, context, category) VALUES ($1, $2, $3, $4, $5)",
      [project, errorPattern, solution, context, category]
    );
  }

  async findSolution(project, pattern) {
    return this._all(
      "SELECT * FROM errors WHERE project = $1 AND (archived IS NULL OR archived = 0) AND error_pattern ILIKE $2 ORDER BY priority DESC, created_at DESC LIMIT 5",
      [project, pattern]
    );
  }

  async findSolutionByCategory(project, category, pattern) {
    return this._all(
      "SELECT * FROM errors WHERE project = $1 AND category = $2 AND (archived IS NULL OR archived = 0) AND error_pattern ILIKE $3 ORDER BY priority DESC, created_at DESC LIMIT 5",
      [project, category, pattern]
    );
  }

  async getRecentErrors(project, limit) {
    return this._all(
      "SELECT * FROM errors WHERE project = $1 AND (archived IS NULL OR archived = 0) ORDER BY priority DESC, created_at DESC LIMIT $2",
      [project, limit]
    );
  }

  async trackErrorAccess(id) {
    await this.pool.query("UPDATE errors SET access_count = COALESCE(access_count, 0) + 1, last_accessed = NOW() WHERE id = $1", [id]);
  }

  // -- Context --
  async upsertContext(project, key, value) {
    await this.pool.query(
      "INSERT INTO context (project, key, value, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT(project, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
      [project, key, value]
    );
  }

  async getContext(project) {
    return this._all("SELECT key, value FROM context WHERE project = $1", [project]);
  }

  async getContextValue(project, key) {
    return this._get("SELECT value FROM context WHERE project = $1 AND key = $2", [project, key]);
  }

  async deleteContext(project, key) {
    return this._run("DELETE FROM context WHERE project = $1 AND key = $2", [project, key]);
  }

  // -- Learnings --
  async insertLearning(project, category, content) {
    return this._insert(
      "INSERT INTO learnings (project, category, content) VALUES ($1, $2, $3)",
      [project, category, content]
    );
  }

  async getLearnings(project, limit) {
    return this._all(
      "SELECT * FROM learnings WHERE (project = $1 OR project IS NULL) AND (archived IS NULL OR archived = 0) ORDER BY priority DESC, created_at DESC LIMIT $2",
      [project, limit]
    );
  }

  async searchLearnings(project, pattern) {
    return this._all(
      "SELECT * FROM learnings WHERE (project = $1 OR project IS NULL) AND (archived IS NULL OR archived = 0) AND content ILIKE $2 ORDER BY priority DESC, created_at DESC",
      [project, pattern]
    );
  }

  async getGlobalLearnings(limit) {
    return this._all(
      "SELECT * FROM learnings WHERE project IS NULL AND (archived IS NULL OR archived = 0) ORDER BY created_at DESC LIMIT $1",
      [limit]
    );
  }

  async trackLearningAccess(id) {
    await this.pool.query("UPDATE learnings SET access_count = COALESCE(access_count, 0) + 1, last_accessed = NOW() WHERE id = $1", [id]);
  }

  // -- Sessions --
  // Postgres normalizes null workspace to '' for UNIQUE constraint
  async upsertSession(project, workspace, task, status, notes) {
    const ws = workspace ?? "";
    await this.pool.query(
      `INSERT INTO sessions (project, workspace, task, status, notes, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT(project, workspace)
       DO UPDATE SET task = EXCLUDED.task, status = EXCLUDED.status, notes = EXCLUDED.notes, updated_at = NOW()`,
      [project, ws, task, status, notes]
    );
  }

  async getSession(project, workspace) {
    const ws = workspace ?? "";
    return this._get("SELECT * FROM sessions WHERE project = $1 AND workspace = $2", [project, ws]);
  }

  async deleteSession(project, workspace) {
    const ws = workspace ?? "";
    return this._run("DELETE FROM sessions WHERE project = $1 AND workspace = $2", [project, ws]);
  }

  async deleteAllSessions(project) {
    return this._run("DELETE FROM sessions WHERE project = $1", [project]);
  }

  async getAllSessions(project) {
    return this._all("SELECT * FROM sessions WHERE project = $1 ORDER BY updated_at DESC", [project]);
  }

  // -- Archive / Priority --
  async archive(table, id) {
    return this._run(`UPDATE ${table} SET archived = 1 WHERE id = $1`, [id]);
  }

  async setPriority(table, id, priority) {
    return this._run(`UPDATE ${table} SET priority = $1 WHERE id = $2`, [priority, id]);
  }

  // -- Prune / Cleanup --
  async prune(project, cutoffDate, tables) {
    let total = 0;
    for (const table of tables) {
      let count;
      if (project !== "all") {
        count = await this._run(`DELETE FROM ${table} WHERE archived = 1 AND created_at < $1 AND project = $2`, [cutoffDate, project]);
      } else {
        count = await this._run(`DELETE FROM ${table} WHERE archived = 1 AND created_at < $1`, [cutoffDate]);
      }
      total += count;
    }
    return total;
  }

  async bulkCleanup(project, cutoffDate, tables, archivedOnly) {
    let total = 0;
    const perTable = {};
    for (const table of tables) {
      const conds = ["created_at < $1"];
      const params = [cutoffDate];
      let idx = 2;
      if (archivedOnly) conds.push("archived = 1");
      if (project !== "all") { conds.push(`project = $${idx}`); params.push(project); idx++; }
      const count = await this._run(`DELETE FROM ${table} WHERE ${conds.join(" AND ")}`, params);
      perTable[table] = count;
      total += count;
    }
    return { total, perTable };
  }

  // -- Search All --
  async searchContext(project, pattern) {
    return this._all(
      "SELECT key, value FROM context WHERE project = $1 AND (key ILIKE $2 OR value ILIKE $2)",
      [project, pattern]
    );
  }

  // -- Stats --
  async countTable(table, project, includeArchived) {
    const archived = includeArchived ? "" : "AND (archived IS NULL OR archived = 0)";
    if (project) {
      const condition = table === "learnings" ? "(project = $1 OR project IS NULL)" : "project = $1";
      const r = await this._get(`SELECT COUNT(*) as count FROM ${table} WHERE ${condition} ${archived}`, [project]);
      return parseInt(r.count);
    }
    const r = await this._get(`SELECT COUNT(*) as count FROM ${table}`, []);
    return parseInt(r.count);
  }

  async getDetailedStats(project) {
    if (!project) return null;
    const decisions = await this._get("SELECT COUNT(*) as total, SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) as archived FROM decisions WHERE project = $1", [project]);
    const errors = await this._get("SELECT COUNT(*) as total, SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) as archived FROM errors WHERE project = $1", [project]);
    const learnings = await this._get("SELECT COUNT(*) as total, SUM(CASE WHEN archived = 1 THEN 1 ELSE 0 END) as archived FROM learnings WHERE project = $1", [project]);
    const context = await this._get("SELECT COUNT(*) as total FROM context WHERE project = $1", [project]);
    return { decisions, errors, learnings, context };
  }

  async getAllProjects() {
    return this._all(`
      SELECT DISTINCT project FROM (
        SELECT project FROM decisions
        UNION SELECT project FROM errors
        UNION SELECT project FROM context
        UNION SELECT project FROM learnings WHERE project IS NOT NULL
      ) t ORDER BY project
    `, []);
  }

  async getProjectStats(project) {
    const [d, e, l, c] = await Promise.all([
      this._get("SELECT COUNT(*) as count FROM decisions WHERE project = $1", [project]),
      this._get("SELECT COUNT(*) as count FROM errors WHERE project = $1", [project]),
      this._get("SELECT COUNT(*) as count FROM learnings WHERE project = $1", [project]),
      this._get("SELECT COUNT(*) as count FROM context WHERE project = $1", [project]),
    ]);
    return {
      decisions: parseInt(d.count),
      errors: parseInt(e.count),
      learnings: parseInt(l.count),
      context: parseInt(c.count),
    };
  }

  async getTotalArchived() {
    const r = await this._get(`
      SELECT (SELECT COUNT(*) FROM decisions WHERE archived = 1) +
             (SELECT COUNT(*) FROM errors WHERE archived = 1) +
             (SELECT COUNT(*) FROM learnings WHERE archived = 1) as count
    `, []);
    return parseInt(r.count);
  }

  async getGlobalLearningsCount() {
    const r = await this._get("SELECT COUNT(*) as count FROM learnings WHERE project IS NULL", []);
    return parseInt(r.count);
  }

  // -- Export / Import --
  async exportProject(project, includeArchived) {
    const filter = includeArchived ? "" : "AND (archived IS NULL OR archived = 0)";
    const [decisions, errors, context, learnings, sessions] = await Promise.all([
      this._all(`SELECT * FROM decisions WHERE project = $1 ${filter}`, [project]),
      this._all(`SELECT * FROM errors WHERE project = $1 ${filter}`, [project]),
      this._all("SELECT * FROM context WHERE project = $1", [project]),
      this._all(`SELECT * FROM learnings WHERE project = $1 ${filter}`, [project]),
      this._all("SELECT * FROM sessions WHERE project = $1", [project]),
    ]);
    return { decisions, errors, context, learnings, sessions };
  }

  get dbPath() {
    return "postgres";
  }
}

// ---------- Factory ----------

export async function createDatabase(config) {
  const pgUrl = process.env.DATABASE_URL || config?.postgres?.connectionString;

  if (pgUrl) {
    try {
      const { default: pg } = await import("pg");
      const pool = new pg.Pool({ connectionString: pgUrl });
      // Test connection
      await pool.query("SELECT 1");
      const backend = new PostgresBackend(pool);
      await backend.initialize();
      console.error(`[claude-memory] Using PostgreSQL backend`);
      return backend;
    } catch (e) {
      console.error(`[claude-memory] Postgres connection failed: ${e.message}`);
      console.error(`[claude-memory] Falling back to SQLite`);
    }
  }

  const dbPath = join(homedir(), ".claude", "memory.db");
  const backend = new SqliteBackend(dbPath);
  backend._dbPath = dbPath;
  console.error(`[claude-memory] Using SQLite backend: ${dbPath}`);
  return backend;
}
