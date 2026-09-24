import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { type JSONPath, type Node, applyEdits, modify, parse, parseTree } from "jsonc-parser";

export const CONFIG_FILES = ["config.json", "opencode.json", "opencode.jsonc"] as const;
export const LOCK_NAME = ".opencode-sweeper.update.lock";

export type Snapshot = { path: string; mode: number; stat: Stats; content: string };
export type PluginSpec = { spec: string; tuple: boolean };

export function stableVersion(value: unknown): [number, number, number] | null {
  if (typeof value !== "string") return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? (parts as [number, number, number]) : null;
}

export function compareVersions(left: string, right: string): -1 | 0 | 1 | null {
  const a = stableVersion(left);
  const b = stableVersion(right);
  if (!a || !b) return null;
  for (const index of [0, 1, 2] as const) {
    const leftPart = a[index];
    const rightPart = b[index];
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

export function pluginSpec(entry: unknown): PluginSpec | null {
  if (typeof entry === "string") return { spec: entry, tuple: false };
  if (Array.isArray(entry) && entry.length > 0 && typeof entry[0] === "string")
    return { spec: entry[0], tuple: true };
  return null;
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  return normalize(resolve(left)) === normalize(resolve(right));
}

export async function safeFile(
  path: string,
  writable = false,
): Promise<{ path: string; mode: number; stat: Stats } | null> {
  if (!isAbsolute(path)) return null;
  const requested = resolve(path);
  try {
    const entry = await lstat(requested);
    if (!entry.isFile() || entry.isSymbolicLink()) return null;
    if (!samePath(await realpath(requested), requested)) return null;
    if (writable && (entry.mode & 0o222) === 0) return null;
    return { path: requested, mode: entry.mode & 0o7777, stat: entry };
  } catch {
    return null;
  }
}

export async function safeDirectory(path: string): Promise<string | null> {
  if (!isAbsolute(path)) return null;
  const requested = resolve(path);
  try {
    const entry = await lstat(requested);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return null;
    if (!samePath(await realpath(requested), requested)) return null;
    return requested;
  } catch {
    return null;
  }
}

export function parseConfig(content: string): unknown | null {
  const errors: Parameters<typeof parse>[1] = [];
  const treeErrors: Parameters<typeof parseTree>[1] = [];
  const value: unknown = parse(content, errors, { allowTrailingComma: true });
  const tree = parseTree(content, treeErrors, { allowTrailingComma: true });
  if (
    !tree ||
    value === undefined ||
    [...errors, ...treeErrors].length > 0 ||
    hasDuplicateKeys(tree)
  )
    return null;
  return value;
}

function hasDuplicateKeys(node: Node | undefined): boolean {
  if (!node) return false;
  if (node.type === "object") {
    const keys = (node.children ?? []).map((property) => property.children?.[0]?.value);
    if (new Set(keys).size !== keys.length) return true;
  }
  return node.children?.some((child) => hasDuplicateKeys(child)) ?? false;
}

export function replaceConfigValue(content: string, path: JSONPath, value: unknown): string | null {
  const original = parseConfig(content);
  if (original === null) return null;
  const changed = applyEdits(content, modify(content, path, value, {}));
  return parseConfig(changed) !== null ? changed : null;
}

export async function snapshot(path: string): Promise<Snapshot | null> {
  const file = await safeFile(path);
  if (!file) return null;
  try {
    const content = await readFile(path, "utf8");
    const after = await lstat(path);
    if (after.ino !== file.stat.ino || after.mtimeMs !== file.stat.mtimeMs) return null;
    return { ...file, content, stat: after };
  } catch {
    return null;
  }
}

export function sameSnapshot(
  left: Snapshot | null | undefined,
  right: Snapshot | null | undefined,
): boolean {
  return (
    !!left &&
    !!right &&
    left.content === right.content &&
    left.stat.dev === right.stat.dev &&
    left.stat.ino === right.stat.ino &&
    left.stat.mode === right.stat.mode &&
    left.stat.mtimeMs === right.stat.mtimeMs
  );
}

export async function writeExisting(
  path: string,
  expected: Snapshot,
  content: string,
  signal?: AbortSignal,
): Promise<boolean> {
  let temporary: string | null = null;
  try {
    if (signal?.aborted) return false;
    const before = await snapshot(path);
    if (
      signal?.aborted ||
      !before ||
      !sameSnapshot(expected, before) ||
      (before.stat.mode & 0o222) === 0
    )
      return false;
    if (signal?.aborted) return false;
    temporary = `${dirname(path)}/.${path.split(/[\\/]/).pop()}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    await writeFile(temporary, content, { flag: "wx", mode: before.mode });
    await chmod(temporary, before.mode);
    if (signal?.aborted || !sameSnapshot(before, await snapshot(path)) || signal?.aborted)
      return false;
    await rename(temporary, path);
    temporary = null;
    return true;
  } finally {
    if (temporary) await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function writeNew(path: string, content: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporary: string | undefined;
  try {
    temporary = `${dirname(path)}/.${path.split(/[\\/]/).pop()}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.close();
    handle = undefined;
    await link(temporary, path);
    return true;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
    if (temporary) await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function ensureSafeDirectory(directory: string): Promise<string | null> {
  if (!isAbsolute(directory) || !(await safeExistingAncestors(directory, true))) return null;
  try {
    await mkdir(directory, { recursive: true });
  } catch {
    return null;
  }
  return (await safeExistingAncestors(directory, true)) ? safeDirectory(directory) : null;
}

async function safeExistingAncestors(
  directory: string,
  requireWritableNearest: boolean,
): Promise<boolean> {
  let nearest: Stats | null = null;
  for (let current = resolve(directory); ; current = dirname(current)) {
    try {
      const entry = await lstat(current);
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !samePath(await realpath(current), current)
      )
        return false;
      nearest ||= entry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    if (current === dirname(current))
      return !!nearest && (!requireWritableNearest || (nearest.mode & 0o222) !== 0);
  }
}

export async function withConfigLock(
  directory: string,
  task: () => Promise<boolean>,
): Promise<boolean> {
  const lock = `${directory}/${LOCK_NAME}`;
  try {
    await mkdir(lock);
  } catch {
    return false;
  }
  try {
    return await task();
  } finally {
    await rm(lock, { recursive: true, force: true }).catch(() => {});
  }
}
