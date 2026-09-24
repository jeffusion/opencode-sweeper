import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { hasVerifiedPackagePlugin, runV2AutoUpdate } from "../src/auto-update-v2.js";

const PACKAGE = "opencode-sweeper";
const VERSION = "999.0.0";
const sourceProof = async () => `${PACKAGE}@1.0.0`;

async function fixture(t: { after: (fn: () => void) => void }, global = false) {
  const root = await mkdtemp(join(tmpdir(), "sweeper-auto-update-"));
  const home = join(root, "home");
  const location = join(root, "project");
  await mkdir(join(location, ".git"), { recursive: true });
  const config = global
    ? join(home, ".config", "opencode", "opencode.json")
    : join(location, "opencode.jsonc");
  await mkdir(join(config, ".."), { recursive: true });
  const env = { XDG_CONFIG_HOME: join(home, ".config") };
  await writeFile(config, JSON.stringify({ plugins: [`${PACKAGE}@1.0.0`] }));
  t.after(() => {
    void rm(root, { recursive: true, force: true });
  });
  return { root, home, location, config, env };
}

function fakeResponse(payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers });
}

const fetchPayload =
  (payload: unknown): typeof fetch =>
  async (url, options) => {
    assert.equal(url, `https://registry.npmjs.org/${PACKAGE}/latest`);
    assert.equal(options?.redirect, "error");
    return fakeResponse(payload);
  };

test("plugin.list requires exact location and one active server package with a safe target", () => {
  const location = "/tmp/project";
  const plugin = {
    id: PACKAGE,
    source: { type: "package", target: `${PACKAGE}@1.2.3` },
    features: { server: true },
    state: { status: "active" },
  };
  const result = (data: unknown[]) => ({ location: { directory: location }, data });
  assert.equal(hasVerifiedPackagePlugin(result([plugin]), location), `${PACKAGE}@1.2.3`);
  assert.equal(
    hasVerifiedPackagePlugin(
      result([{ ...plugin, source: { type: "package", target: PACKAGE } }]),
      location,
    ),
    PACKAGE,
  );
  assert.equal(
    hasVerifiedPackagePlugin(
      result([{ ...plugin, source: { type: "package", target: `${PACKAGE}@latest` } }]),
      location,
    ),
    `${PACKAGE}@latest`,
  );
  for (const invalid of [
    result([{ ...plugin, source: { type: "local", path: "/local" } }]),
    result([{ ...plugin, source: { type: "package", target: `${PACKAGE}@1.2.3-beta.1` } }]),
    result([{ ...plugin, state: { status: "failed" } }]),
    result([{ ...plugin, features: {} }]),
    result([plugin, plugin]),
    { data: [plugin] },
    { location: { directory: "/other" }, data: [plugin] },
    [plugin],
  ])
    assert.equal(hasVerifiedPackagePlugin(invalid, location), false);
});

test("updates the exact discovered object entry, preserving options and logging restart guidance", async (t) => {
  const f = await fixture(t, true);
  const entry = { package: `${PACKAGE}@1.0.0`, options: { dryRun: true } };
  await writeFile(f.config, JSON.stringify({ plugins: [entry] }, null, 2));
  const messages: string[] = [];
  assert.equal(
    await runV2AutoUpdate(f.location, {
      env: f.env,
      home: f.home,
      sourceCheck: sourceProof,
      fetch: fetchPayload({ name: PACKAGE, version: VERSION }),
      log: (message) => messages.push(message),
    }),
    true,
  );
  assert.deepEqual(JSON.parse(await readFile(f.config, "utf8")), {
    plugins: [{ package: `${PACKAGE}@${VERSION}`, options: { dryRun: true } }],
  });
  assert.deepEqual(messages, ["[opencode-sweeper] 已更新配置，重启生效。"]);
});

test("bare/latest string and object targets update only when source matches exactly", async (t) => {
  const f = await fixture(t);
  for (const entry of [
    `${PACKAGE}@latest`,
    { package: `${PACKAGE}@latest`, options: { dryRun: true } },
  ] as const) {
    await writeFile(f.config, JSON.stringify({ plugins: [entry] }));
    assert.equal(
      await runV2AutoUpdate(f.location, {
        env: f.env,
        home: f.home,
        sourceCheck: async () => `${PACKAGE}@latest`,
        fetch: fetchPayload({ name: PACKAGE, version: VERSION }),
        log: () => {},
      }),
      true,
    );
  }
});

test("missing, local, ambiguous, or mismatched source does not access registry", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const fetch = (async () => {
    calls++;
    throw new Error("unexpected network");
  }) as typeof globalThis.fetch;
  assert.equal(
    await runV2AutoUpdate(f.location, {
      sourceCheck: async () => false,
      env: f.env,
      home: f.home,
      fetch,
    }),
    false,
  );
  assert.equal(
    await runV2AutoUpdate(f.location, {
      sourceCheck: async () => `${PACKAGE}@1.1.0`,
      env: f.env,
      home: f.home,
      fetch,
    }),
    false,
  );
  assert.equal(calls, 0);
  await writeFile(f.config, JSON.stringify({ plugins: [`${PACKAGE}@1.0.0`, `${PACKAGE}@2.0.0`] }));
  assert.equal(
    await runV2AutoUpdate(f.location, {
      sourceCheck: sourceProof,
      env: f.env,
      home: f.home,
      fetch,
    }),
    false,
  );
  assert.equal(calls, 0);
});

test("network errors, bad payloads, running/pinned versions, and oversized bodies fail closed", async (t) => {
  const f = await fixture(t);
  for (const fetch of [
    (async () => {
      throw new Error("network");
    }) as typeof globalThis.fetch,
    fetchPayload({ name: "wrong", version: VERSION }),
    fetchPayload({ name: PACKAGE, version: "1.2.3-beta.1" }),
    fetchPayload({ name: PACKAGE, version: "0.1.0" }),
    (async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-length": "70000" },
      })) as typeof globalThis.fetch,
  ])
    assert.equal(
      await runV2AutoUpdate(f.location, {
        env: f.env,
        home: f.home,
        sourceCheck: sourceProof,
        fetch,
      }),
      false,
    );
});

test(
  "hard timeout covers hanging fetch and body, including late responses",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    let updates = 0;
    const update = (async () => {
      updates++;
      return true;
    }) as Parameters<typeof runV2AutoUpdate>[1]["update"];
    const options = { env: f.env, home: f.home, sourceCheck: sourceProof, update };
    assert.equal(
      await runV2AutoUpdate(f.location, {
        ...options,
        fetch: (() => new Promise(() => {})) as typeof fetch,
      }),
      false,
    );
    let canceled = false;
    const bodyFetch = (async () =>
      new Response(
        new ReadableStream({
          pull() {},
          cancel() {
            canceled = true;
          },
        }),
      )) as typeof fetch;
    assert.equal(await runV2AutoUpdate(f.location, { ...options, fetch: bodyFetch }), false);
    assert.equal(canceled, true);
    assert.equal(updates, 0);
  },
);

test("rechecks source and target after network and under writer lock validation", async (t) => {
  const f = await fixture(t);
  let resolveFetch!: (response: Response) => void;
  const pending = runV2AutoUpdate(f.location, {
    env: f.env,
    home: f.home,
    sourceCheck: sourceProof,
    fetch: (() =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      })) as typeof fetch,
  });
  while (!resolveFetch) await new Promise((resolve) => setImmediate(resolve));
  await writeFile(f.config, JSON.stringify({ plugins: [`${PACKAGE}@2.0.0`] }));
  resolveFetch(fakeResponse({ name: PACKAGE, version: VERSION }));
  assert.equal(await pending, false);

  let validationRan = false;
  const update = async (
    _path: string,
    _entry: string | { package: string },
    _version: string,
    opts: { validate?: () => Promise<boolean> },
  ) => {
    validationRan = true;
    return (await opts.validate?.()) ?? false;
  };
  await writeFile(f.config, JSON.stringify({ plugins: [`${PACKAGE}@1.0.0`] }));
  assert.equal(
    await runV2AutoUpdate(f.location, {
      env: f.env,
      home: f.home,
      sourceCheck: sourceProof,
      fetch: fetchPayload({ name: PACKAGE, version: VERSION }),
      update,
    }),
    true,
  );
  assert.equal(validationRan, true);
});

test("abort prevents network or writing", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  let resolveFetch!: (response: Response) => void;
  const pending = runV2AutoUpdate(f.location, {
    env: f.env,
    home: f.home,
    signal: controller.signal,
    sourceCheck: sourceProof,
    fetch: (() =>
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      })) as typeof fetch,
  });
  while (!resolveFetch) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  resolveFetch(fakeResponse({ name: PACKAGE, version: VERSION }));
  assert.equal(await pending, false);
});

test("abort interrupts a pending source check and consumes its late rejection", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  let rejectSource!: (error: Error) => void;
  let fetchCalls = 0;
  const pending = runV2AutoUpdate(f.location, {
    env: f.env,
    home: f.home,
    signal: controller.signal,
    sourceCheck: () =>
      new Promise<string | false>((_resolve, reject) => {
        rejectSource = reject;
      }),
    fetch: (async () => {
      fetchCalls += 1;
      return fakeResponse({ name: PACKAGE, version: VERSION });
    }) as typeof fetch,
  });
  while (!rejectSource) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.equal(await pending, false);
  rejectSource(new Error("late source failure"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls, 0);
});

test("a committed writer result remains successful if abort follows validation", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const messages: string[] = [];
  let validationCalls = 0;
  const update: NonNullable<Parameters<typeof runV2AutoUpdate>[1]["update"]> = async (
    _path,
    _entry,
    _version,
    options,
  ) => {
    assert.equal(options.signal, controller.signal);
    assert.equal(await options.validate?.(), true);
    validationCalls += 1;
    controller.abort();
    return true;
  };
  assert.equal(
    await runV2AutoUpdate(f.location, {
      env: f.env,
      home: f.home,
      sourceCheck: sourceProof,
      signal: controller.signal,
      fetch: fetchPayload({ name: PACKAGE, version: VERSION }),
      update,
      log: (message) => messages.push(message),
    }),
    true,
  );
  assert.equal(validationCalls, 1);
  assert.deepEqual(messages, ["[opencode-sweeper] 已更新配置，重启生效。"]);
});
