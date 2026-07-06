import { describe, expect, it } from "bun:test";

import { parseOptions } from "../src/options";

describe("parseOptions", () => {
  it("returns defaults for undefined", () => {
    expect(parseOptions(undefined)).toEqual({
      expiryMs: 2_592_000_000,
      subagentExpiryMs: 604_800_000,
      intervalMs: 3_600_000,
      dryRun: false,
      protect: [],
      recentActivityGraceMs: 3_600_000,
    });
  });

  it("returns defaults for an empty object", () => {
    expect(parseOptions({})).toEqual({
      expiryMs: 2_592_000_000,
      subagentExpiryMs: 604_800_000,
      intervalMs: 3_600_000,
      dryRun: false,
      protect: [],
      recentActivityGraceMs: 3_600_000,
    });
  });

  it("parses mixed duration overrides", () => {
    expect(
      parseOptions({
        expiry: "24h",
        interval: "30m",
      }),
    ).toEqual({
      expiryMs: 86_400_000,
      subagentExpiryMs: 604_800_000,
      intervalMs: 1_800_000,
      dryRun: false,
      protect: [],
      recentActivityGraceMs: 3_600_000,
    });
  });

  it("parses a raw numeric expiry override", () => {
    expect(parseOptions({ expiry: 600_000 })).toEqual({
      expiryMs: 600_000,
      subagentExpiryMs: 604_800_000,
      intervalMs: 3_600_000,
      dryRun: false,
      protect: [],
      recentActivityGraceMs: 3_600_000,
    });
  });

  it("parses explicit raw ms fields", () => {
    expect(
      parseOptions({
        expiryMs: 7,
        intervalMs: 60_000,
        recentActivityGraceMs: 1_000,
      }),
    ).toEqual({
      expiryMs: 7,
      subagentExpiryMs: 604_800_000,
      intervalMs: 60_000,
      dryRun: false,
      protect: [],
      recentActivityGraceMs: 1_000,
    });
  });

  it("parses recentActivityGrace as a duration string", () => {
    expect(parseOptions({ recentActivityGrace: "1d" })).toEqual({
      expiryMs: 2_592_000_000,
      subagentExpiryMs: 604_800_000,
      intervalMs: 3_600_000,
      dryRun: false,
      protect: [],
      recentActivityGraceMs: 86_400_000,
    });
  });

  it("parses dryRun strictly as boolean", () => {
    expect(parseOptions({ dryRun: true })).toEqual({
      expiryMs: 2_592_000_000,
      subagentExpiryMs: 604_800_000,
      intervalMs: 3_600_000,
      dryRun: true,
      protect: [],
      recentActivityGraceMs: 3_600_000,
    });

    const invalidBooleanOptions: Array<Record<string, unknown>> = [
      { dryRun: "yes" },
      { dryRun: 0 },
    ];

    for (const raw of invalidBooleanOptions) {
      expect(() => parseOptions(raw)).toThrow(TypeError);
    }
  });

  it("copies protect arrays and trims entries", () => {
    const raw = { protect: ["ses_a", " ses_b "] };

    const result = parseOptions(raw);
    result.protect.push("ses_c");

    expect(result.protect).toEqual(["ses_a", "ses_b", "ses_c"]);
    expect(raw.protect).toEqual(["ses_a", " ses_b "]);
  });

  it.each([
    { protect: "ses_a" },
    { protect: [1, 2] },
    { protect: ["a", null] },
    { protect: ["a", ""] },
  ])("rejects invalid protect values %#", (raw) => {
    expect(() => parseOptions(raw)).toThrow(TypeError);
    expect(() => parseOptions(raw)).toThrow("protect must be array of strings");
  });

  it("rejects a too-small interval (non-zero)", () => {
    expect(() => parseOptions({ interval: "10s" })).toThrow(Error);
    expect(() => parseOptions({ interval: "10s" })).toThrow(
      "interval must be 0 (disabled) or at least 60000ms (1m)",
    );
  });

  it("accepts interval: 0 as a disabled-timer sentinel", () => {
    expect(parseOptions({ interval: 0 }).intervalMs).toBe(0);
    expect(parseOptions({ intervalMs: 0 }).intervalMs).toBe(0);
    expect(parseOptions({ interval: "0" }).intervalMs).toBe(0);
  });

  it("rejects conflicting expiry fields", () => {
    expect(() =>
      parseOptions({
        expiry: "7d",
        expiryMs: 604_800_000,
      }),
    ).toThrow("conflicting expiry/expiryMs options");
  });

  it("rejects conflicting subagentExpiry fields", () => {
    expect(() =>
      parseOptions({
        subagentExpiry: "1h",
        subagentExpiryMs: 3_600_000,
      }),
    ).toThrow("conflicting subagentExpiry/subagentExpiryMs options");
  });

  it("subagentExpiry defaults to 7d regardless of expiry when not configured", () => {
    expect(parseOptions({ expiry: "30d" }).subagentExpiryMs).toBe(604_800_000);
    expect(parseOptions({ expiryMs: 1_000 }).subagentExpiryMs).toBe(604_800_000);
    expect(parseOptions({}).subagentExpiryMs).toBe(604_800_000);
    expect(parseOptions(undefined).subagentExpiryMs).toBe(604_800_000);
  });

  it("subagentExpiry can still be set explicitly to any value", () => {
    expect(parseOptions({ subagentExpiry: "1h" }).subagentExpiryMs).toBe(3_600_000);
    expect(parseOptions({ subagentExpiryMs: 60_000 }).subagentExpiryMs).toBe(60_000);
    expect(parseOptions({ expiry: "30d", subagentExpiry: "30d" }).subagentExpiryMs).toBe(
      2_592_000_000,
    );
  });

  it("parses subagentExpiry as a duration string", () => {
    expect(parseOptions({ expiry: "30d", subagentExpiry: "1h" }).subagentExpiryMs).toBe(3_600_000);
  });

  it("parses subagentExpiryMs as a raw number", () => {
    expect(parseOptions({ expiry: "30d", subagentExpiryMs: 60_000 }).subagentExpiryMs).toBe(60_000);
  });

  it("allows subagentExpiry to exceed expiryMs (regressive-to-parent-only mode)", () => {
    expect(parseOptions({ expiry: "1h", subagentExpiry: "7d" }).subagentExpiryMs).toBe(604_800_000);
  });

  it("rejects non-finite or negative subagentExpiryMs", () => {
    expect(() => parseOptions({ subagentExpiryMs: -1 })).toThrow(RangeError);
    expect(() => parseOptions({ subagentExpiryMs: Number.NaN })).toThrow(RangeError);
    expect(() => parseOptions({ subagentExpiryMs: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });

  it("rejects unknown options", () => {
    expect(() => parseOptions({ expiry2: "7d" })).toThrow("unknown option: expiry2");
  });
});
