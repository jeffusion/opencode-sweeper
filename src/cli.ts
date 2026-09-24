#!/usr/bin/env node
import { lstat, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  CONFIG_FILES,
  compareVersions,
  ensureSafeDirectory,
  parseConfig,
  pluginSpec,
  replaceConfigValue,
  safeFile,
  snapshot,
  withConfigLock,
  writeExisting,
  writeNew,
} from "./config-file.js";

const require = createRequire(import.meta.url);
const { name: PACKAGE_NAME, version: PACKAGE_VERSION } = require("../package.json") as {
  name: string;
  version: string;
};
const SCHEMA = "https://opencode.ai/config.json";
const USAGE = `Usage: opencode-sweeper install [--format v1|v2]

Register this package in your global OpenCode config.
New configs default to v1 (plugin array) for compatibility; use --format v2 for the plugins array.`;

type Output = { write(text: string): unknown };
type RunOptions = {
  args?: string[];
  env?: NodeJS.ProcessEnv;
  stdout?: Output;
  stderr?: Output;
};
type ConfigRecord = Record<string, unknown>;
type ConfigFile = {
  name: string;
  path: string;
  file: NonNullable<Awaited<ReturnType<typeof snapshot>>>;
  config: ConfigRecord;
};
type Format = "v1" | "v2";
type Plan =
  | {
      type: "existing";
      file: ConfigFile;
      key: "plugin" | "plugins";
      index: number;
      entry: unknown;
      format: "string" | "object" | "legacy";
      configFormat: Format;
      pinned?: string;
    }
  | { type: "append"; file: ConfigFile; format: Format }
  | { type: "create"; format: Format };

function configDirectory(env: NodeJS.ProcessEnv): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && !isAbsolute(xdg)) {
    throw new Error("XDG_CONFIG_HOME must be an absolute path.");
  }
  return join(xdg || join(homedir(), ".config"), "opencode");
}

function ownSpec(spec: unknown): { pinned?: string; unsupported?: true } | null {
  if (spec === PACKAGE_NAME) return {};
  if (typeof spec !== "string" || !spec.startsWith(`${PACKAGE_NAME}@`)) return null;
  const version = spec.slice(PACKAGE_NAME.length + 1);
  return /^\d+\.\d+\.\d+$/.test(version) && compareVersions(version, version) !== null
    ? { pinned: version }
    : { unsupported: true };
}

function opaqueSpec(spec: unknown): boolean {
  return (
    typeof spec === "string" &&
    (/^(file:|git\+|git:|git@|github:|https?:|\.{1,2}\/|\/|~(?:\/|$)|[A-Za-z]:[\\/])/.test(spec) ||
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(spec) ||
      spec.includes("@npm:"))
  );
}

function entrySpec(
  entry: unknown,
): { spec: string; format: "string" | "object" | "legacy" } | null {
  if (typeof entry === "string") return { spec: entry, format: "string" };
  if (
    entry !== null &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    typeof (entry as { package?: unknown }).package === "string"
  ) {
    return { spec: (entry as { package: string }).package, format: "object" };
  }
  const parsed = pluginSpec(entry);
  return parsed ? { spec: parsed.spec, format: "legacy" } : null;
}

function entryHasOptions(entry: unknown): boolean {
  if (entry === null || typeof entry !== "object") return false;
  if (Array.isArray(entry)) {
    return entry.length > 1;
  }
  return Object.hasOwn(entry, "options");
}

function v2RemovalTargetsPackage(entry: unknown): boolean {
  if (typeof entry !== "string" || !entry.startsWith("-")) return false;
  const selector = entry.slice(1);
  const matchesPackage =
    selector === "*" || selector.endsWith(".*")
      ? PACKAGE_NAME.startsWith(selector.slice(0, -1))
      : selector === PACKAGE_NAME;
  // Keep rejecting version-like negative specs conservatively. The selector
  // grammar is for plugin IDs, while a package@version string is ambiguous.
  return matchesPackage || selector.startsWith(`${PACKAGE_NAME}@`);
}

async function configFiles(directory: string): Promise<ConfigFile[]> {
  const found: ConfigFile[] = [];
  for (const name of CONFIG_FILES) {
    const path = join(directory, name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe config file: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!(await safeFile(path, true))) throw new Error(`Unsafe or read-only config file: ${path}`);
    const file = await snapshot(path);
    if (!file) throw new Error(`Could not safely read OpenCode config: ${path}`);
    const parsed = parseConfig(file.content);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Invalid OpenCode config: ${path}`);
    }
    const config = parsed as ConfigRecord;
    for (const key of ["plugins", "plugin"] as const) {
      if (config[key] !== undefined && !Array.isArray(config[key])) {
        throw new Error(`Invalid ${key} array: ${path}`);
      }
    }
    found.push({ name, path, file, config });
  }
  return found;
}

function decide(files: ConfigFile[], requestedFormat?: Format): Plan {
  const matches: Extract<Plan, { type: "existing" }>[] = [];
  let hasOpaqueSpec = false;
  const populatedFormats = new Set<Format>();

  for (const file of files) {
    const v2Entries = Array.isArray(file.config.plugins) ? file.config.plugins : [];
    if (v2Entries.some(v2RemovalTargetsPackage)) {
      throw new Error(
        `A V2 config explicitly removes ${PACKAGE_NAME}; remove the negative plugin entry manually before installing.`,
      );
    }

    if (file.config.plugin !== undefined && file.config.plugins !== undefined) {
      throw new Error(
        `Both plugin and plugins arrays are present in ${file.path}; resolve the format manually.`,
      );
    }
    if (Array.isArray(file.config.plugin) && file.config.plugin.length > 0)
      populatedFormats.add("v1");
    if (Array.isArray(file.config.plugins) && file.config.plugins.length > 0)
      populatedFormats.add("v2");

    for (const key of ["plugins", "plugin"] as const) {
      const entries = (file.config[key] ?? []) as unknown[];
      for (const [index, entry] of entries.entries()) {
        if (
          key === "plugin" &&
          entry !== null &&
          typeof entry === "object" &&
          !Array.isArray(entry)
        ) {
          throw new Error(
            `Object plugin entry found in the v1 plugin array in ${file.path}; manually correct it to a string or [string, options] entry.`,
          );
        }
        const parsed = entrySpec(entry);
        if (key === "plugins" && Array.isArray(entry)) {
          throw new Error(
            `Tuple plugin entry found in the v2 plugins array in ${file.path}; use a string or {package, options} entry.`,
          );
        }
        if (!parsed) continue;
        const own = ownSpec(parsed.spec);
        if (own?.unsupported) {
          throw new Error(
            `Unsupported existing ${PACKAGE_NAME} spec in ${file.path}; confirm it manually.`,
          );
        }
        if (own) {
          matches.push({
            type: "existing",
            file,
            key,
            index,
            entry,
            format: parsed.format,
            configFormat: key === "plugin" ? "v1" : "v2",
            ...own,
          });
        } else if (opaqueSpec(parsed.spec)) {
          hasOpaqueSpec = true;
        }
      }
    }
  }

  if (matches.length > 1)
    throw new Error(`Multiple ${PACKAGE_NAME} entries found; resolve them manually.`);
  if (populatedFormats.size > 1) {
    throw new Error(
      "Existing plugin entries use both v1 and v2 formats; resolve the config manually before installing.",
    );
  }
  if (matches.length === 1) {
    const existing = matches[0];
    if (!existing) throw new Error("Could not resolve existing plugin entry.");
    if (requestedFormat && requestedFormat !== existing.configFormat) {
      throw new Error(
        `Requested ${requestedFormat} format conflicts with the existing ${existing.configFormat} entry; no migration was performed.`,
      );
    }
    return existing;
  }
  if (hasOpaqueSpec) {
    throw new Error(
      "An opaque file, git, or npm-alias plugin is present; confirm the config manually before adding this plugin.",
    );
  }

  const existingFormat = populatedFormats.values().next().value as Format | undefined;
  if (requestedFormat && existingFormat && requestedFormat !== existingFormat) {
    throw new Error(
      `Requested ${requestedFormat} format conflicts with existing ${existingFormat} plugin entries; no migration was performed.`,
    );
  }
  const file = ["opencode.jsonc", "opencode.json", "config.json"]
    .map((name) => files.find((candidate) => candidate.name === name))
    .find((candidate) => candidate !== undefined);
  const fileFormat: Format | undefined =
    file?.config.plugin !== undefined
      ? "v1"
      : file?.config.plugins !== undefined
        ? "v2"
        : undefined;
  const format = existingFormat ?? fileFormat ?? requestedFormat ?? "v1";
  if (fileFormat && fileFormat !== format) {
    throw new Error(
      `Selected config file uses ${fileFormat} format but existing plugins use ${format}; resolve the config manually before installing.`,
    );
  }
  if (requestedFormat && format !== requestedFormat) {
    throw new Error(
      `Requested ${requestedFormat} format conflicts with existing ${format} plugin config; no migration was performed.`,
    );
  }
  return file ? { type: "append", file, format } : { type: "create", format };
}

function formatOf(
  args: string[],
  stdout: Output,
  stderr: Output,
): { exitCode: number; install: boolean; format?: Format } {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        format: { type: "string" },
      },
      allowPositionals: true,
      strict: false,
      tokens: true,
    });
  } catch {
    stderr.write(`${USAGE}\n`);
    return { exitCode: 1, install: false };
  }
  if (
    (parsed.tokens ?? []).some(
      (token) => token.kind === "option" && !["help", "version", "format"].includes(token.name),
    ) ||
    parsed.positionals.some((value) => value !== "install") ||
    parsed.positionals.length > 1
  ) {
    stderr.write(`${USAGE}\n`);
    return { exitCode: 1, install: false };
  }
  if (parsed.values.help) {
    stdout.write(`${USAGE}\n`);
    return { exitCode: 0, install: false };
  }
  if (parsed.values.version) {
    stdout.write(`${PACKAGE_VERSION}\n`);
    return { exitCode: 0, install: false };
  }
  if (parsed.positionals[0] !== "install") {
    stderr.write(`${USAGE}\n`);
    return { exitCode: 1, install: false };
  }
  const requested = parsed.values.format;
  if (requested !== undefined && requested !== "v1" && requested !== "v2") {
    stderr.write("--format must be v1 or v2.\n");
    return { exitCode: 1, install: false };
  }
  return { exitCode: 0, install: true, format: requested };
}

export async function run(options: RunOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const parsed = formatOf(options.args ?? process.argv.slice(2), stdout, stderr);
  if (parsed.exitCode !== 0 || !parsed.install) return parsed.exitCode;

  try {
    const directory = await ensureSafeDirectory(configDirectory(options.env ?? process.env));
    if (!directory) throw new Error("OpenCode config directory is unsafe.");
    let outcome:
      | {
          path: string;
          spec: string;
          preservedOptions: boolean;
          changed: boolean;
        }
      | undefined;
    const locked = await withConfigLock(directory, async () => {
      // Discover and parse only after acquiring the lock; all writes are based on
      // the locked snapshot, so concurrent installers cannot overwrite each other.
      const files = await configFiles(directory);
      const plan = decide(files, parsed.format);
      const spec = `${PACKAGE_NAME}@${PACKAGE_VERSION}`;

      if (plan.type === "existing") {
        const existing = entrySpec(plan.entry);
        if (!existing) throw new Error(`Could not read existing ${PACKAGE_NAME} entry.`);
        const comparison = plan.pinned ? compareVersions(plan.pinned, PACKAGE_VERSION) : null;
        if (comparison !== null && comparison >= 0) {
          outcome = {
            path: plan.file.path,
            spec: existing.spec,
            preservedOptions: entryHasOptions(plan.entry),
            changed: false,
          };
          return true;
        }
        const path: Array<string | number> =
          plan.format === "object"
            ? [plan.key, plan.index, "package"]
            : Array.isArray(plan.entry)
              ? [plan.key, plan.index, 0]
              : [plan.key, plan.index];
        const changed = replaceConfigValue(plan.file.file.content, path, spec);
        if (!changed) throw new Error(`Could not update config: ${plan.file.path}`);
        if (!(await writeExisting(plan.file.path, plan.file.file, changed))) {
          throw new Error(`Config changed while installing: ${plan.file.path}`);
        }
        outcome = {
          path: plan.file.path,
          spec,
          preservedOptions: entryHasOptions(plan.entry),
          changed: true,
        };
        return true;
      }

      if (plan.type === "append") {
        const key = plan.format === "v1" ? "plugin" : "plugins";
        const existing = plan.file.config[key] as unknown[] | undefined;
        const entry = plan.format === "v1" ? spec : { package: spec, options: {} };
        const changed = replaceConfigValue(
          plan.file.file.content,
          existing ? [key, -1] : [key],
          existing ? entry : [entry],
        );
        if (!changed || !(await writeExisting(plan.file.path, plan.file.file, changed))) {
          throw new Error(`Config changed while installing: ${plan.file.path}`);
        }
        outcome = { path: plan.file.path, spec, preservedOptions: false, changed: true };
        return true;
      }

      const path = join(directory, "opencode.json");
      const key = plan.format === "v1" ? "plugin" : "plugins";
      const entry = plan.format === "v1" ? spec : { package: spec, options: {} };
      const changed = `${JSON.stringify({ $schema: SCHEMA, [key]: [entry] }, null, 2)}\n`;
      if (!(await writeNew(path, changed))) throw new Error(`Could not create config: ${path}`);
      outcome = { path, spec, preservedOptions: false, changed: true };
      return true;
    });
    if (!locked || !outcome)
      throw new Error("OpenCode config is busy; try again after the other process finishes.");
    stdout.write(
      `${outcome.changed ? "Registered" : "Already registered"} ${outcome.spec} in ${outcome.path}. Restart OpenCode to apply.${outcome.preservedOptions ? " Existing options were preserved unchanged; review them before restarting." : ""}\nSafety reminder: the sweeper defaults to dryRun=false and interval=1h. Before starting OpenCode, consider setting dryRun=true and review the reported candidates.\n`,
    );
    return 0;
  } catch (error) {
    stderr.write(`${error instanceof Error ? error.message : "Install failed."}\n`);
    return 1;
  }
}

if (process.argv[1]) {
  Promise.all([realpath(process.argv[1]), realpath(fileURLToPath(import.meta.url))])
    .then(([entry, modulePath]) => {
      if (entry === modulePath) {
        run().then((code) => {
          process.exitCode = code;
        });
      }
    })
    .catch(() => undefined);
}
