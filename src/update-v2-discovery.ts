import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseConfig } from "./config-file.js";

const PACKAGE_NAME = "opencode-sweeper";
const CONFIG_NAMES = ["opencode.json", "opencode.jsonc"] as const;

type V2Entry = string | { package: string; options?: Record<string, unknown> };
type DiscoveryOptions = { env?: NodeJS.ProcessEnv; home?: string };
type InspectedDirectory = { unsafe: boolean; files: string[] };

function isTarget(spec: unknown): spec is string {
  return typeof spec === "string" && (spec === PACKAGE_NAME || spec.startsWith(`${PACKAGE_NAME}@`));
}

function looksOpaque(spec: string): boolean {
  return (
    /^(?:file:|git(?:\+|:|@)|github:|https?:|npm:|\.{1,2}\/|\/|~(?:\/|$)|[A-Za-z]:[\\/])/.test(
      spec,
    ) ||
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(spec) ||
    spec.includes("@npm:")
  );
}

function validV2Entry(entry: unknown): entry is V2Entry {
  if (typeof entry === "string") return true;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const record = entry as Record<string, unknown>;
  return (
    typeof record.package === "string" &&
    Object.keys(record).every((key) => key === "package" || key === "options") &&
    (!Object.hasOwn(record, "options") ||
      (record.options !== null &&
        typeof record.options === "object" &&
        !Array.isArray(record.options)))
  );
}

function removeTargetsPackage(spec: string): boolean {
  if (!spec.startsWith("-")) return false;
  const selector = spec.slice(1);
  return selector === "*" || selector === PACKAGE_NAME || selector.startsWith(`${PACKAGE_NAME}@`);
}

async function safeDirectory(path: string): Promise<boolean> {
  try {
    const stat = await lstat(path);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      resolve(await realpath(path)) === resolve(path)
    );
  } catch {
    return false;
  }
}

async function safeExistingAncestors(path: string): Promise<boolean> {
  for (let current = resolve(path); ; current = dirname(current)) {
    try {
      const stat = await lstat(current);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        resolve(await realpath(current)) !== resolve(current)
      )
        return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    if (current === dirname(current)) return true;
  }
}

async function inspectDirectory(directory: string, nested: boolean): Promise<InspectedDirectory> {
  const configDirectory = nested ? join(directory, ".opencode") : directory;
  if (nested) {
    try {
      const stat = await lstat(configDirectory);
      if (
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        resolve(await realpath(configDirectory)) !== resolve(configDirectory)
      )
        return { unsafe: true, files: [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { unsafe: false, files: [] };
      return { unsafe: true, files: [] };
    }
  }
  const files: string[] = [];
  for (const name of CONFIG_NAMES) {
    const path = join(configDirectory, name);
    try {
      const stat = await lstat(path);
      if (
        stat.isSymbolicLink() ||
        !stat.isFile() ||
        resolve(await realpath(path)) !== resolve(path)
      )
        return { unsafe: true, files: [] };
      files.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { unsafe: true, files: [] };
    }
  }
  return { unsafe: false, files };
}

/** Discover the one safe existing V2 registration for this location. This function is read-only. */
export async function discoverV2UpdateTarget(
  locationDirectory: string,
  options: DiscoveryOptions = {},
): Promise<{ path: string; entry: V2Entry } | null> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  if (!isAbsolute(locationDirectory)) return null;
  if (Object.keys(env).some((key) => key.startsWith("OPENCODE_CONFIG") && env[key] !== undefined))
    return null;

  const location = resolve(locationDirectory);
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg !== "" && !isAbsolute(xdg)) return null;
  const globalDirectory = join(xdg || join(home, ".config"), "opencode");
  const allowed = new Set(
    [
      ...CONFIG_NAMES.map((name) => join(location, name)),
      ...CONFIG_NAMES.map((name) => join(location, ".opencode", name)),
      ...CONFIG_NAMES.map((name) => join(globalDirectory, name)),
    ].map((path) => resolve(path)),
  );

  const paths = new Set<string>();
  let ancestor = location;
  while (true) {
    if (!(await safeDirectory(ancestor))) return null;
    for (const nested of [false, true]) {
      const inspected = await inspectDirectory(ancestor, nested);
      if (inspected.unsafe) return null;
      for (const path of inspected.files) paths.add(path);
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }

  if (!(await safeExistingAncestors(globalDirectory))) return null;
  const global = await inspectDirectory(globalDirectory, false);
  if (global.unsafe) return null;
  for (const path of global.files) paths.add(path);

  const matches: Array<{ path: string; entry: V2Entry }> = [];
  for (const path of paths) {
    let config: unknown;
    try {
      config = parseConfig(await readFile(path, "utf8"));
    } catch {
      return null;
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) return null;
    const record = config as Record<string, unknown>;
    if (Object.hasOwn(record, "plugin") && !Array.isArray(record.plugin)) return null;
    if (Array.isArray(record.plugin)) {
      if (record.plugin.some(isTarget)) return null;
      if (record.plugin.some((entry) => typeof entry !== "string" || looksOpaque(entry)))
        return null;
    }
    if (Object.hasOwn(record, "plugins") && !Array.isArray(record.plugins)) return null;
    if (!Array.isArray(record.plugins)) continue;
    for (const entry of record.plugins) {
      if (!validV2Entry(entry)) return null;
      const spec = typeof entry === "string" ? entry : entry.package;
      if (removeTargetsPackage(spec) || looksOpaque(spec)) return null;
      if (isTarget(spec)) matches.push({ path, entry: structuredClone(entry) });
    }
  }
  if (matches.length !== 1) return null;
  const match = matches[0];
  return match && allowed.has(match.path) ? match : null;
}
