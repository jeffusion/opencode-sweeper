import { afterEach, beforeEach, mock, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import { OpencodeDbNotFoundError, listSessions } from "../src/db";
import { createServer } from "../src/index";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sweeper-db-errors-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

async function captureError(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail("expected the operation to throw");
}

test("missing DB file throws OpencodeDbNotFoundError with path and fixes", async () => {
  const dbPath = join(tmpDir, "missing.db");
  const error = await captureError(() => listSessions(dbPath));

  assert.ok(error instanceof OpencodeDbNotFoundError);
  assert.equal(error.dbPath, dbPath);
  assert.ok(error.message.includes(dbPath));
  assert.match(error.message, /OpenCode/);
  assert.match(error.message, /XDG_DATA_HOME/);
  assert.match(error.message, /dbPath/);
  assert.ok(error.cause instanceof Error);
  assert.equal(existsSync(dbPath), false, "must not create the DB file");
});

test("missing nested parent directories also report not-found without creating them", async () => {
  const dbPath = join(tmpDir, "no-such-parent", "nested", "opencode.db");
  const error = await captureError(() => listSessions(dbPath));

  assert.ok(error instanceof OpencodeDbNotFoundError);
  assert.equal(error.dbPath, dbPath);
  assert.equal(existsSync(join(tmpDir, "no-such-parent")), false);
});

test("a directory at the DB path is an open failure, not not-found", async () => {
  const dirPath = join(tmpDir, "db-as-directory");
  mkdirSync(dirPath);
  const error = await captureError(() => listSessions(dirPath));

  assert.ok(!(error instanceof OpencodeDbNotFoundError));
  assert.ok(error.message.includes(dirPath));
  assert.ok(error.cause instanceof Error);
});

test("a non-directory parent (ENOTDIR) is not reported as not-found", async () => {
  const parentFile = join(tmpDir, "not-a-directory");
  writeFileSync(parentFile, "x");
  const error = await captureError(() => listSessions(join(parentFile, "opencode.db")));

  assert.ok(!(error instanceof OpencodeDbNotFoundError));
  assert.match(error.message, /ENOTDIR|stat failed/);
});

test("a present non-SQLite file rejects instead of returning an empty list", async () => {
  const dbPath = join(tmpDir, "garbage.db");
  writeFileSync(dbPath, "not a sqlite database");
  const error = await captureError(() => listSessions(dbPath));

  assert.ok(!(error instanceof OpencodeDbNotFoundError));
  assert.ok(error instanceof Error);
});

type MockInput = {
  input: PluginInput;
  sessionDelete: ReturnType<typeof mock>;
};

function makeInput(log: PluginInput["client"]["app"]["log"]): MockInput {
  const sessionDelete = mock(async () => ({ data: true, error: undefined }));
  return {
    input: {
      client: {
        app: { log },
        session: { delete: sessionDelete },
      },
    } as unknown as PluginInput,
    sessionDelete,
  };
}

const noUpdate = mock(async () => false);

test("real createServer manual tool propagates a missing-DB error with zero deletes", async () => {
  const dbPath = join(tmpDir, "missing.db");
  const log = mock(async () => ({ data: undefined, error: undefined }));
  const { input, sessionDelete } = makeInput(log as unknown as PluginInput["client"]["app"]["log"]);
  const hooks = (await createServer(noUpdate)(input, {
    dbPath,
    intervalMs: 0,
  })) as Hooks;

  try {
    const sweepTool = hooks.tool?.sweep;
    assert.ok(sweepTool, "createServer should register the sweep tool");
    await assert.rejects(
      () => sweepTool.execute({}, { sessionID: "ses_manual" } as never),
      (error: unknown) => {
        assert.ok(error instanceof OpencodeDbNotFoundError);
        assert.equal(error.dbPath, dbPath);
        return true;
      },
    );
    assert.equal(sessionDelete.mock.calls.length, 0);
  } finally {
    await hooks.dispose?.();
  }
});

test("real timer tick logs the missing-DB error and deletes nothing", async () => {
  const dbPath = join(tmpDir, "missing.db");
  const logs: string[] = [];
  let resolveTimerLog: (() => void) | undefined;
  const timerLogged = new Promise<void>((resolve) => {
    resolveTimerLog = resolve;
  });
  const log = mock(async ({ body }: { body: { message: string } }) => {
    logs.push(body.message);
    if (body.message.startsWith("timer sweep error:")) {
      resolveTimerLog?.();
    }
    return { data: undefined, error: undefined };
  });
  const { input, sessionDelete } = makeInput(log as unknown as PluginInput["client"]["app"]["log"]);

  const unref = mock(() => {});
  const fakeTimer = { unref };
  let tick: (() => void) | undefined;
  let scheduledMs: number | undefined;
  const intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(((
    fn: () => void,
    ms: number,
  ) => {
    tick = fn;
    scheduledMs = ms;
    return fakeTimer;
  }) as unknown as typeof setInterval);
  const clearSpy = spyOn(globalThis, "clearInterval").mockImplementation(() => {});

  const hooks = (await createServer(noUpdate)(input, {
    dbPath,
    intervalMs: 60_000,
  })) as Hooks;

  try {
    assert.ok(tick, "timer tick should be registered");
    assert.equal(scheduledMs, 60_000);
    assert.equal(unref.mock.calls.length, 1);

    tick();
    await timerLogged;

    assert.equal(logs.length, 1);
    assert.match(logs[0] ?? "", /^timer sweep error: .*opencode database not found at/);
    assert.ok((logs[0] ?? "").includes(dbPath));
    assert.equal(sessionDelete.mock.calls.length, 0);
  } finally {
    await hooks.dispose?.();
    assert.equal(clearSpy.mock.calls.length, 1);
    assert.equal(clearSpy.mock.calls[0]?.[0], fakeTimer);
    intervalSpy.mockRestore();
    clearSpy.mockRestore();
  }
});
