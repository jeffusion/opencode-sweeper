/**
 * Read-only SQLite scan path — bypasses the opencode SDK `session.list()` API
 * because the SDK API hard-filters by `project_id = current_instance.project.id`
 * and caps results at the latest 100 rows (sst/opencode session.ts L964+L997+L1003,
 * SHA 68f225a). That makes it impossible for a plugin to ever see stale sessions
 * belonging to other projects, or sessions older than the 100 most-recent in the
 * current project — which is precisely what a sweeper needs to clean. Reading the
 * opencode SQLite DB directly via the runtime's built-in SQLite is the only path
 * that covers the full session table across all projects.
 *
 * Backend selection is runtime-detected (mirrors @cortexkit/opencode-magic-context
 * `shared/sqlite.ts`): Bun uses `bun:sqlite` (built in, fast); Node/Electron uses
 * `node:sqlite` `DatabaseSync` (built into Node 22.5+, stable since 22.13). Static
 * imports of either would crash at parse time in the wrong runtime, so we use
 * dynamic `import()` gated by a `typeof Bun` probe. `better-sqlite3` is deliberately
 * avoided: it is a native module requiring per-ABI prebuilds that break under
 * Electron's ABI.
 *
 * Safety: the DB is opened readonly. opencode uses WAL journal mode (verified on a
 * real ~/.local/share/opencode/opencode.db), so a readonly reader cannot block
 * opencode's writes. We never write, never ATTACH, never run pragmas that mutate.
 */

import type { SessionLike } from "./sweep.js";

/** Raw row shape we select from the `session` table. */
export interface SessionRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  title: string;
  directory: string;
  time_created: number;
  time_updated: number;
  time_compacting: number | null;
  time_archived: number | null;
}

/** Minimal backend-forwarded interface — only the surface we use. */
interface ReadOnlyDatabase {
  prepare(sql: string): { all(): unknown[] };
  close(): void;
}

const COLUMNS_WE_NEED = [
  "id",
  "project_id",
  "parent_id",
  "title",
  "directory",
  "time_created",
  "time_updated",
  "time_compacting",
  "time_archived",
] as const;

const SELECT_SQL = `
  SELECT
    id, project_id, parent_id, title, directory,
    time_created, time_updated, time_compacting, time_archived
  FROM session
  ORDER BY time_updated ASC
`;

/** Detect Bun runtime. `typeof Bun` check works because Bun injects a global `Bun`. */
function isBunRuntime(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/**
 * Open a readonly connection to the opencode SQLite database.
 * Falls back to the runtime-appropriate builtin (`bun:sqlite` or `node:sqlite`).
 * Throws `DbBackendUnavailableError` if neither backend is importable.
 */
async function openReadonly(dbPath: string): Promise<ReadOnlyDatabase> {
  if (isBunRuntime()) {
    // `bun:sqlite` is a built-in Bun module. Static import fails on Node, so dynamic.
    const mod = (await import("bun:sqlite")) as {
      Database: new (path: string, options?: { readonly?: boolean }) => ReadOnlyDatabase;
    };
    return new mod.Database(dbPath, { readonly: true });
  }
  // `node:sqlite` is built into Node 22.5+ / Electron 41+. Dynamic import avoids
  // parse-time crash on Bun (which has no `node:sqlite`).
  const mod = (await import("node:sqlite")) as {
    DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => ReadOnlyDatabase;
  };
  return new mod.DatabaseSync(dbPath, { readOnly: true });
}

/** Coerce a raw sqlite row (positional or named) to a typed `SessionRow`. */
function coerceRow(raw: unknown, index: number): SessionRow {
  if (raw === null || typeof raw !== "object") {
    throw new Error(`db.listSessions: row ${index} is not an object`);
  }
  const row = raw as Record<string, unknown>;
  const out: SessionRow = {
    id: String(row.id),
    project_id: String(row.project_id),
    parent_id: row.parent_id === null ? null : String(row.parent_id),
    title: String(row.title),
    directory: String(row.directory),
    time_created: Number(row.time_created),
    time_updated: Number(row.time_updated),
    time_compacting: row.time_compacting === null ? null : Number(row.time_compacting),
    time_archived: row.time_archived === null ? null : Number(row.time_archived),
  };
  return out;
}

/** Convert raw DB rows to the `SessionLike` shape used by `runSweep`. */
export function rowToSessionLike(row: SessionRow): SessionLike {
  return {
    id: row.id,
    parentID: row.parent_id === null ? undefined : row.parent_id,
    title: row.title,
    directory: row.directory,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      ...(row.time_compacting !== null ? { compacting: row.time_compacting } : {}),
    },
  };
}

/**
 * Schema guard — verify the `session` table has all columns we depend on.
 * Throws a typed error naming the missing column, so callers can degrade
 * gracefully (rather than silently scanning with wrong field semantics) when
 * opencode ships a future schema migration.
 */
function assertSchema(db: ReadOnlyDatabase): void {
  const rows = db.prepare("PRAGMA table_info(session)").all() as Array<{
    name: string;
  }>;
  const present = new Set(rows.map((r) => r.name));
  const missing: string[] = [];
  for (const col of COLUMNS_WE_NEED) {
    if (!present.has(col)) {
      missing.push(col);
    }
  }
  if (missing.length > 0) {
    throw new SchemaMismatchError(missing);
  }
}

export class SchemaMismatchError extends Error {
  readonly missingColumns: string[];
  constructor(missing: string[]) {
    super(`opencode session table missing columns: ${missing.join(", ")}`);
    this.name = "SchemaMismatchError";
    this.missingColumns = missing;
  }
}

export class DbBackendUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DbBackendUnavailableError";
  }
}

/**
 * Resolve the opencode SQLite database path. opencode 1.x stores the DB at
 * `<XDG_DATA_HOME>/opencode/opencode.db` (Linux `~/.local/share/opencode/opencode.db`,
 * macOS `~/Library/Application Support/opencode/opencode.db`). The plugin does not
 * guess the path — it resolves via `XDG_DATA_HOME` env or platform default.
 */
export function resolveOpencodeDbPath(override?: string): string {
  if (override !== undefined && override.length > 0) {
    return override;
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const xdgData = process.env.XDG_DATA_HOME ?? "";
  // Linux: $XDG_DATA_HOME/opencode/opencode.db or ~/.local/share/opencode/opencode.db
  // macOS: ~/Library/Application Support/opencode/opencode.db
  // We check XDG first (opencode honors it on Linux), then platform defaults.
  if (xdgData.length > 0) {
    return `${xdgData}/opencode/opencode.db`;
  }
  if (process.platform === "darwin") {
    return `${home}/Library/Application Support/opencode/opencode.db`;
  }
  return `${home}/.local/share/opencode/opencode.db`;
}

/**
 * List every session row in the DB, ordered oldest-first. No project filter,
 * no limit 100, no `time_updated desc` cutter — the sweeper needs to see the
 * full table to actually find expired rows the SDK never exposes.
 *
 * Throws `SchemaMismatchError` if opencode future schema drops required columns.
 * Throws `DbBackendUnavailableError` if neither `bun:sqlite` nor `node:sqlite`
 * is importable (extremely unlikely for opencode plugin hosts).
 */
export async function listSessions(dbPath: string): Promise<SessionRow[]> {
  let db: ReadOnlyDatabase;
  try {
    db = await openReadonly(dbPath);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // Normalize backend-missing as a typed error.
    if (
      msg.includes("Cannot find") ||
      msg.includes("Cannot use") ||
      msg.includes("is not a valid")
    ) {
      throw new DbBackendUnavailableError(`No SQLite backend available: ${msg}`);
    }
    throw error;
  }

  try {
    assertSchema(db);
    const raw = db.prepare(SELECT_SQL).all();
    return raw.map((row, i) => coerceRow(row, i));
  } finally {
    db.close();
  }
}
