import { expect, mock, test } from "bun:test";
import { runSweepExclusive, sweepQueueID } from "../src/v2-sweep-queue.js";
import { type listAll, setupV2 } from "../src/v2.js";

type TestClient = Parameters<typeof listAll>[0];
type SetupOptions = NonNullable<Parameters<typeof setupV2>[1]>;
type MakeClient = NonNullable<SetupOptions["makeClient"]>;
type QueueModule = typeof import("../src/v2-sweep-queue.js");

function asClient(value: unknown): TestClient {
  return value as TestClient;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for test condition");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("queue serializes callbacks and preserves each result/config", async () => {
  const firstGate = deferred<void>();
  let running = 0;
  let maxRunning = 0;
  const order: string[] = [];

  const first = runSweepExclusive(async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    order.push("a:start");
    await firstGate.promise;
    order.push("a:end");
    running -= 1;
    return { location: "a" };
  }, new AbortController().signal);
  await waitFor(() => order.length === 1);

  const second = runSweepExclusive(async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    order.push("b:start");
    order.push("b:end");
    running -= 1;
    return { location: "b" };
  }, new AbortController().signal);

  await Promise.resolve();
  expect(order).toEqual(["a:start"]);
  firstGate.resolve();
  expect(await first).toEqual({ location: "a" });
  expect(await second).toEqual({ location: "b" });
  expect(maxRunning).toBe(1);
  expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
});

test("A runs, B is cancelled while queued, and C still waits for A", async () => {
  const aGate = deferred<void>();
  const aStarted = deferred<void>();
  let bCalled = 0;
  let cCalled = 0;

  const a = runSweepExclusive(async () => {
    aStarted.resolve();
    await aGate.promise;
    return "a";
  }, new AbortController().signal);
  await aStarted.promise;

  const bController = new AbortController();
  const b = runSweepExclusive(async () => {
    bCalled += 1;
    return "b";
  }, bController.signal);
  const bResult = b.catch((error: unknown) => error);
  bController.abort(new Error("queued cleanup"));

  const error = await bResult;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("queued cleanup");
  expect(bCalled).toBe(0);

  const c = runSweepExclusive(async () => {
    cCalled += 1;
    return "c";
  }, new AbortController().signal);
  await Promise.resolve();
  expect(cCalled).toBe(0);

  aGate.resolve();
  expect(await a).toBe("a");
  expect(await c).toBe("c");
  expect(cCalled).toBe(1);
});

test("cancelling a running signal does not release a queued successor early", async () => {
  const aController = new AbortController();
  const aStarted = deferred<void>();
  const aRelease = deferred<void>();
  let bCalled = 0;
  let aObservedAbort = false;

  const a = runSweepExclusive(async () => {
    aStarted.resolve();
    await new Promise<void>((resolve) => {
      aController.signal.addEventListener(
        "abort",
        () => {
          aObservedAbort = true;
        },
        { once: true },
      );
      void aRelease.promise.then(resolve);
    });
    return "a";
  }, aController.signal);
  await aStarted.promise;

  const b = runSweepExclusive(async () => {
    bCalled += 1;
    return "b";
  }, new AbortController().signal);

  aController.abort(new Error("cancel running A"));
  await waitFor(() => aObservedAbort);
  await Promise.resolve();
  expect(bCalled).toBe(0);

  aRelease.resolve();
  expect(await a).toBe("a");
  expect(await b).toBe("b");
  expect(bCalled).toBe(1);
});

test("a failing sweep does not poison its successor", async () => {
  const first = runSweepExclusive(async () => {
    throw new Error("boom");
  }, new AbortController().signal);
  const second = runSweepExclusive(async () => "ok", new AbortController().signal);

  await expect(first).rejects.toThrow("boom");
  expect(await second).toBe("ok");
});

test("an already-aborted caller never starts its callback", async () => {
  const controller = new AbortController();
  controller.abort(new Error("pre-aborted"));
  let called = 0;

  await expect(
    runSweepExclusive(async () => {
      called += 1;
      return "never";
    }, controller.signal),
  ).rejects.toThrow("pre-aborted");
  expect(called).toBe(0);
});

test("aborting a queued location cleanup does not cancel the running sweep", async () => {
  const aController = new AbortController();
  const aStarted = deferred<void>();
  const aRelease = deferred<void>();
  let aCalled = 0;

  const a = runSweepExclusive(async () => {
    aCalled += 1;
    aStarted.resolve();
    await aRelease.promise;
    return "a";
  }, aController.signal);
  await aStarted.promise;

  const bController = new AbortController();
  const b = runSweepExclusive(async () => "b", bController.signal);
  bController.abort(new Error("location cleanup"));

  await expect(b).rejects.toThrow("location cleanup");
  expect(aCalled).toBe(1);
  expect(aController.signal.aborted).toBe(false);

  aRelease.resolve();
  expect(await a).toBe("a");
});

test("cache-busted queue modules share one ID and one mutex", async () => {
  const suffix = `${Date.now()}-${Math.random()}`;
  const firstModule = (await import(`../src/v2-sweep-queue.js?queue=${suffix}-a`)) as QueueModule;
  const secondModule = (await import(`../src/v2-sweep-queue.js?queue=${suffix}-b`)) as QueueModule;

  expect(firstModule.sweepQueueID).toBe(secondModule.sweepQueueID);
  expect(firstModule.sweepQueueID).toBe(sweepQueueID);
  expect(firstModule.runSweepExclusive).not.toBe(secondModule.runSweepExclusive);

  const gate = deferred<void>();
  let running = 0;
  let maxRunning = 0;
  let secondCalled = 0;
  const first = firstModule.runSweepExclusive(async () => {
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    await gate.promise;
    running -= 1;
    return "first";
  }, new AbortController().signal);
  await waitFor(() => running === 1);

  const second = secondModule.runSweepExclusive(async () => {
    secondCalled += 1;
    running += 1;
    maxRunning = Math.max(maxRunning, running);
    running -= 1;
    return "second";
  }, new AbortController().signal);
  await Promise.resolve();
  expect(secondCalled).toBe(0);

  gate.resolve();
  expect(await first).toBe("first");
  expect(await second).toBe("second");
  expect(maxRunning).toBe(1);
});

type TestTool = {
  execute(
    args: unknown,
    context: { sessionID: string; signal?: AbortSignal },
  ): Promise<{ content?: string }>;
};
type TestEditor = { add(value: TestTool): void; get(id: string): TestTool | undefined };
type TestCommandEditor = { add(value: unknown): void };

function setupContext(directory: string, options: Record<string, unknown> = {}) {
  let tool: TestTool | undefined;
  const ctx = {
    options: { intervalMs: 0, dryRun: true, ...options },
    location: { directory },
    session: { prompt: mock(async () => undefined) },
    plugin: { list: mock(async () => ({ location: { directory }, data: [] })) },
    tool: {
      transform: (edit: (editor: TestEditor) => void) => {
        edit({
          add: (value) => {
            tool = value;
          },
          get: () => undefined,
        });
      },
    },
    command: {
      list: mock(async () => ({ location: { directory }, data: [] })),
      transform: (edit: (editor: TestCommandEditor) => void) => edit({ add: () => undefined }),
    },
  };
  return {
    ctx: ctx as unknown as Parameters<typeof setupV2>[0],
    getTool: () => {
      if (!tool) throw new Error("sweep tool was not registered");
      return tool;
    },
  };
}

const DAY = 86_400_000;

type FixtureSession = {
  id: string;
  title: string;
  time: { created: number; updated: number };
};

function fixture(now: number) {
  const ids = {
    days100: "ses-age-100d",
    days35: "ses-age-35d",
    days25: "ses-age-25d",
    days10: "ses-age-10d",
  };
  const root = (id: string, ageDays: number): FixtureSession => {
    const updated = now - ageDays * DAY;
    return { id, title: `root-${ageDays}d`, time: { created: updated, updated } };
  };
  return {
    ids,
    state: new Map<string, FixtureSession>([
      [ids.days100, root(ids.days100, 100)],
      [ids.days35, root(ids.days35, 35)],
      [ids.days25, root(ids.days25, 25)],
      [ids.days10, root(ids.days10, 10)],
    ]),
  };
}

function stateClient(
  state: Map<string, FixtureSession>,
  listScans: number[],
  onRemove?: (id: string) => Promise<void>,
) {
  const list = mock(async () => {
    const data = [...state.values()];
    listScans.push(data.length);
    return { data, cursor: {} };
  });
  const active = mock(async () => ({}));
  const remove = mock(async ({ sessionID }: { sessionID: string }) => {
    await onRemove?.(sessionID);
    state.delete(sessionID);
    return true;
  });
  return {
    client: asClient({ session: { list, active, remove } }),
    list,
    active,
    remove,
  };
}

function summaryCount(content: string | undefined, label: string): number {
  const match = content?.match(new RegExp(`^${label}: (\\d+)$`, "m"));
  if (!match?.[1]) throw new Error(`missing ${label} in sweep summary`);
  return Number(match[1]);
}

test("two setupV2 locations use separate opts/protect and rescan after A", async () => {
  const now = Date.now();
  const { ids, state } = fixture(now);
  const aRemoveStarted = deferred<void>();
  const aRemoveRelease = deferred<void>();
  const aScans: number[] = [];
  const bScans: number[] = [];
  const removeCalls: string[] = [];
  const aClient = stateClient(state, aScans, async (id) => {
    removeCalls.push(`a:${id}`);
    aRemoveStarted.resolve();
    await aRemoveRelease.promise;
  });
  const bClient = stateClient(state, bScans, async (id) => {
    removeCalls.push(`b:${id}`);
  });
  const aFactory: MakeClient = mock(async () => aClient.client);
  const bFactory: MakeClient = mock(async () => bClient.client);

  const a = setupContext("/project-a", { dryRun: false, expiry: "40d" });
  const b = setupContext("/project-b", {
    dryRun: false,
    expiry: "20d",
    protect: [ids.days35],
  });
  const cleanupA = await setupV2(a.ctx, { makeClient: aFactory });
  const cleanupB = await setupV2(b.ctx, { makeClient: bFactory });

  try {
    expect(state.has("caller-a")).toBe(false);
    expect(state.has("caller-b")).toBe(false);

    const aRun = a
      .getTool()
      .execute({}, { sessionID: "caller-a", signal: new AbortController().signal });
    await aRemoveStarted.promise;
    expect(aScans).toEqual([4, 4]);
    expect(state.size).toBe(4);

    const bRun = b
      .getTool()
      .execute({}, { sessionID: "caller-b", signal: new AbortController().signal });
    await Promise.resolve();
    expect(bFactory).not.toHaveBeenCalled();
    expect(bScans).toEqual([]);

    aRemoveRelease.resolve();
    const [aResult, bResult] = await Promise.all([aRun, bRun]);

    expect(aResult.content).toContain("Sweep complete.");
    expect(bResult.content).toContain("Sweep complete.");
    expect(aFactory).toHaveBeenCalledTimes(1);
    expect(bFactory).toHaveBeenCalledTimes(1);
    expect(removeCalls).toEqual([`a:${ids.days100}`, `b:${ids.days25}`]);
    expect(aScans).toEqual([4, 4]);
    expect(bScans).toEqual([3, 3]);
    expect([...state.keys()].sort()).toEqual([ids.days35, ids.days10].sort());

    expect(summaryCount(aResult.content, "scanned")).toBe(4);
    expect(summaryCount(aResult.content, "deleted")).toBe(1);
    expect(summaryCount(aResult.content, "protected")).toBe(0);
    expect(summaryCount(aResult.content, "main notExpired skipped")).toBe(3);
    expect(summaryCount(bResult.content, "scanned")).toBe(3);
    expect(summaryCount(bResult.content, "deleted")).toBe(1);
    expect(summaryCount(bResult.content, "protected")).toBe(1);
    expect(summaryCount(bResult.content, "main notExpired skipped")).toBe(1);
  } finally {
    aRemoveRelease.resolve();
    await cleanupA();
    await cleanupB();
  }
});

test("cleanupB during A never starts B's client factory and leaves A running", async () => {
  const now = Date.now();
  const { ids, state } = fixture(now);
  const aRemoveStarted = deferred<void>();
  const aRemoveRelease = deferred<void>();
  const removeCalls: string[] = [];
  const aScans: number[] = [];
  const bScans: number[] = [];
  let aSignal: AbortSignal | undefined;

  const aClient = stateClient(state, aScans, async (id) => {
    removeCalls.push(`a:${id}`);
    aRemoveStarted.resolve();
    await aRemoveRelease.promise;
  });
  const bClient = stateClient(state, bScans);
  const aFactory: MakeClient = mock(async (signal: AbortSignal) => {
    aSignal = signal;
    return aClient.client;
  });
  const bFactory: MakeClient = mock(async () => bClient.client);

  const a = setupContext("/project-a", { dryRun: false, expiry: "40d" });
  const b = setupContext("/project-b", {
    dryRun: false,
    expiry: "20d",
    protect: [ids.days35],
  });
  const cleanupA = await setupV2(a.ctx, { makeClient: aFactory });
  const cleanupB = await setupV2(b.ctx, { makeClient: bFactory });

  let cleanupBDone = false;
  try {
    const aRun = a
      .getTool()
      .execute({}, { sessionID: "caller-a", signal: new AbortController().signal });
    await aRemoveStarted.promise;
    let aDone = false;
    void aRun.then(() => {
      aDone = true;
    });

    const bRun = b
      .getTool()
      .execute({}, { sessionID: "caller-b", signal: new AbortController().signal });
    await Promise.resolve();
    expect(bFactory).not.toHaveBeenCalled();

    await cleanupB();
    cleanupBDone = true;
    expect(bFactory).not.toHaveBeenCalled();
    expect(bScans).toEqual([]);
    expect(aSignal?.aborted).toBe(false);
    expect(aDone).toBe(false);

    const bResult = await bRun;
    expect(bResult.content).toContain("Sweep failed");

    aRemoveRelease.resolve();
    const aResult = await aRun;
    expect(aDone).toBe(true);
    expect(aResult.content).toContain("Sweep complete.");
    expect(removeCalls).toEqual([`a:${ids.days100}`]);
    expect([...state.keys()].sort()).toEqual([ids.days35, ids.days25, ids.days10].sort());
  } finally {
    aRemoveRelease.resolve();
    await cleanupA();
    if (!cleanupBDone) await cleanupB();
  }
});
