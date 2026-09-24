import { expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LOCK_NAME,
  ensureSafeDirectory,
  parseConfig,
  replaceConfigValue,
  safeDirectory,
  safeFile,
  sameSnapshot,
  snapshot,
  withConfigLock,
  writeExisting,
  writeNew,
} from "../src/config-file.js";

async function tempDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), "sweeper-config-"));
}

test("JSONC edits preserve comments, CRLF, and existing formatting", () => {
  const source = '{\r\n  // keep this comment\r\n  "plugins": ["old"],\r\n}\r\n';
  const result = replaceConfigValue(source, ["plugins", 0], "new");
  expect(result).not.toBeNull();
  expect(result).toContain("// keep this comment");
  expect(result).toContain("\r\n");
  if (result === null) throw new Error("expected modified config");
  expect(parseConfig(result)).toEqual({ plugins: ["new"] });
});

test("config parsing rejects duplicate keys and malformed JSONC", () => {
  expect(parseConfig('{"a": 1, "a": 2}')).toBeNull();
  expect(parseConfig('{"a":')).toBeNull();
});

test("safe file and directory reject symlinks and relative paths", async () => {
  const directory = await tempDirectory();
  try {
    const target = join(directory, "target.json");
    const alias = join(directory, "alias.json");
    await writeFile(target, "{}");
    await symlink(target, alias);
    expect(await safeFile(alias)).toBeNull();
    expect(await safeFile("relative.json")).toBeNull();
    expect(await safeDirectory(directory)).toBe(directory);
    expect(await safeDirectory("relative")).toBeNull();
    expect(await ensureSafeDirectory(join(directory, "nested"))).toBe(join(directory, "nested"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("new-file creation is exclusive under competition", async () => {
  const directory = await tempDirectory();
  try {
    const path = join(directory, "new.json");
    const results = await Promise.all([writeNew(path, "one"), writeNew(path, "two")]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(["one", "two"]).toContain(await readFile(path, "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("config lock excludes a concurrent task and removes its lock", async () => {
  const directory = await tempDirectory();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const first = withConfigLock(directory, async () => {
      await waiting;
      return true;
    });
    // Let the first operation create its lock before checking contention.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await lstat(join(directory, LOCK_NAME));
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    }
    expect(await withConfigLock(directory, async () => true)).toBe(false);
    release();
    expect(await first).toBe(true);
    await expect(lstat(join(directory, LOCK_NAME))).rejects.toThrow();
  } finally {
    release();
    await rm(directory, { recursive: true, force: true });
  }
});

test("separate processes contend for the config lock without deleting the winner lock", async () => {
  const directory = await tempDirectory();
  const configPath = join(directory, "config.jsonc");
  const modulePath = fileURLToPath(new URL("../src/config-file.ts", import.meta.url));
  const childScript = `
    import { lstat, writeFile } from "node:fs/promises";
    const { withConfigLock } = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
    const directory = process.argv[1];
    const mode = process.argv[2];
    if (mode === "holder") {
      const acquired = await withConfigLock(directory, async () => {
        await writeFile(directory + "/config.jsonc", '{\\n  // keep this comment\\n  "dryRun": true,\\n  "protect": ["stable"],\\n}\\n');
        process.stdout.write("locked\\n");
        await new Promise((resolve) => process.stdin.once("data", resolve));
        return true;
      });
      process.stdout.write(JSON.stringify({ acquired }) + "\\n");
    } else {
      const acquired = await withConfigLock(directory, async () => {
        await writeFile(directory + "/unexpected", "not allowed");
        return true;
      });
      let winnerLockExists = true;
      try { await lstat(directory + "/.opencode-sweeper.update.lock"); }
      catch { winnerLockExists = false; }
      process.stdout.write(JSON.stringify({ acquired, winnerLockExists }) + "\\n");
    }
  `;
  let holder: ChildProcess | undefined;
  let contender: ChildProcess | undefined;
  const startChild = (mode: string) =>
    spawn(process.execPath, ["-e", childScript, directory, mode], {
      stdio: ["pipe", "pipe", "pipe"],
    });
  const firstOutputLine = (child: ChildProcess) =>
    new Promise<string>((resolve, reject) => {
      let output = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const newline = output.indexOf("\n");
        if (newline !== -1) resolve(output.slice(0, newline));
      });
      child.stderr?.on("data", (chunk: Buffer) => reject(new Error(chunk.toString())));
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code !== 0) reject(new Error(`child exited with code ${code}: ${output}`));
      });
    });
  const waitForExit = (child: ChildProcess) =>
    child.exitCode !== null
      ? Promise.resolve(child.exitCode)
      : new Promise<number | null>((resolve) => child.once("exit", resolve));

  try {
    holder = startChild("holder");
    expect(await firstOutputLine(holder)).toBe("locked");

    contender = startChild("contender");
    const contention = JSON.parse(await firstOutputLine(contender)) as {
      acquired: boolean;
      winnerLockExists: boolean;
    };
    expect(contention).toEqual({ acquired: false, winnerLockExists: true });
    expect(await readFile(configPath, "utf8")).toContain('"dryRun": true');
    expect(await readFile(join(directory, "unexpected"), "utf8").catch(() => null)).toBeNull();

    holder.stdin?.end("continue\n");
    const result = JSON.parse(await firstOutputLine(holder)) as { acquired: boolean };
    expect(result.acquired).toBe(true);
    const content = await readFile(configPath, "utf8");
    expect(parseConfig(content)).toEqual({ dryRun: true, protect: ["stable"] });
    expect(content).toContain("// keep this comment");
    await expect(lstat(join(directory, LOCK_NAME))).rejects.toThrow();
    expect(await waitForExit(holder)).toBe(0);
    expect(await waitForExit(contender)).toBe(0);
  } finally {
    holder?.kill();
    contender?.kill();
    await rm(directory, { recursive: true, force: true });
  }
});

test("config lock is released when its task throws", async () => {
  const directory = await tempDirectory();
  try {
    await expect(
      withConfigLock(directory, async () => {
        throw new Error("task failed");
      }),
    ).rejects.toThrow("task failed");
    await expect(lstat(join(directory, LOCK_NAME))).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("existing-file writes detect external modifications and preserve mode", async () => {
  const directory = await tempDirectory();
  try {
    const path = join(directory, "config.json");
    await writeFile(path, '{"old":true}', { mode: 0o640 });
    const initial = await snapshot(path);
    expect(initial).not.toBeNull();
    if (initial === null) throw new Error("expected initial snapshot");
    await writeFile(path, '{"outside":true}');
    expect(sameSnapshot(initial, await snapshot(path))).toBe(false);
    expect(await writeExisting(path, initial, '{"new":true}')).toBe(false);

    const current = await snapshot(path);
    expect(current).not.toBeNull();
    if (current === null) throw new Error("expected current snapshot");
    expect(await writeExisting(path, current, '{"new":true}')).toBe(true);
    expect(await readFile(path, "utf8")).toBe('{"new":true}');
    expect((await lstat(path)).mode & 0o777).toBe(0o640);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("existing-file writes honor an already-aborted signal without changing bytes", async () => {
  const directory = await tempDirectory();
  try {
    const path = join(directory, "config.json");
    const original = '{"old":true}';
    await writeFile(path, original);
    const expected = await snapshot(path);
    expect(expected).not.toBeNull();
    if (expected === null) throw new Error("expected initial snapshot");

    const controller = new AbortController();
    controller.abort();
    expect(await writeExisting(path, expected, '{"new":true}', controller.signal)).toBe(false);
    expect(await readFile(path, "utf8")).toBe(original);
    expect((await readdir(directory)).some((name) => name.endsWith(".tmp"))).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("read-only file mode is rejected", async () => {
  const directory = await tempDirectory();
  try {
    const path = join(directory, "read-only.json");
    await writeFile(path, "{}");
    await chmod(path, 0o444);
    expect(await safeFile(path, true)).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("directory creation rejects symlinked parent directories", async () => {
  const directory = await tempDirectory();
  try {
    const outside = join(directory, "outside");
    const alias = join(directory, "alias");
    await mkdir(outside);
    await symlink(outside, alias);
    expect(await ensureSafeDirectory(join(alias, "child"))).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
