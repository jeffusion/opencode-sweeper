import { createRequire } from "node:module";
import { dirname } from "node:path";
import { applyEdits, modify } from "jsonc-parser";
import {
  compareVersions,
  parseConfig,
  safeDirectory,
  safeFile,
  sameSnapshot,
  snapshot,
  stableVersion,
  withConfigLock,
  writeExisting,
} from "./config-file.js";
import { parseOptions } from "./options.js";

const PACKAGE_NAME = "opencode-sweeper";
const PACKAGE_VERSION = createRequire(import.meta.url)("../package.json").version as string;

type ExpectedEntry = string | { package: string; options?: Record<string, unknown> };
type UpdateOptions = { validate?: () => Promise<boolean>; signal?: AbortSignal };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function entryPackage(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  return isRecord(entry) && typeof entry.package === "string" ? entry.package : null;
}

function isTargetPackage(spec: unknown): spec is string {
  return typeof spec === "string" && (spec === PACKAGE_NAME || spec.startsWith(`${PACKAGE_NAME}@`));
}

function validTargetSpec(spec: string): string | null | false {
  if (spec === PACKAGE_NAME) return null;
  const prefix = `${PACKAGE_NAME}@`;
  if (!spec.startsWith(prefix)) return false;
  const version = spec.slice(prefix.length);
  if (version === "latest") return null;
  return stableVersion(version) ? version : false;
}

function validEntryOptions(entry: unknown): boolean {
  if (!isRecord(entry) || !Object.hasOwn(entry, "options")) return true;
  if (!isRecord(entry.options)) return false;
  try {
    parseOptions(entry.options);
    return true;
  } catch {
    return false;
  }
}

function replaceVersion(
  content: string,
  index: number,
  entry: unknown,
  version: string,
): string | null {
  const path: (string | number)[] =
    typeof entry === "string" ? ["plugins", index] : ["plugins", index, "package"];
  const changed = applyEdits(content, modify(content, path, `${PACKAGE_NAME}@${version}`, {}));
  const before = parseConfig(content);
  const after = parseConfig(changed);
  if (
    !isRecord(before) ||
    !isRecord(after) ||
    !Array.isArray(before.plugins) ||
    !Array.isArray(after.plugins)
  ) {
    return null;
  }
  const expected: Record<string, unknown> = structuredClone(before);
  const plugins = expected.plugins as unknown[];
  if (typeof entry === "string") plugins[index] = `${PACKAGE_NAME}@${version}`;
  else {
    const target = plugins[index];
    if (!isRecord(target)) return null;
    target.package = `${PACKAGE_NAME}@${version}`;
  }
  return equalValue(after, expected) ? changed : null;
}

/** Safely update one already-selected v2 plugin entry without discovering or reloading plugins. */
export async function updateV2PluginVersion(
  path: string,
  expectedEntry: ExpectedEntry,
  version: string,
  options: UpdateOptions = {},
): Promise<boolean> {
  if (typeof path !== "string" || !stableVersion(version)) return false;
  const expectedPackage = entryPackage(expectedEntry);
  if (
    !expectedPackage ||
    !isTargetPackage(expectedPackage) ||
    validTargetSpec(expectedPackage) === false ||
    !validEntryOptions(expectedEntry)
  ) {
    return false;
  }
  const pinnedVersion = validTargetSpec(expectedPackage);
  const runningComparison = compareVersions(version, PACKAGE_VERSION);
  const pinnedComparison = pinnedVersion ? compareVersions(version, pinnedVersion) : null;
  if (
    runningComparison === null ||
    runningComparison <= 0 ||
    (pinnedVersion !== null && (pinnedComparison === null || pinnedComparison <= 0))
  ) {
    return false;
  }

  const file = await safeFile(path, true);
  if (!file || !(await safeDirectory(dirname(file.path)))) return false;

  return withConfigLock(dirname(file.path), async () => {
    if (options.signal?.aborted) return false;
    if (options.validate && !(await options.validate())) return false;
    if (options.signal?.aborted) return false;
    const before = await snapshot(file.path);
    if (options.signal?.aborted || !before || (before.stat.mode & 0o222) === 0) return false;
    const config = parseConfig(before.content);
    if (!isRecord(config) || !Array.isArray(config.plugins) || Object.hasOwn(config, "plugin"))
      return false;
    if (config.plugins.some(Array.isArray)) return false;

    const matching = config.plugins
      .map((entry, index) => ({ entry, index, spec: entryPackage(entry) }))
      .filter(({ spec }) => isTargetPackage(spec));
    if (matching.length !== 1 || !equalValue(matching[0]?.entry, expectedEntry)) return false;
    const target = matching[0];
    if (
      !target ||
      validTargetSpec(target.spec as string) === false ||
      target.spec !== expectedPackage ||
      !validEntryOptions(target.entry)
    ) {
      return false;
    }

    const changed = replaceVersion(before.content, target.index, target.entry, version);
    if (
      options.signal?.aborted ||
      !changed ||
      changed === before.content ||
      !sameSnapshot(before, await snapshot(file.path))
    )
      return false;
    return writeExisting(file.path, before, changed, options.signal);
  });
}
