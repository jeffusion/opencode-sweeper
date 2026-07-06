import { parseDuration } from "./duration";

export type SweeperOptions = {
  expiryMs: number;
  subagentExpiryMs: number;
  intervalMs: number;
  dryRun: boolean;
  protect: string[];
  recentActivityGraceMs: number;
};

type OptionSource = Record<string, unknown> & {
  readonly dryRun?: unknown;
  readonly expiry?: unknown;
  readonly expiryMs?: unknown;
  readonly interval?: unknown;
  readonly intervalMs?: unknown;
  readonly protect?: unknown;
  readonly recentActivityGrace?: unknown;
  readonly recentActivityGraceMs?: unknown;
  readonly subagentExpiry?: unknown;
  readonly subagentExpiryMs?: unknown;
};

const DEFAULT_EXPIRY_MS = 604_800_000;
const DEFAULT_SUBAGENT_EXPIRY_MS = 604_800_000;
const DEFAULT_INTERVAL_MS = 3_600_000;
const DEFAULT_RECENT_ACTIVITY_GRACE_MS = 3_600_000;
const MIN_INTERVAL_MS = 60_000;

const KNOWN_OPTION_KEYS = new Set<string>([
  "expiry",
  "expiryMs",
  "interval",
  "intervalMs",
  "dryRun",
  "protect",
  "recentActivityGrace",
  "recentActivityGraceMs",
  "subagentExpiry",
  "subagentExpiryMs",
]);

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function ensureNonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be non-negative`);
  }

  return value;
}

function readDurationOption(value: unknown, fallbackMs: number, label: string): number {
  if (value === undefined) {
    return fallbackMs;
  }

  if (typeof value === "string" || typeof value === "number") {
    return parseDuration(value, fallbackMs);
  }

  throw new TypeError(`${label} must be string or number`);
}

function readRawMsOption(value: unknown, fallbackMs: number, label: string): number {
  if (value === undefined) {
    return fallbackMs;
  }

  if (typeof value === "number") {
    return ensureNonNegativeFinite(value, label);
  }

  throw new TypeError(`${label} must be number`);
}

function readBooleanOption(value: unknown): boolean {
  if (value === undefined) {
    return false;
  }

  if (typeof value === "boolean") {
    return value;
  }

  throw new TypeError("dryRun must be boolean");
}

function readProtectOption(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new TypeError("protect must be array of strings");
  }

  const protectedIDs: string[] = [];

  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new TypeError("protect must be array of strings");
    }

    const trimmed = entry.trim();

    if (trimmed === "") {
      throw new TypeError("protect must be array of strings");
    }

    protectedIDs.push(trimmed);
  }

  return protectedIDs;
}

function assertKnownOptions(raw: Record<string, unknown>): void {
  for (const key of Object.keys(raw)) {
    if (!KNOWN_OPTION_KEYS.has(key)) {
      throw new Error(`unknown option: ${key}`);
    }
  }
}

export function parseOptions(raw: Record<string, unknown> | undefined): SweeperOptions {
  const source: OptionSource = raw ?? {};

  assertKnownOptions(source);

  if (hasOwn(source, "expiry") && hasOwn(source, "expiryMs")) {
    throw new Error("conflicting expiry/expiryMs options");
  }

  if (hasOwn(source, "interval") && hasOwn(source, "intervalMs")) {
    throw new Error("conflicting interval/intervalMs options");
  }

  if (hasOwn(source, "recentActivityGrace") && hasOwn(source, "recentActivityGraceMs")) {
    throw new Error("conflicting recentActivityGrace/recentActivityGraceMs options");
  }

  if (hasOwn(source, "subagentExpiry") && hasOwn(source, "subagentExpiryMs")) {
    throw new Error("conflicting subagentExpiry/subagentExpiryMs options");
  }

  const expiryMs = hasOwn(source, "expiryMs")
    ? readRawMsOption(source.expiryMs, DEFAULT_EXPIRY_MS, "expiryMs")
    : readDurationOption(source.expiry, DEFAULT_EXPIRY_MS, "expiry");

  const subagentExpiryMs = hasOwn(source, "subagentExpiryMs")
    ? readRawMsOption(source.subagentExpiryMs, DEFAULT_SUBAGENT_EXPIRY_MS, "subagentExpiryMs")
    : readDurationOption(source.subagentExpiry, DEFAULT_SUBAGENT_EXPIRY_MS, "subagentExpiry");

  const intervalMs = hasOwn(source, "intervalMs")
    ? readRawMsOption(source.intervalMs, DEFAULT_INTERVAL_MS, "intervalMs")
    : readDurationOption(source.interval, DEFAULT_INTERVAL_MS, "interval");

  const recentActivityGraceMs = hasOwn(source, "recentActivityGraceMs")
    ? readRawMsOption(
        source.recentActivityGraceMs,
        DEFAULT_RECENT_ACTIVITY_GRACE_MS,
        "recentActivityGraceMs",
      )
    : readDurationOption(
        source.recentActivityGrace,
        DEFAULT_RECENT_ACTIVITY_GRACE_MS,
        "recentActivityGrace",
      );

  if (intervalMs !== 0 && intervalMs < MIN_INTERVAL_MS) {
    throw new Error("interval must be 0 (disabled) or at least 60000ms (1m)");
  }

  return {
    expiryMs,
    subagentExpiryMs,
    intervalMs,
    dryRun: readBooleanOption(source.dryRun),
    protect: readProtectOption(source.protect),
    recentActivityGraceMs,
  };
}
