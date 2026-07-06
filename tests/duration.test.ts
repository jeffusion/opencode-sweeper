import { describe, expect, it } from "bun:test";

import { parseDuration } from "../src/duration";

describe("parseDuration", () => {
  it.each([
    ["7d", 604_800_000],
    ["24h", 86_400_000],
    ["30m", 1_800_000],
    ["60s", 60_000],
    ["0", 0],
    [0, 0],
    [3600_000, 3_600_000],
    ["1.5d", 129_600_000],
    ["1500ms", 1_500],
    ["1ms", 1],
    ["1.5h", 5_400_000],
    ["  7d ", 604_800_000],
  ])("returns %p as %p", (input, expected) => {
    expect(parseDuration(input, 123)).toBe(expected);
  });

  it("returns the fallback for undefined", () => {
    expect(parseDuration(undefined, 42)).toBe(42);
  });

  it.each(["-1d", -1])("throws RangeError for negative input %p", (input) => {
    expect(() => parseDuration(input, 1)).toThrow(RangeError);
    expect(() => parseDuration(input, 1)).toThrow("duration must be non-negative");
  });

  it.each([[Number.NaN]])("throws RangeError for NaN %p", (input) => {
    expect(() => parseDuration(input, 1)).toThrow(RangeError);
  });

  it.each([["abc"], [""], ["7days"], ["7y"]])(
    "throws SyntaxError for invalid input %p",
    (input) => {
      expect(() => parseDuration(input, 1)).toThrow(SyntaxError);
    },
  );
});
