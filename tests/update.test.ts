import { expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PACKAGE_NAME, REGISTRY_URL, createVersionUpdater } from "../src/update.js";

const RUNNING_VERSION = "0.1.1";
const LATEST_VERSION = "0.2.0";

async function withTempRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "opencode-sweeper-update-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runtimeConfig(file: string, entry: unknown = PACKAGE_NAME): Record<string, unknown> {
  return {
    plugin: [entry],
    plugin_origins: [{ spec: entry, source: file, scope: "local" }],
  };
}

function registryResponse(name = PACKAGE_NAME, version = LATEST_VERSION): Response {
  return new Response(JSON.stringify({ name, version }), { status: 200 });
}

function updater(options: Parameters<typeof createVersionUpdater>[0] = {}) {
  return createVersionUpdater({ version: RUNNING_VERSION, ...options });
}

test("只替换 plugin spec，并保留 JSONC 注释与 tuple options", async () => {
  await withTempRoot(async (root) => {
    const file = join(root, "opencode.jsonc");
    const entry = [PACKAGE_NAME, { enabled: false, profile: "keep" }];
    const newline = "\r\n";
    const original =
      [
        "{",
        "  // keep comment",
        `  "plugin": [["${PACKAGE_NAME}", { "enabled": false, "profile": "keep" }]],`,
        '  "other": true',
        "}",
      ].join(newline) + newline;
    await writeFile(file, original);
    let requestedUrl = "";
    const onWrite = mock(() => undefined);
    const fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      expect(init?.redirect).toBe("error");
      return registryResponse();
    });
    const update = updater({ fetch, onWrite });
    const onSuccess = mock(() => undefined);

    expect(await update(runtimeConfig(file, entry), { onSuccess })).toBe(true);
    expect(requestedUrl).toBe(REGISTRY_URL);
    expect(onWrite).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledWith(LATEST_VERSION);
    const changed = await readFile(file, "utf8");
    expect(changed).toContain("// keep comment");
    expect(changed).toContain('"profile": "keep"');
    expect(changed).toBe(
      original.replace(`"${PACKAGE_NAME}"`, `"${PACKAGE_NAME}@${LATEST_VERSION}"`),
    );
  });
});

test("ambiguous or malformed runtime origins are rejected before registry access", async () => {
  await withTempRoot(async (root) => {
    const file = join(root, "config.json");
    await writeFile(file, JSON.stringify({ plugin: [PACKAGE_NAME] }));
    const fetch = mock(async () => registryResponse());
    const update = updater({ fetch });
    const valid = runtimeConfig(file);
    const origins = valid.plugin_origins as unknown[];

    expect(await update({ plugin: [PACKAGE_NAME] })).toBe(false);
    expect(await update({ ...valid, plugin: [PACKAGE_NAME, PACKAGE_NAME] })).toBe(false);
    expect(await update({ ...valid, plugin_origins: [] })).toBe(false);
    expect(await update({ ...valid, plugin_origins: [...origins, ...origins] })).toBe(false);
    expect(
      await update({
        ...valid,
        plugin_origins: [
          { spec: PACKAGE_NAME, source: "https://example.invalid/config", scope: "local" },
        ],
      }),
    ).toBe(false);
    expect(
      await update({
        ...valid,
        plugin_origins: [{ spec: PACKAGE_NAME, source: file, scope: "invalid" }],
      }),
    ).toBe(false);

    const duplicateKey = join(root, "duplicate.json");
    await writeFile(duplicateKey, `{"plugin":["${PACKAGE_NAME}"],"plugin":["${PACKAGE_NAME}"]}`);
    expect(await update(runtimeConfig(duplicateKey))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

test("future pins and invalid registry responses never modify config", async () => {
  await withTempRoot(async (root) => {
    const file = join(root, "config.json");
    const futurePin = `${PACKAGE_NAME}@0.3.0`;
    const original = JSON.stringify({ plugin: [futurePin] });
    await writeFile(file, original);
    expect(
      await updater({ fetch: async () => registryResponse() })(runtimeConfig(file, futurePin)),
    ).toBe(false);

    const responses = [
      registryResponse("other-package", LATEST_VERSION),
      registryResponse(PACKAGE_NAME, "0.2.0-beta.1"),
      registryResponse(PACKAGE_NAME, "9007199254740992.0.0"),
      new Response("unavailable", { status: 503 }),
    ];
    for (const response of responses) {
      const packageEntry = JSON.stringify({ plugin: [PACKAGE_NAME] });
      await writeFile(file, packageEntry);
      const fetch = mock(async () => response);
      expect(await updater({ fetch })(runtimeConfig(file, PACKAGE_NAME))).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(await readFile(file, "utf8")).toBe(packageEntry);
    }
  });
});

test("accepts the latest tag and rejects range specs before fetching", async () => {
  await withTempRoot(async (root) => {
    const file = join(root, "config.json");
    const latestTag = `${PACKAGE_NAME}@latest`;
    await writeFile(file, JSON.stringify({ plugin: [latestTag] }));
    const fetchLatest = mock(async () => registryResponse());
    expect(await updater({ fetch: fetchLatest })(runtimeConfig(file, latestTag))).toBe(true);
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    expect(await readFile(file, "utf8")).toContain(`${PACKAGE_NAME}@${LATEST_VERSION}`);

    const range = `${PACKAGE_NAME}@^0.1.1`;
    await writeFile(file, JSON.stringify({ plugin: [range] }));
    const fetchRange = mock(async () => registryResponse());
    expect(await updater({ fetch: fetchRange })(runtimeConfig(file, range))).toBe(false);
    expect(fetchRange).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe(JSON.stringify({ plugin: [range] }));
  });
});

test("registry timeout and oversized response fail closed", async () => {
  await withTempRoot(async (root) => {
    const file = join(root, "config.json");
    const original = JSON.stringify({ plugin: [PACKAGE_NAME] });
    await writeFile(file, original);
    let aborted = false;
    const timeout = updater({
      timeoutMs: 5,
      fetch: async (_input, init) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
        });
        return new Promise<Response>(() => undefined);
      },
    });
    expect(await timeout(runtimeConfig(file))).toBe(false);
    expect(aborted).toBe(true);

    const oversized = updater({
      fetch: async () => new Response(new Uint8Array(64 * 1024 + 1)),
    });
    expect(await oversized(runtimeConfig(file))).toBe(false);
    expect(await readFile(file, "utf8")).toBe(original);
  });
});

test("global source must resolve to one unique config file", async () => {
  await withTempRoot(async (root) => {
    const globalDir = join(root, "global");
    await mkdir(globalDir);
    const file = join(globalDir, "config.json");
    await writeFile(file, JSON.stringify({ plugin: [PACKAGE_NAME] }));
    const globalConfig = {
      plugin: [PACKAGE_NAME],
      plugin_origins: [{ spec: PACKAGE_NAME, source: globalDir, scope: "global" }],
    };
    expect(await updater({ fetch: async () => registryResponse() })(globalConfig)).toBe(true);
    expect(await readFile(file, "utf8")).toContain(`${PACKAGE_NAME}@${LATEST_VERSION}`);

    await writeFile(file, JSON.stringify({ plugin: [PACKAGE_NAME] }));
    await writeFile(join(globalDir, "opencode.json"), JSON.stringify({ plugin: [PACKAGE_NAME] }));
    const fetch = mock(async () => registryResponse());
    expect(await updater({ fetch })(globalConfig)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

test("global source is re-resolved under lock after registry I/O", async () => {
  const candidates = [
    [PACKAGE_NAME, { dryRun: true, protect: ["keep"] }],
    [`${PACKAGE_NAME}@9.0.0`, { dryRun: true, protect: ["keep"] }],
    [PACKAGE_NAME, { dryRun: false, protect: ["other"] }],
  ];
  for (const [index, candidate] of candidates.entries()) {
    await withTempRoot(async (root) => {
      const globalDir = join(root, "global");
      await mkdir(globalDir);
      const originalFile = join(globalDir, "config.json");
      const secondFile = join(globalDir, "opencode.json");
      const original = JSON.stringify({ plugin: [PACKAGE_NAME], keep: true });
      const candidateContent = JSON.stringify({ plugin: [candidate] });
      await writeFile(originalFile, original);
      const globalConfig = {
        plugin: [PACKAGE_NAME],
        plugin_origins: [{ spec: PACKAGE_NAME, source: globalDir, scope: "global" }],
      };
      const fetch = mock(async () => {
        await writeFile(secondFile, candidateContent);
        return registryResponse();
      });

      expect(await updater({ fetch })(globalConfig), `candidate ${index}`).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(await readFile(originalFile, "utf8")).toBe(original);
      expect(await readFile(secondFile, "utf8")).toBe(candidateContent);
    });
  }
});

test("concurrent writes deduplicate; changes during fetch are preserved", async () => {
  await withTempRoot(async (root) => {
    const file = join(root, "config.json");
    const original = JSON.stringify({ plugin: [PACKAGE_NAME], keep: true }, null, 2);
    await writeFile(file, original);
    const fetch = mock(async () => registryResponse());
    const onWrite = mock(() => undefined);
    const update = updater({ fetch, onWrite });
    expect(await Promise.all([update(runtimeConfig(file)), update(runtimeConfig(file))])).toEqual([
      true,
      true,
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onWrite).toHaveBeenCalledTimes(1);

    await writeFile(file, original);
    const external = JSON.stringify({ plugin: [PACKAGE_NAME], keep: "external" });
    const changed = updater({
      fetch: async () => {
        await writeFile(file, external);
        return registryResponse();
      },
    });
    expect(await changed(runtimeConfig(file))).toBe(false);
    expect(await readFile(file, "utf8")).toBe(external);
  });
});

test("different updater instances serialize concurrent writes safely", async () => {
  await withTempRoot(async (root) => {
    const file = join(root, "config.json");
    const original = JSON.stringify({ plugin: [PACKAGE_NAME] });
    await writeFile(file, original);
    let releaseFetch = () => {};
    let markBothStarted = () => {};
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const bothStarted = new Promise<void>((resolve) => {
      markBothStarted = resolve;
    });
    let calls = 0;
    const fetch = mock(async () => {
      calls += 1;
      if (calls === 2) markBothStarted();
      await fetchGate;
      return registryResponse();
    });
    const writes = mock(() => undefined);
    const first = updater({ fetch, onWrite: writes });
    const second = updater({ fetch, onWrite: writes });
    const results = [first(runtimeConfig(file)), second(runtimeConfig(file))];
    await bothStarted;
    releaseFetch();
    const outcomes = await Promise.all(results);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(calls).toBe(2);
    expect(writes).toHaveBeenCalledTimes(1);
    expect(await readFile(file, "utf8")).toBe(
      JSON.stringify({ plugin: [`${PACKAGE_NAME}@${LATEST_VERSION}`] }),
    );
  });
});
