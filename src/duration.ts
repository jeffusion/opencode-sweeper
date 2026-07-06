const DURATION_FACTORS = {
  d: 86_400_000,
  h: 3_600_000,
  m: 60_000,
  ms: 1,
  s: 1_000,
} as const;

function ensureNonNegativeFinite(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("duration must be non-negative");
  }

  return value;
}

function suffixFactor(suffix: string): number {
  switch (suffix) {
    case "d":
      return DURATION_FACTORS.d;
    case "h":
      return DURATION_FACTORS.h;
    case "m":
      return DURATION_FACTORS.m;
    case "s":
      return DURATION_FACTORS.s;
    case "ms":
      return DURATION_FACTORS.ms;
    default:
      throw new SyntaxError("invalid duration suffix; expected d|h|m|s|ms");
  }
}

export function parseDuration(input: string | number | undefined, fallbackMs: number): number {
  if (input === undefined) {
    return ensureNonNegativeFinite(fallbackMs);
  }

  if (typeof input === "number") {
    return ensureNonNegativeFinite(input);
  }

  const trimmed = input.trim();

  if (trimmed === "") {
    throw new SyntaxError("invalid duration: ''");
  }

  if (trimmed.startsWith("-")) {
    throw new RangeError("duration must be non-negative");
  }

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    return ensureNonNegativeFinite(Number.parseFloat(trimmed));
  }

  const match = /^(\d+(?:\.\d+)?)([a-z]+)$/.exec(trimmed);

  if (match === null) {
    throw new SyntaxError(`invalid duration: '${trimmed}'`);
  }

  const amountText = match[1];
  const suffix = match[2];

  if (amountText === undefined || suffix === undefined) {
    throw new SyntaxError(`invalid duration: '${trimmed}'`);
  }

  const factor = suffixFactor(suffix);
  return ensureNonNegativeFinite(Number.parseFloat(amountText) * factor);
}
