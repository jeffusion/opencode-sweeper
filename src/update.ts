import { lstat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import {
  CONFIG_FILES as SOURCE_FILES,
  type Snapshot,
  compareVersions,
  parseConfig,
  pluginSpec,
  replaceConfigValue,
  safeDirectory,
  safeFile,
  sameSnapshot,
  snapshot,
  stableVersion,
  withConfigLock,
  writeExisting,
} from "./config-file.js";

const require = createRequire(import.meta.url);
const PACKAGE_NAME = "opencode-sweeper";
const PACKAGE_VERSION = (require("../package.json") as { version: string }).version;
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 64 * 1024;

type ConfigRecord = Record<string, unknown>;
type PluginOrigin = { spec: unknown; source: string; scope: "local" | "global" };
type ConfiguredTarget = {
  entry: unknown;
  source: string;
  scope: "local" | "global";
  pinned: string | null;
};
type FileTarget = Snapshot & {
  value: ConfigRecord;
  index: number;
};
type UpdateCallbacks = { onSuccess?: (version: string) => void };
type UpdaterDependencies = {
  fetch?: typeof fetch;
  version?: string;
  timeoutMs?: number;
  maxBodyBytes?: number;
  onWrite?: () => void;
};

function isRecord(value: unknown): value is ConfigRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clone);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }
  return value;
}

function equalValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => equalValue(item, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => Object.hasOwn(right, key) && equalValue(left[key], right[key]))
    );
  }
  return false;
}

function allowedSpec(spec: unknown): { pinned: string | null } | null {
  if (typeof spec !== "string") return null;
  if (spec === PACKAGE_NAME || spec === `${PACKAGE_NAME}@latest`) return { pinned: null };
  const prefix = `${PACKAGE_NAME}@`;
  if (!spec.startsWith(prefix)) return null;
  const pinned = spec.slice(prefix.length);
  return stableVersion(pinned) ? { pinned } : null;
}

function belongsToPackage(spec: unknown): spec is string {
  return typeof spec === "string" && (spec === PACKAGE_NAME || spec.startsWith(`${PACKAGE_NAME}@`));
}

function validOrigin(value: unknown): value is PluginOrigin {
  if (!isRecord(value)) return false;
  return (
    pluginSpec(value.spec) !== null &&
    typeof value.source === "string" &&
    (value.scope === "local" || value.scope === "global")
  );
}

function configuredTarget(config: unknown): ConfiguredTarget | null {
  if (!isRecord(config) || !Array.isArray(config.plugin) || !Array.isArray(config.plugin_origins)) {
    return null;
  }
  const plugin = config.plugin;
  const matching = plugin
    .map((entry, index) => ({ entry, index, parsed: pluginSpec(entry) }))
    .filter(({ parsed }) => parsed !== null && belongsToPackage(parsed.spec));
  if (matching.length !== 1) return null;
  const matched = matching[0];
  if (!matched || !matched.parsed || !allowedSpec(matched.parsed.spec)) return null;

  const origins: unknown[] = config.plugin_origins;
  if (!origins.every(validOrigin)) return null;
  for (const origin of origins) {
    if (origins.filter((candidate) => equalValue(candidate, origin)).length !== 1) return null;
    if (plugin.filter((entry) => equalValue(entry, origin.spec)).length !== 1) return null;
  }
  const own = origins.filter((origin) => equalValue(origin.spec, matched.entry));
  if (own.length !== 1 || !own[0] || !isAbsolute(own[0].source)) return null;
  const allowed = allowedSpec(matched.parsed.spec);
  if (!allowed) return null;
  return {
    entry: clone(matched.entry),
    source: own[0].source,
    scope: own[0].scope,
    pinned: allowed.pinned,
  };
}

async function readTarget(path: string, expectedEntry: unknown): Promise<FileTarget | null> {
  const file = await safeFile(path);
  if (!file) return null;
  try {
    const content = await readFile(file.path, "utf8");
    const value = parseConfig(content);
    if (!isRecord(value) || !Array.isArray(value.plugin)) return null;
    const matches = value.plugin
      .map((entry, index) => ({ entry, index, parsed: pluginSpec(entry) }))
      .filter(({ parsed }) => parsed !== null && belongsToPackage(parsed.spec));
    if (matches.length !== 1 || !equalValue(matches[0]?.entry, expectedEntry)) return null;
    const match = matches[0];
    if (!match) return null;
    return { ...file, content, value, index: match.index };
  } catch {
    return null;
  }
}

async function locateTarget(target: ConfiguredTarget): Promise<FileTarget | null> {
  const directFile = await readTarget(target.source, target.entry);
  if (directFile) return directFile;
  if (target.scope !== "global") return null;
  const directory = await safeDirectory(target.source);
  if (!directory) return null;
  const matches: FileTarget[] = [];
  for (const name of SOURCE_FILES) {
    const path = join(directory, name);
    try {
      const link = await lstat(path);
      if (link.isSymbolicLink()) return null;
      if (!link.isFile()) continue;
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") continue;
      return null;
    }
    const match = await readTarget(path, target.entry);
    if (match) {
      matches.push(match);
      continue;
    }
    try {
      const value = parseConfig(await readFile(path, "utf8"));
      if (!value) return null;
      if (
        isRecord(value) &&
        Array.isArray(value.plugin) &&
        value.plugin.some((entry) => {
          const parsed = pluginSpec(entry);
          return parsed !== null && belongsToPackage(parsed.spec);
        })
      ) {
        return null;
      }
    } catch {
      return null;
    }
  }
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function replaceSpec(
  content: string,
  index: number,
  entry: unknown,
  version: string,
): string | null {
  const path: Array<string | number> = Array.isArray(entry)
    ? ["plugin", index, 0]
    : ["plugin", index];
  const original = parseConfig(content);
  if (!isRecord(original) || !Array.isArray(original.plugin)) return null;
  const changed = replaceConfigValue(content, path, `${PACKAGE_NAME}@${version}`);
  if (!changed) return null;
  const value = parseConfig(changed);
  if (!isRecord(value) || !Array.isArray(value.plugin)) return null;
  const expected = clone(original);
  if (!isRecord(expected) || !Array.isArray(expected.plugin)) return null;
  const expectedPlugin = [...expected.plugin];
  const originalEntry = expectedPlugin[index];
  if (Array.isArray(entry)) {
    if (!Array.isArray(originalEntry)) return null;
    expectedPlugin[index] = [`${PACKAGE_NAME}@${version}`, ...originalEntry.slice(1)];
  } else {
    expectedPlugin[index] = `${PACKAGE_NAME}@${version}`;
  }
  expected.plugin = expectedPlugin;
  return equalValue(value, expected) ? changed : null;
}

async function writeTarget(
  target: FileTarget,
  configured: ConfiguredTarget,
  version: string,
  inflight: Map<string, Promise<boolean>>,
  onWrite?: () => void,
): Promise<boolean> {
  const existing = inflight.get(target.path);
  if (existing) return existing;
  const task = withConfigLock(dirname(target.path), async () => {
    // The origin can gain a second matching global config while registry I/O is
    // pending. Re-resolve under the directory lock and only proceed if the exact
    // same file and snapshot remain the unique target.
    const located = await locateTarget(configured);
    if (!located || located.path !== target.path || !sameSnapshot(target, located)) return false;
    const current = await readTarget(target.path, configured.entry);
    if (!current || !sameSnapshot(located, current)) return false;
    const before = await snapshot(target.path);
    if (!before || !sameSnapshot(current, before) || (before.stat.mode & 0o222) === 0) return false;
    const changed = replaceSpec(before.content, current.index, configured.entry, version);
    if (!changed || changed === before.content) return false;
    const written = await writeExisting(target.path, before, changed);
    if (written) onWrite?.();
    return written;
  });
  inflight.set(target.path, task);
  try {
    return await task;
  } finally {
    if (inflight.get(target.path) === task) inflight.delete(target.path);
  }
}

async function limitedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return new TextEncoder().encode(text).byteLength <= maxBytes ? text : null;
  }
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(part.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function createVersionUpdater(dependencies: UpdaterDependencies = {}) {
  const fetchFn = dependencies.fetch ?? globalThis.fetch;
  const version = dependencies.version ?? PACKAGE_VERSION;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBodyBytes = dependencies.maxBodyBytes ?? MAX_BODY_BYTES;
  const inflight = new Map<string, Promise<boolean>>();
  let latestPromise: Promise<string | null> | undefined;

  const latestVersion = (): Promise<string | null> => {
    if (latestPromise) return latestPromise;
    latestPromise = (async () => {
      if (typeof fetchFn !== "function" || !stableVersion(version)) return null;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const request = (async () => {
          const response = await fetchFn(REGISTRY_URL, {
            signal: controller.signal,
            redirect: "error",
          });
          if (!response.ok) return null;
          const content = await limitedBody(response, maxBodyBytes, controller.signal);
          if (!content) return null;
          let payload: unknown;
          try {
            payload = JSON.parse(content);
          } catch {
            return null;
          }
          if (!isRecord(payload) || payload.name !== PACKAGE_NAME) {
            return null;
          }
          const latest = payload.version;
          return typeof latest === "string" && stableVersion(latest) ? latest : null;
        })();
        const timeout = new Promise<string | null>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("registry timeout")), timeoutMs);
        });
        return await Promise.race([request, timeout]);
      } catch {
        return null;
      } finally {
        if (timer) clearTimeout(timer);
        controller.abort();
      }
    })();
    return latestPromise ?? Promise.resolve(null);
  };

  return async function updatePluginVersion(
    config: unknown,
    callbacks: UpdateCallbacks = {},
  ): Promise<boolean> {
    const configured = configuredTarget(config);
    if (!configured) return false;
    const target = await locateTarget(configured);
    if (!target) return false;
    const latest = await latestVersion();
    const versusRunning = latest ? compareVersions(latest, version) : null;
    const versusPin =
      latest && configured.pinned ? compareVersions(latest, configured.pinned) : null;
    if (
      !latest ||
      versusRunning === null ||
      versusRunning <= 0 ||
      (configured.pinned !== null && (versusPin === null || versusPin <= 0))
    ) {
      return false;
    }
    const changed = await writeTarget(target, configured, latest, inflight, dependencies.onWrite);
    if (changed) callbacks.onSuccess?.(latest);
    return changed;
  };
}

export const updatePluginVersion = createVersionUpdater();
export { PACKAGE_NAME, REGISTRY_URL };
