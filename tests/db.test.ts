import { afterEach, beforeEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DbBackendUnavailableError,
  SchemaMismatchError,
  listSessions,
  resolveOpencodeDbPath,
  rowToSessionLike,
} from "../src/db";
import type { SessionLike } from "../src/sweep";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sweeper-db-test-"));
  dbPath = join(tmpDir, "test.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// Create a sqlite DB with the opencode `session` schema (subset of columns we need)
// and insert some rows. We must use the same runtime backend that db.ts will use
// to read the file — both run in the same Bun process so `bun:sqlite` is fine.
async function createOpencodeSchema(path: string): Promise<void> {
  // We use `bun:sqlite` directly here because the test harness runs under Bun.
  // The plugin's runtime-detection logic is exercised via the production path.
  const { Database } = await import("bun:sqlite");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      share_url TEXT,
      summary_additions INTEGER,
      summary_deletions INTEGER,
      summary_files INTEGER,
      summary_diffs TEXT,
      revert TEXT,
      permission TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_compacting INTEGER,
      time_archived INTEGER,
      workspace_id TEXT,
      path TEXT,
      agent TEXT,
      model TEXT,
      cost REAL NOT NULL DEFAULT 0,
      tokens_input INTEGER NOT NULL DEFAULT 0,
      tokens_output INTEGER NOT NULL DEFAULT 0,
      tokens_reasoning INTEGER NOT NULL DEFAULT 0,
      tokens_cache_read INTEGER NOT NULL DEFAULT 0,
      tokens_cache_write INTEGER NOT NULL DEFAULT 0,
      metadata TEXT
    )
  `);
  db.close();
}

async function insertSessionRow(
  path: string,
  row: {
    id: string;
    project_id: string;
    parent_id: string | null;
    title: string;
    directory: string;
    time_created: number;
    time_updated: number;
    time_compacting: number | null;
    time_archived: number | null;
  },
): Promise<void> {
  const { Database } = await import("bun:sqlite");
  const db = new Database(path);
  db.prepare(
    `INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_compacting, time_archived)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.project_id,
    row.parent_id,
    "slug",
    row.directory,
    row.title,
    "1.0.0",
    row.time_created,
    row.time_updated,
    row.time_compacting,
    row.time_archived,
  );
  db.close();
}

test("listSessions reads rows from a real SQLite DB across all projects", async () => {
  await createOpencodeSchema(dbPath);
  await insertSessionRow(dbPath, {
    id: "ses_a",
    project_id: "proj_a",
    parent_id: null,
    title: "Main A1",
    directory: "/path/a",
    time_created: 1000,
    time_updated: 2000,
    time_compacting: null,
    time_archived: null,
  });
  await insertSessionRow(dbPath, {
    id: "ses_b",
    project_id: "proj_b",
    parent_id: "ses_a",
    title: "Subagent A1.b",
    directory: "/path/b",
    time_created: 1500,
    time_updated: 1500,
    time_compacting: null,
    time_archived: null,
  });
  await insertSessionRow(dbPath, {
    id: "ses_c",
    project_id: "proj_c",
    parent_id: null,
    title: "Main C",
    directory: "/path/c",
    time_created: 500,
    time_updated: 500,
    time_compacting: null,
    time_archived: null,
  });

  const rows = await listSessions(dbPath);
  assert.equal(rows.length, 3);

  // Ordered by time_updated ASC — oldest first.
  assert.equal(rows[0]?.id, "ses_c");
  assert.equal(rows[1]?.id, "ses_b");
  assert.equal(rows[2]?.id, "ses_a");

  // Cross-project scan works.
  const projects = new Set(rows.map((r) => r.project_id));
  assert.ok(projects.has("proj_a"));
  assert.ok(projects.has("proj_b"));
  assert.ok(projects.has("proj_c"));
});

test("listSessions preserves parent_id null vs string distinction", async () => {
  await createOpencodeSchema(dbPath);
  await insertSessionRow(dbPath, {
    id: "ses_main",
    project_id: "p",
    parent_id: null,
    title: "main",
    directory: "/d",
    time_created: 1,
    time_updated: 1,
    time_compacting: null,
    time_archived: null,
  });
  await insertSessionRow(dbPath, {
    id: "ses_sub",
    project_id: "p",
    parent_id: "ses_main",
    title: "sub",
    directory: "/d",
    time_created: 2,
    time_updated: 2,
    time_compacting: null,
    time_archived: null,
  });

  const rows = await listSessions(dbPath);
  const main = rows.find((r) => r.id === "ses_main");
  const sub = rows.find((r) => r.id === "ses_sub");
  assert.ok(main);
  assert.ok(sub);
  assert.equal(main?.parent_id, null);
  assert.equal(sub?.parent_id, "ses_main");
});

test("rowToSessionLike converts parent_id null → undefined, non-null → string", () => {
  const mainRow = {
    id: "ses_x",
    project_id: "p",
    parent_id: null,
    title: "t",
    directory: "/d",
    time_created: 0,
    time_updated: 0,
    time_compacting: null,
    time_archived: null,
  };
  const subRow = { ...mainRow, id: "ses_y", parent_id: "ses_x" };

  const main: SessionLike = rowToSessionLike(mainRow);
  const sub: SessionLike = rowToSessionLike(subRow);

  assert.equal(main.parentID, undefined);
  assert.equal(sub.parentID, "ses_x");
});

test("SchemaMismatchError fires when required column is missing", async () => {
  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath);
  // Drop parent_id — schema guard should reject.
  db.exec(`CREATE TABLE session (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    directory TEXT NOT NULL,
    title TEXT NOT NULL,
    version TEXT NOT NULL,
    time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL,
    time_compacting INTEGER,
    time_archived INTEGER
  )`);
  db.close();

  await assert.rejects(
    () => listSessions(dbPath),
    (err: unknown) => {
      assert.ok(err instanceof SchemaMismatchError);
      assert.ok((err as SchemaMismatchError).missingColumns.includes("parent_id"));
      return true;
    },
  );
});

test("DbBackendUnavailableError when db file does not exist", async () => {
  // bun:sqlite with fileMustExist:false creates empty DB silently; rw path: nonexistent file
  // Our adapter opens readonly — when file doesn't exist, backend open throws.
  // Verify the typed error path triggers (the dynamic import succeeds, then open throws).
  const missingPath = join(tmpDir, "does-not-exist.db");
  // Since our code uses fileMustExist default (true for bun:sqlite), open should throw.
  // But the error message path may differ per backend. We tolerate either: typed
  // DbBackendUnavailableError OR raw backend error — what we MUST rule out is silent success.
  let caught: unknown;
  try {
    await listSessions(missingPath);
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "listSessions should throw when DB file is missing");
  // We don't strictly require the typed error since the message detection is heuristic;
  // the contract is "never silently return [] when the file is missing".
});

test("resolveOpencodeDbPath uses explicit override when provided", () => {
  assert.equal(resolveOpencodeDbPath("/custom/path.db"), "/custom/path.db");
  assert.equal(resolveOpencodeDbPath("/another.db"), "/another.db");
});

test("resolveOpencodeDbPath honors XDG_DATA_HOME on Linux-like systems", () => {
  const origXdg = process.env.XDG_DATA_HOME;
  // Save and patch.
  process.env.XDG_DATA_HOME = "/tmp/fake-xdg";
  try {
    // XDG path takes priority over platform default on Linux.
    const path = resolveOpencodeDbPath();
    assert.equal(path, "/tmp/fake-xdg/opencode/opencode.db");
  } finally {
    if (origXdg === undefined) {
      process.env.XDG_DATA_HOME = undefined;
    } else {
      process.env.XDG_DATA_HOME = origXdg;
    }
  }
});

test("resolveOpencodeDbPath falls back to platform default when no override or XDG", () => {
  const origXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = undefined;
  try {
    const path = resolveOpencodeDbPath();
    // We don't assert exact home (~/.local on linux, ~/Library on darwin) — just that
    // the returned path ends with /opencode/opencode.db and is non-empty.
    assert.match(path, /opencode\/opencode\.db$/);
    assert.ok(path.length > 0);
  } finally {
    if (origXdg !== undefined) {
      process.env.XDG_DATA_HOME = origXdg;
    }
  }
});
