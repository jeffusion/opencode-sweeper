import { afterEach, describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { run } from "../src/cli.js";
import type { CodexRpcClient } from "../src/codex-rpc.js";
import { LOCK_NAME, parseConfig } from "../src/config-file.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };
const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opencode-sweeper-cli-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function streams() {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write: (text: string) => {
        stdout += text;
      },
    },
    stderr: {
      write: (text: string) => {
        stderr += text;
      },
    },
    text: () => ({ stdout, stderr }),
  };
}

async function invoke(root: string, args = ["install"]) {
  const output = streams();
  const code = await run({
    args,
    env: { ...process.env, XDG_CONFIG_HOME: join(root, "xdg") },
    ...output,
  });
  return { code, ...output.text() };
}

async function setupConfig(root: string, filename: string, content: string) {
  const directory = join(root, "xdg", "opencode");
  await mkdir(directory, { recursive: true });
  const path = join(directory, filename);
  await writeFile(path, content);
  return { directory, path };
}

function parsed(content: string): Record<string, unknown> {
  const value = parseConfig(content);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid test config");
  }
  return value as Record<string, unknown>;
}

describe("sweeper install CLI", () => {
  it("supports help and version without creating config", async () => {
    const root = await tempRoot();
    const help = await invoke(root, ["--help"]);
    const version = await invoke(root, ["--version"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: opencode-sweeper install");
    expect(version.code).toBe(0);
    expect(version.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    await expect(lstat(join(root, "xdg", "opencode"))).rejects.toThrow();
  });

  it("runs through a symlinked executable entry", async () => {
    const root = await tempRoot();
    const link = join(root, "sweeper");
    await symlink(resolve("src/cli.ts"), link);
    const env = { ...process.env, XDG_CONFIG_HOME: join(root, "xdg") };
    const help = await execFileAsync(process.execPath, [link, "--help"], { env });
    const current = await execFileAsync(process.execPath, [link, "--version"], { env });
    const installed = await execFileAsync(process.execPath, [link, "install"], { env });

    expect(help.stdout).toContain("Usage: opencode-sweeper install");
    expect(current.stdout).toBe(`${version}\n`);
    expect(installed.stdout).toContain("Registered");
    expect(
      parsed(await readFile(join(root, "xdg", "opencode", "opencode.json"), "utf8")).plugin,
    ).toEqual([`opencode-sweeper@${version}`]);
  });

  it("defaults to v1, writes the exact package version, warns about safe defaults, and is idempotent", async () => {
    const root = await tempRoot();
    const first = await invoke(root);
    const file = join(root, "xdg", "opencode", "opencode.json");
    const content = await readFile(file, "utf8");
    const before = await stat(file);
    const plugin = parsed(content).plugin as unknown[];

    expect(first.code).toBe(0);
    expect(plugin).toEqual([`opencode-sweeper@${version}`]);
    expect(first.stdout).toContain("dryRun=false");
    expect(first.stdout).toContain("interval=1h");
    expect(first.stdout).toContain("Before starting OpenCode");

    const second = await invoke(root);
    const after = await stat(file);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("Already registered");
    expect(await readFile(file, "utf8")).toBe(content);
    expect(after.ino).toBe(before.ino);
  });

  it("creates V2 package/options entries when explicitly selected", async () => {
    const root = await tempRoot();
    const result = await invoke(root, ["install", "--format", "v2"]);
    const config = parsed(await readFile(join(root, "xdg", "opencode", "opencode.json"), "utf8"));

    expect(result.code).toBe(0);
    expect(config.plugins).toEqual([{ package: `opencode-sweeper@${version}`, options: {} }]);
    expect(config.plugin).toBeUndefined();
  });

  it("updates only the V2 package spec, preserving safe options, comments and CRLF", async () => {
    const root = await tempRoot();
    const original =
      '{"plugins":[{"package":"opencode-sweeper@0.1.0","options":{"dryRun":true,"interval":0,"protect":["ses_keep"],"expiry":"30d"}}],\r\n// keep this comment\r\n"other":true}\r\n';
    const { path } = await setupConfig(root, "opencode.jsonc", original);
    const result = await invoke(root);
    const changed = await readFile(path, "utf8");
    const entry = (parsed(changed).plugins as Array<Record<string, unknown>>)[0];

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Existing options were preserved unchanged");
    expect(result.stdout).not.toContain("disabled");
    expect(changed).toContain("\r\n");
    expect(changed).toContain("// keep this comment");
    expect(entry).toEqual({
      package: `opencode-sweeper@${version}`,
      options: { dryRun: true, interval: 0, protect: ["ses_keep"], expiry: "30d" },
    });
    const beforeParsed = parsed(original);
    const expectedPlugins = beforeParsed.plugins as Array<Record<string, unknown>>;
    const expectedEntry = expectedPlugins[0];
    if (!expectedEntry) throw new Error("missing fixture plugin entry");
    expectedEntry.package = `opencode-sweeper@${version}`;
    expect(parsed(changed)).toEqual(beforeParsed);
  });

  it("updates V1 tuples in place and preserves options", async () => {
    const root = await tempRoot();
    const { path } = await setupConfig(
      root,
      "opencode.json",
      JSON.stringify({
        plugin: [
          [
            "opencode-sweeper@0.1.0",
            { dryRun: true, interval: 0, protect: ["ses_keep"], expiry: "30d" },
          ],
        ],
      }),
    );
    const result = await invoke(root);
    const entries = parsed(await readFile(path, "utf8")).plugin;

    expect(result.code).toBe(0);
    expect(entries).toEqual([
      [
        `opencode-sweeper@${version}`,
        { dryRun: true, interval: 0, protect: ["ses_keep"], expiry: "30d" },
      ],
    ]);
    expect(result.stdout).toContain("Existing options were preserved unchanged");
    expect(result.stdout).not.toContain("disabled");
  });

  it("does not downgrade a higher exact version pin", async () => {
    const root = await tempRoot();
    const { path } = await setupConfig(
      root,
      "opencode.json",
      JSON.stringify({ plugin: ["opencode-sweeper@9.0.0"] }),
    );
    const before = await readFile(path, "utf8");
    const result = await invoke(root);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Already registered opencode-sweeper@9.0.0");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("rejects duplicates, format conflicts, opaque specs and mismatched entry shapes without writing", async () => {
    const configs = [
      { plugin: [], plugins: [] },
      { plugin: ["opencode-sweeper@0.1.0", "opencode-sweeper@0.2.0"] },
      { plugin: ["opencode-sweeper@0.1.0"], plugins: ["other"] },
      { plugin: [{ package: "opencode-sweeper@0.1.0", options: {} }] },
      { plugins: [["opencode-sweeper@0.1.0", {}]] },
      { plugins: ["file:///private/custom-plugin"] },
      { plugins: ["opencode-sweeper@latest"] },
      { plugins: ["opencode-sweeper@^1.0.0"] },
      { plugin: ["opencode-sweeper@latest"] },
      { plugin: ["opencode-sweeper@^1.0.0"] },
    ];
    for (const config of configs) {
      const root = await tempRoot();
      const original = JSON.stringify(config);
      const { path } = await setupConfig(root, "opencode.json", original);
      const result = await invoke(root);
      expect(result.code).toBe(1);
      expect(await readFile(path, "utf8")).toBe(original);
    }
  });

  it("honors the existing format and rejects an explicit format conflict", async () => {
    const root = await tempRoot();
    const { path } = await setupConfig(
      root,
      "opencode.json",
      JSON.stringify({ plugins: ["other"] }),
    );
    const before = await readFile(path, "utf8");
    const result = await invoke(root, ["install", "--format", "v1"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("conflicts with existing v2");
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("rejects V2 removal markers from every candidate file without re-enabling the package", async () => {
    for (const removal of ["-opencode-sweeper", "-opencode-sweeper@0.1.0", "-*"]) {
      const root = await tempRoot();
      const existing = await setupConfig(
        root,
        "opencode.json",
        JSON.stringify({
          plugins: [{ package: `opencode-sweeper@${version}`, options: { dryRun: true } }],
        }),
      );
      const removalFile = join(existing.directory, "opencode.jsonc");
      const removalText = JSON.stringify({ plugins: [removal] });
      await writeFile(removalFile, removalText);
      const ownText = await readFile(existing.path, "utf8");

      const result = await invoke(root);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain("explicitly removes opencode-sweeper");
      expect(await readFile(existing.path, "utf8")).toBe(ownText);
      expect(await readFile(removalFile, "utf8")).toBe(removalText);
    }
  });

  it("rejects mixed V2 add/remove entries and leaves the config bytes untouched", async () => {
    const root = await tempRoot();
    const original = JSON.stringify({
      plugins: ["opencode-sweeper@0.1.0", "-*", "another-plugin"],
    });
    const { path } = await setupConfig(root, "opencode.json", original);

    const result = await invoke(root);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("explicitly removes opencode-sweeper");
    expect(await readFile(path, "utf8")).toBe(original);
  });

  it("does not block V2 removal selectors that do not match this plugin", async () => {
    const root = await tempRoot();
    const original = JSON.stringify({ plugins: ["-other-plugin", "-owner.*"] });
    const { path } = await setupConfig(root, "opencode.json", original);

    const result = await invoke(root);
    const plugins = parsed(await readFile(path, "utf8")).plugins;

    expect(result.code).toBe(0);
    expect(plugins).toEqual([
      "-other-plugin",
      "-owner.*",
      { package: `opencode-sweeper@${version}`, options: {} },
    ]);
  });

  it("refuses multiple package sources across config files without writing either", async () => {
    const root = await tempRoot();
    const lowerPriority = await setupConfig(
      root,
      "config.json",
      JSON.stringify({ plugin: ["opencode-sweeper@0.1.0"] }),
    );
    const higherPriority = await setupConfig(
      root,
      "opencode.jsonc",
      JSON.stringify({ plugin: ["opencode-sweeper@0.1.0"] }),
    );
    const before = await Promise.all([
      readFile(lowerPriority.path, "utf8"),
      readFile(higherPriority.path, "utf8"),
    ]);
    const result = await invoke(root);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Multiple opencode-sweeper entries");
    expect(await readFile(lowerPriority.path, "utf8")).toBe(before[0]);
    expect(await readFile(higherPriority.path, "utf8")).toBe(before[1]);
  });

  it("updates a unique existing source and otherwise appends to the preferred config", async () => {
    const updateRoot = await tempRoot();
    const fallback = await setupConfig(
      updateRoot,
      "opencode.jsonc",
      JSON.stringify({ plugin: ["other"] }),
    );
    const unique = await setupConfig(
      updateRoot,
      "config.json",
      JSON.stringify({ plugin: ["opencode-sweeper@0.1.0"] }),
    );
    const updated = await invoke(updateRoot);

    expect(updated.code).toBe(0);
    expect(parsed(await readFile(unique.path, "utf8")).plugin).toEqual([
      `opencode-sweeper@${version}`,
    ]);
    expect(parsed(await readFile(fallback.path, "utf8")).plugin).toEqual(["other"]);

    const appendRoot = await tempRoot();
    const config = await setupConfig(
      appendRoot,
      "config.json",
      JSON.stringify({ plugin: ["legacy"] }),
    );
    const preferred = await setupConfig(appendRoot, "opencode.jsonc", '{ "plugin": ["jsonc"] }\n');
    const appended = await invoke(appendRoot);

    expect(appended.code).toBe(0);
    expect(parsed(await readFile(preferred.path, "utf8")).plugin).toEqual([
      "jsonc",
      `opencode-sweeper@${version}`,
    ]);
    expect(parsed(await readFile(config.path, "utf8")).plugin).toEqual(["legacy"]);
  });

  it("rejects invalid candidates and duplicate JSON keys before writing a valid candidate", async () => {
    const invalidConfigs = ["{", '{"plugin":[],"plugin":[]}\n'];
    for (const invalid of invalidConfigs) {
      const root = await tempRoot();
      const valid = await setupConfig(root, "opencode.json", JSON.stringify({ plugin: ["other"] }));
      const invalidPath = join(valid.directory, "opencode.jsonc");
      await writeFile(invalidPath, invalid);
      const before = await readFile(valid.path, "utf8");

      const result = await invoke(root);

      expect(result.code).toBe(1);
      expect(await readFile(valid.path, "utf8")).toBe(before);
      expect(await readFile(invalidPath, "utf8")).toBe(invalid);
    }
  });

  it("rejects symlink config files without writing through them", async () => {
    const root = await tempRoot();
    const { directory } = await setupConfig(root, "placeholder.json", "{}");
    const target = join(directory, "target.json");
    const linkedConfig = join(directory, "opencode.json");
    const content = JSON.stringify({ plugin: ["other"] });
    await writeFile(target, content);
    await symlink(target, linkedConfig);

    const result = await invoke(root);

    expect(result.code).toBe(1);
    expect(await readFile(target, "utf8")).toBe(content);
    await expect(lstat(linkedConfig)).resolves.toBeDefined();
  });

  it("refuses to proceed if the install lock is held", async () => {
    const root = await tempRoot();
    const { directory } = await setupConfig(root, "opencode.json", "{}");
    await mkdir(join(directory, LOCK_NAME));
    const result = await invoke(root);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("config is busy");
    expect(parsed(await readFile(join(directory, "opencode.json"), "utf8"))).toEqual({});
  });

  it("rejects unsafe XDG and symlinked configuration paths", async () => {
    const relative = streams();
    expect(
      await run({
        args: ["install"],
        env: { ...process.env, XDG_CONFIG_HOME: "relative/path" },
        ...relative,
      }),
    ).toBe(1);

    const root = await tempRoot();
    const target = join(root, "real-xdg");
    const link = join(root, "linked-xdg");
    await mkdir(target);
    await symlink(target, link);
    const symlinked = streams();
    expect(
      await run({
        args: ["install"],
        env: { ...process.env, XDG_CONFIG_HOME: link },
        ...symlinked,
      }),
    ).toBe(1);
  });

  it("rejects read-only config files without changing them", async () => {
    const root = await tempRoot();
    const { path } = await setupConfig(root, "opencode.json", "{}");
    const original = await readFile(path, "utf8");
    await chmod(path, 0o444);
    try {
      expect((await invoke(root)).code).toBe(1);
      expect(await readFile(path, "utf8")).toBe(original);
    } finally {
      await chmod(path, 0o644);
    }
  });
});

async function codexClient() {
  const home = await tempRoot();
  const id = "0190a000-0000-7000-8000-000000000001";
  const directory = join(home, "sessions");
  await mkdir(directory);
  const path = join(directory, `rollout-2025-04-10T12-34-56-${id}.jsonl`);
  await writeFile(path, "");
  const deleteRequests: string[] = [];
  const client: CodexRpcClient = {
    version: "0.163.0",
    codexHome: home,
    async request(method, params = {}) {
      if (method === "thread/loaded/list") return { data: [], nextCursor: null };
      if (method === "thread/list") {
        return { data: params.archived || deleteRequests.length ? [] : [{ id }], nextCursor: null };
      }
      if (method === "thread/read") {
        return {
          thread: {
            id,
            path,
            updatedAt: 1_700_000_000,
            parentThreadId: null,
            forkedFromId: null,
            status: { type: "notLoaded" },
          },
        };
      }
      if (method === "thread/delete") {
        deleteRequests.push(String(params.threadId));
        await rm(path);
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    },
    async close() {},
  };
  return { client, id, deleteRequests };
}

async function invokeCodex(
  args: string[],
  factory?: (env: NodeJS.ProcessEnv) => Promise<CodexRpcClient>,
) {
  const output = streams();
  const code = await run({
    args,
    env: { ...process.env },
    ...output,
    ...(factory === undefined ? {} : { codexClientFactory: factory }),
  });
  return { code, ...output.text() };
}

describe("codex CLI", () => {
  it("prints codex usage and version", async () => {
    const help = await invokeCodex(["codex", "--help"]);
    const current = await invokeCodex(["codex", "--version"]);

    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: opencode-sweeper codex");
    expect(current.code).toBe(0);
    expect(current.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("rejects unknown flags, positionals and invalid durations", async () => {
    let factoryCalls = 0;
    const factory = async (): Promise<CodexRpcClient> => {
      factoryCalls += 1;
      throw new Error("factory must not run");
    };
    const unknown = await invokeCodex(["codex", "--json"], factory);
    const positional = await invokeCodex(["codex", "extra"], factory);
    const duration = await invokeCodex(["codex", "--expiry", "not-a-duration"], factory);

    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("Usage: opencode-sweeper codex");
    expect(positional.code).toBe(1);
    expect(positional.stderr).toContain("Usage: opencode-sweeper codex");
    expect(duration.code).toBe(1);
    expect(duration.stderr).toContain("invalid duration");
    expect(factoryCalls).toBe(0);
  });

  for (const apply of [false, true]) {
    it(apply ? "routes --apply to deletion" : "routes codex to preview by default", async () => {
      const { client, id, deleteRequests } = await codexClient();
      const result = await invokeCodex(
        apply ? ["codex", "--apply"] : ["codex"],
        async () => client,
      );
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(deleteRequests).toEqual(apply ? [id] : []);
      expect(result.stdout).toContain(`${apply ? "[DELETED]" : "[DRY-RUN]"} ${id}`);
    });
  }

  it("returns non-zero when the Codex client cannot start", async () => {
    const result = await invokeCodex(["codex"], async () => {
      throw new Error("unavailable");
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unavailable");
  });

  it("returns non-zero for a completed sweep with errors", async () => {
    const { client } = await codexClient();
    const request = client.request.bind(client);
    client.request = async (method, params) => {
      if (method === "thread/read") {
        const response = (await request(method, params)) as { thread: { status: unknown } };
        response.thread.status = { type: "systemError" };
        return response;
      }
      return request(method, params);
    };
    const result = await invokeCodex(["codex"], async () => client);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("systemError");
  });
});
