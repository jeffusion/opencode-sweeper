import { expect, mock, test } from "bun:test";
import { resolve } from "node:path";
import { resolve as resolveHost } from "@opencode/plugin/host";
import { parseOptions } from "../src/options.js";
import { createSweepInvoker, listAll, setupV2, sweepWithClient } from "../src/v2.js";

type TestTool = {
  name: string;
  input: { type: string };
  execute(args: unknown, context: { sessionID: string }): Promise<{ content?: string }>;
};
type TestCommand = {
  name: string;
  execute(args: {
    sessionID: string;
    prompt: Record<string, unknown>;
    delivery: unknown;
  }): Promise<void>;
};
type TestEditor = { add(value: TestTool): void; get(id: string): TestTool | undefined };
type TestCommandEditor = { add(value: TestCommand): void };
type TestClient = Parameters<typeof listAll>[0];

function asClient(value: unknown): TestClient {
  return value as TestClient;
}

function setupContext(list: () => Promise<unknown>, intervalMs = 0) {
  return {
    options: { intervalMs },
    location: { directory: "/project" },
    session: { prompt: mock(async () => undefined) },
    plugin: { list: mock(list) },
    tool: {
      transform: (edit: (editor: TestEditor) => void) =>
        edit({ add: () => undefined, get: () => undefined }),
    },
    command: {
      list: mock(async () => ({ location: { directory: "/project" }, data: [] })),
      transform: (edit: (editor: TestCommandEditor) => void) => edit({ add: () => undefined }),
    },
  };
}

const activePackage = {
  id: "opencode-sweeper",
  source: { type: "package", target: "opencode-sweeper@1.0.0" },
  features: { server: true },
  state: { status: "active" },
};

function pluginListResult(data: unknown[], directory = "/project") {
  return { location: { directory }, data };
}

test("V2 registers sweep tool and command; command resumes its session", async () => {
  let toolDefinition: TestTool | undefined;
  let commandDefinition: TestCommand | undefined;
  const prompt = mock(async () => undefined);
  const commandTransform = mock((edit: (editor: TestCommandEditor) => void) => {
    edit({
      add: (value) => {
        commandDefinition = value;
      },
    });
  });
  const ctx = {
    options: { intervalMs: 0, dryRun: true },
    location: { directory: "/project" },
    session: { prompt },
    plugin: { list: mock(async () => ({ location: { directory: "/project" }, data: [] })) },
    tool: {
      transform: (edit: (editor: TestEditor) => void) => {
        edit({
          add: (value) => {
            toolDefinition = value;
          },
          get: () => undefined,
        });
      },
    },
    command: {
      list: mock(async () => ({ location: { directory: "/project" }, data: [] })),
      transform: commandTransform,
    },
  };

  const cleanup = await setupV2(ctx);
  if (!toolDefinition || !commandDefinition)
    throw new Error("V2 sweep tool or command was not registered");
  expect(toolDefinition.name).toBe("sweep");
  expect(toolDefinition.input.type).toBe("object");
  expect(commandDefinition.name).toBe("sweep");
  await commandDefinition.execute({
    sessionID: "session-a",
    prompt: { parts: [] },
    delivery: "user",
  });
  expect(prompt).toHaveBeenCalledWith({
    parts: [],
    sessionID: "session-a",
    text: expect.stringContaining("Run the `sweep` tool"),
    delivery: "user",
  });
  cleanup();
});

test("V2 leaves a user-defined sweep command intact", async () => {
  let commandTransformCalls = 0;
  const ctx = {
    options: { intervalMs: 0 },
    location: { directory: "/project" },
    session: { prompt: mock(async () => undefined) },
    plugin: { list: mock(async () => ({ location: { directory: "/project" }, data: [] })) },
    tool: {
      transform: (edit: (editor: TestEditor) => void) => {
        edit({ add: () => undefined, get: () => undefined });
      },
    },
    command: {
      list: mock(async () => ({ location: { directory: "/project" }, data: [{ name: "sweep" }] })),
      transform: () => {
        commandTransformCalls += 1;
      },
    },
  };
  const cleanup = await setupV2(ctx as unknown as Parameters<typeof setupV2>[0]);
  expect(commandTransformCalls).toBe(0);
  cleanup();
});

test("V2 auto-update retries an initially empty plugin list even when interval is disabled", async () => {
  let lists = 0;
  let runnerCalls = 0;
  const ctx = setupContext(async () => pluginListResult(++lists === 1 ? [] : [activePackage]));
  const runAutoUpdate: NonNullable<Parameters<typeof setupV2>[1]>["runAutoUpdate"] = async (
    location,
    dependencies,
  ) => {
    runnerCalls += 1;
    expect(location).toBe("/project");
    expect(await dependencies.sourceCheck()).toBe("opencode-sweeper@1.0.0");
    return false;
  };
  const cleanup = await setupV2(ctx as unknown as Parameters<typeof setupV2>[0], {
    runAutoUpdate,
    retryDelayMs: 1,
  });
  for (let i = 0; i < 50 && runnerCalls === 0; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 2));
  expect(lists).toBe(3); // empty initial poll, verified poll, runner's fresh proof
  expect(runnerCalls).toBe(1);
  await cleanup();
});

test("V2 rejects local, failed, duplicate, and wrong-location plugin.list results before runner", async () => {
  const invalidResults = [
    pluginListResult([{ ...activePackage, source: { type: "local", path: "/local" } }]),
    pluginListResult([{ ...activePackage, state: { status: "failed" } }]),
    pluginListResult([activePackage, activePackage]),
    pluginListResult([activePackage], "/other"),
    pluginListResult([{ ...activePackage, source: { type: "package", target: "file:/local" } }]),
  ];
  for (const result of invalidResults) {
    const list = mock(async () => result);
    const ctx = setupContext(list);
    let runnerCalls = 0;
    const cleanup = await setupV2(ctx as unknown as Parameters<typeof setupV2>[0], {
      runAutoUpdate: (async () => {
        runnerCalls += 1;
        return false;
      }) as NonNullable<Parameters<typeof setupV2>[1]>["runAutoUpdate"],
      retryDelayMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(list).toHaveBeenCalledTimes(1);
    expect(runnerCalls).toBe(0);
    await cleanup();
  }
});

test("V2 cleanup cancels the scheduled poll and aborts/waits for an in-flight updater", async () => {
  const pendingList = setupContext(async () => pluginListResult([activePackage]));
  let preCleanupRunnerCalls = 0;
  const preCleanup = await setupV2(pendingList as unknown as Parameters<typeof setupV2>[0], {
    runAutoUpdate: (async () => {
      preCleanupRunnerCalls += 1;
      return false;
    }) as NonNullable<Parameters<typeof setupV2>[1]>["runAutoUpdate"],
  });
  await preCleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(preCleanupRunnerCalls).toBe(0);

  const ctx = setupContext(async () => pluginListResult([activePackage]));
  let signal: AbortSignal | undefined;
  let resolveUpdate!: () => void;
  const cleanup = await setupV2(ctx as unknown as Parameters<typeof setupV2>[0], {
    runAutoUpdate: (async (_location, dependencies) => {
      signal = dependencies.signal;
      return await new Promise<boolean>((resolve) => {
        resolveUpdate = () => resolve(false);
      });
    }) as NonNullable<Parameters<typeof setupV2>[1]>["runAutoUpdate"],
  });
  for (let i = 0; i < 50 && !resolveUpdate; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 2));
  let cleanupComplete = false;
  const cleaning = cleanup().then(() => {
    cleanupComplete = true;
  });
  expect(signal?.aborted).toBe(true);
  await Promise.resolve();
  expect(cleanupComplete).toBe(false);
  resolveUpdate();
  await cleaning;
  expect(cleanupComplete).toBe(true);
});

test("V2 cleanup does not wait forever for an unresolved plugin.list", async () => {
  const list = mock(() => new Promise<unknown>(() => {}));
  const ctx = setupContext(list);
  let runnerCalls = 0;
  let writes = 0;
  const cleanup = await setupV2(ctx as unknown as Parameters<typeof setupV2>[0], {
    runAutoUpdate: (async () => {
      runnerCalls += 1;
      writes += 1;
      return true;
    }) as NonNullable<Parameters<typeof setupV2>[1]>["runAutoUpdate"],
  });
  for (let i = 0; i < 50 && list.mock.calls.length === 0; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 2));
  expect(list).toHaveBeenCalledTimes(1);
  await Promise.race([
    cleanup(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("cleanup hung")), 100)),
  ]);
  expect(runnerCalls).toBe(0);
  expect(writes).toBe(0);
});

test("V2 abort interrupts plugin.list used by runner sourceCheck without fetch or writes", async () => {
  let listCalls = 0;
  const ctx = setupContext(async () => {
    listCalls += 1;
    if (listCalls === 1) return pluginListResult([activePackage]);
    return await new Promise<unknown>(() => {});
  });
  let registryCalls = 0;
  let writes = 0;
  const cleanup = await setupV2(ctx as unknown as Parameters<typeof setupV2>[0], {
    runAutoUpdate: (async (_location, dependencies) => {
      const source = await dependencies.sourceCheck();
      if (source === false || dependencies.signal?.aborted) return false;
      registryCalls += 1;
      if (dependencies.signal?.aborted) return false;
      writes += 1;
      return true;
    }) as NonNullable<Parameters<typeof setupV2>[1]>["runAutoUpdate"],
  });
  for (let i = 0; i < 50 && listCalls < 2; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 2));
  expect(listCalls).toBe(2);
  await Promise.race([
    cleanup(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("cleanup hung")), 100)),
  ]);
  expect(registryCalls).toBe(0);
  expect(writes).toBe(0);
});

test("local OpenCode host resolution discovers the package server entry", () => {
  const projectRoot = resolve(import.meta.dir, "..");
  const entrypoints = resolveHost({ directory: projectRoot });
  const serverEntry = entrypoints.server;
  if (!serverEntry) throw new Error("Host.resolve did not find the local server entry");
  expect(new URL(serverEntry).pathname).toBe(resolve(projectRoot, "server.js"));
});

test("V2 refuses partial results when pagination repeats a cursor", async () => {
  const client = {
    session: {
      list: mock(async () => ({ data: [{ id: "one" }], cursor: { next: "same" } })),
    },
  };
  await expect(listAll(asClient(client))).rejects.toThrow("repeated cursor");
  expect(client.session.list).toHaveBeenCalledTimes(2);
});

test("V2 reads every page and deduplicates identical session records", async () => {
  const record = { id: "same", title: "same", time: { created: 1, updated: 2 } };
  const list = mock(async ({ cursor }: { cursor?: string }) =>
    cursor ? { data: [record], cursor: {} } : { data: [record], cursor: { next: "page-2" } },
  );
  const sessions = await listAll(asClient({ session: { list } }));
  expect(list).toHaveBeenCalledTimes(2);
  expect(sessions.map(({ id }) => id)).toEqual(["same"]);
});

test("V2 rejects conflicting records for the same ID after paging", async () => {
  const first = { id: "same", title: "first", time: { created: 1, updated: 2 } };
  const conflicting = { ...first, title: "second" };
  const list = mock(async ({ cursor }: { cursor?: string }) =>
    cursor ? { data: [conflicting], cursor: {} } : { data: [first], cursor: { next: "page-2" } },
  );
  await expect(listAll(asClient({ session: { list } }))).rejects.toThrow(
    "conflicting records for session same; refusing to sweep",
  );
  expect(list).toHaveBeenCalledTimes(2);
});

test("V2 protects active and explicitly protected sessions", async () => {
  const old = Date.now() - 10 * 24 * 60 * 60 * 1000;
  const sessions = ["active", "configured"].map((id) => ({
    id,
    title: id,
    time: { created: old, updated: old },
  }));
  const remove = mock(async () => undefined);
  const client = {
    session: {
      list: mock(async () => ({ data: sessions, cursor: {} })),
      active: mock(async () => ({ active: { id: "active" } })),
      remove,
    },
  };
  const result = await sweepWithClient(
    asClient(client),
    "/project",
    parseOptions({
      expiryMs: 1,
      subagentExpiryMs: 1,
      recentActivityGraceMs: 60 * 60 * 1000,
      dryRun: false,
    }),
    new Set(["configured"]),
  );
  expect(result.protectedCount).toBe(2);
  expect(remove).not.toHaveBeenCalled();
});

test("V2 rechecks descendant activity, protection and tree changes before cascade removal", async () => {
  const old = Date.now() - 10 * 24 * 60 * 60 * 1000;
  const root = { id: "root", title: "root", time: { created: old, updated: old } };
  const child = {
    id: "child",
    parentID: "root",
    title: "child",
    time: { created: old, updated: old },
  };
  const protectedIDs = new Set<string>();
  const active = mock(async () => ({}));
  const remove = mock(async () => undefined);
  let listCalls = 0;
  const list = mock(async () => {
    listCalls += 1;
    if (listCalls === 2) {
      // Simulate a session becoming dynamically protected between classification
      // and the delete check. Its current parent must be protected too.
      protectedIDs.add("child");
    }
    return { data: [root, child], cursor: {} };
  });
  const result = await sweepWithClient(
    asClient({ session: { list, active, remove } }),
    "/project",
    parseOptions({
      expiryMs: 1,
      subagentExpiryMs: 1,
      recentActivityGraceMs: 60 * 60 * 1000,
      dryRun: false,
    }),
    protectedIDs,
  );
  expect(remove).not.toHaveBeenCalled();
  expect(result.errors.some((error) => error.id === "root")).toBe(true);
});

test("V2 propagates a newly active descendant to its ancestor before removal", async () => {
  const old = Date.now() - 10 * 24 * 60 * 60 * 1000;
  const root = { id: "root", title: "root", time: { created: old, updated: old } };
  const child = {
    id: "child",
    parentID: "root",
    title: "child",
    time: { created: old, updated: old },
  };
  let activeCalls = 0;
  const active = mock(async () => {
    activeCalls += 1;
    return activeCalls === 1 ? {} : { child: { id: "child" } };
  });
  const remove = mock(async () => undefined);
  const result = await sweepWithClient(
    asClient({
      session: { list: mock(async () => ({ data: [root, child], cursor: {} })), active, remove },
    }),
    "/project",
    parseOptions({
      expiryMs: 1,
      subagentExpiryMs: 1,
      recentActivityGraceMs: 60 * 60 * 1000,
      dryRun: false,
    }),
    new Set(),
  );
  expect(remove).not.toHaveBeenCalled();
  expect(result.errors.some((error) => error.id === "root")).toBe(true);
});

test("V2 blocks a cascade when a descendant becomes recent or a new child appears", async () => {
  const old = Date.now() - 10 * 24 * 60 * 60 * 1000;
  const root = { id: "root", title: "root", time: { created: old, updated: old } };
  const child = {
    id: "child",
    parentID: "root",
    title: "child",
    time: { created: old, updated: old },
  };
  const newChild = {
    id: "new-child",
    parentID: "root",
    title: "new",
    time: { created: old, updated: Date.now() },
  };
  const removedIDs: string[] = [];
  const remove = mock(async ({ sessionID }: { sessionID: string }) => {
    removedIDs.push(sessionID);
  });
  let listCalls = 0;
  const list = mock(async () => {
    listCalls += 1;
    return { data: listCalls === 1 ? [root, child] : [root, child, newChild], cursor: {} };
  });
  const result = await sweepWithClient(
    asClient({ session: { list, active: mock(async () => ({})), remove } }),
    "/project",
    parseOptions({
      expiryMs: 1,
      subagentExpiryMs: 1,
      recentActivityGraceMs: 60 * 60 * 1000,
      dryRun: false,
    }),
    new Set(),
  );
  expect(removedIDs).not.toContain("root");
  expect(result.errors.some((error) => error.id === "root")).toBe(true);
});

test("V2 blocks deletion when an initially listed descendant disappears or changes parent", async () => {
  const old = Date.now() - 10 * 24 * 60 * 60 * 1000;
  const root = { id: "root", title: "root", time: { created: old, updated: old } };
  const child = {
    id: "child",
    parentID: "root",
    title: "child",
    time: { created: old, updated: old },
  };
  for (const fresh of [
    [root],
    [
      root,
      { ...child, parentID: "other-root" },
      { id: "other-root", title: "other", time: { created: old, updated: old } },
    ],
  ]) {
    let listCalls = 0;
    const remove = mock(async () => undefined);
    const result = await sweepWithClient(
      asClient({
        session: {
          list: mock(async () => ({ data: ++listCalls === 1 ? [root, child] : fresh, cursor: {} })),
          active: mock(async () => ({})),
          remove,
        },
      }),
      "/project",
      parseOptions({
        expiryMs: 1,
        subagentExpiryMs: 1,
        recentActivityGraceMs: 60 * 60 * 1000,
        dryRun: false,
      }),
      new Set(),
    );
    expect(remove).not.toHaveBeenCalled();
    expect(result.errors.some((error) => error.id === "root")).toBe(true);
  }
});

test("V2 never treats a child SessionNotFoundError as the parent cascade succeeding", async () => {
  const old = Date.now() - 10 * 24 * 60 * 60 * 1000;
  const root = { id: "root", title: "root", time: { created: old, updated: old } };
  const child = {
    id: "child",
    parentID: "root",
    title: "child",
    time: { created: old, updated: old },
  };
  const remove = mock(async ({ sessionID }: { sessionID: string }) => {
    if (sessionID === "root") {
      throw { _tag: "SessionNotFoundError", sessionID: "child", message: "child missing" };
    }
  });
  const result = await sweepWithClient(
    asClient({
      session: {
        list: mock(async () => ({ data: [root, child], cursor: {} })),
        active: mock(async () => ({})),
        remove,
      },
    }),
    "/project",
    parseOptions({
      expiryMs: 1,
      subagentExpiryMs: 1,
      recentActivityGraceMs: 60 * 60 * 1000,
      dryRun: false,
    }),
    new Set(),
  );
  expect(result.errors.some((error) => error.id === "root")).toBe(true);
  expect(result.deletions.map((deletion) => deletion.id)).toEqual(["child"]);
  expect(result.deleted).toBe(1);
});

test("V2 stops issuing DELETEs after its cancellation signal aborts", async () => {
  const old = Date.now() - 10 * 24 * 60 * 60 * 1000;
  const root = { id: "root", title: "root", time: { created: old, updated: old } };
  const controller = new AbortController();
  let listCalls = 0;
  const remove = mock(async () => undefined);
  const list = mock(async () => {
    listCalls += 1;
    if (listCalls === 2) controller.abort(new Error("test abort"));
    return { data: [root], cursor: {} };
  });
  const result = await sweepWithClient(
    asClient({ session: { list, active: mock(async () => ({})), remove } }),
    "/project",
    parseOptions({ expiryMs: 1, recentActivityGraceMs: 60 * 60 * 1000, dryRun: false }),
    new Set(),
    controller.signal,
  );
  expect(remove).not.toHaveBeenCalled();
  expect(result.errors.some((error) => error.id === "root")).toBe(true);
});

test("a tool signal cancels a sweep already started by the timer", async () => {
  const lifecycle = new AbortController();
  const tool = new AbortController();
  let releaseRequest: () => void = () => {};
  let markStarted: () => void = () => {};
  const requestStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const requestGate = new Promise<void>((resolve) => {
    releaseRequest = resolve;
  });
  const remove = mock(async () => undefined);
  const invoker = createSweepInvoker(async (signal) => {
    markStarted();
    await requestGate;
    if (signal.aborted) throw new Error("sweep aborted before DELETE");
    await remove();
  }, lifecycle.signal);

  const timerRun = invoker.invoke();
  await requestStarted;
  const toolRun = invoker.invoke(tool.signal);
  expect(toolRun).toBe(timerRun);
  tool.abort(new Error("user cancelled tool"));
  releaseRequest();
  await expect(timerRun).rejects.toThrow("sweep aborted before DELETE");
  expect(remove).not.toHaveBeenCalled();
  await invoker.wait();
});
