import { describe, expect, it } from "bun:test";

import { runSweep } from "../src/sweep";
import {
  FIXED_NOW,
  MockSweeperClient,
  defaultSweeperOpts,
  makeSession,
  withMockedNow,
} from "./sweep-support";

describe("runSweep edge cases", () => {
  it("skips recent sessions before the expiry check", async () => {
    await withMockedNow(FIXED_NOW, async () => {
      const client = new MockSweeperClient([
        makeSession({ id: "fresh", ageMs: 0, title: "fresh", directory: "/fresh" }),
      ]);

      const result = await runSweep(
        client,
        defaultSweeperOpts({
          expiryMs: 1,
          recentActivityGraceMs: 60 * 60 * 1_000,
          dryRun: false,
        }),
        new Set(),
      );

      expect(result.recentActiveSkipped).toBe(1);
      expect(result.mainNotExpiredSkipped).toBe(0);
      expect(result.subagentNotExpiredSkipped).toBe(0);
      expect(result.deleted).toBe(0);
      expect(result.deletions).toEqual([]);
    });
  });

  it("skips recent sessions before expiry even when expiry is tiny", async () => {
    await withMockedNow(FIXED_NOW, async () => {
      const client = new MockSweeperClient([
        makeSession({ id: "now", ageMs: 0, title: "now", directory: "/now" }),
      ]);

      const result = await runSweep(
        client,
        defaultSweeperOpts({
          expiryMs: 1,
          recentActivityGraceMs: 60 * 60 * 1_000,
          dryRun: false,
        }),
        new Set(),
      );

      expect(result.recentActiveSkipped).toBe(1);
      expect(result.mainNotExpiredSkipped).toBe(0);
      expect(result.subagentNotExpiredSkipped).toBe(0);
      expect(result.deleted).toBe(0);
    });
  });

  it("captures delete errors and keeps sweeping", async () => {
    await withMockedNow(FIXED_NOW, async () => {
      const client = new MockSweeperClient(
        [
          makeSession({
            id: "boom",
            ageMs: 8 * 24 * 60 * 60 * 1_000,
            title: "boom",
            directory: "/boom",
          }),
        ],
        new Map([["boom", { kind: "throw", error: new Error("boom") }]]),
      );

      const result = await runSweep(
        client,
        defaultSweeperOpts({
          expiryMs: 7 * 24 * 60 * 60 * 1_000,
          recentActivityGraceMs: 60 * 60 * 1_000,
          dryRun: false,
        }),
        new Set(),
      );

      expect(result.deleted).toBe(0);
      expect(result.errors).toEqual([{ id: "boom", error: "boom" }]);
    });
  });

  it("returns zero counts for an empty session list", async () => {
    await withMockedNow(FIXED_NOW, async () => {
      const client = new MockSweeperClient([]);

      const result = await runSweep(
        client,
        defaultSweeperOpts({
          expiryMs: 7 * 24 * 60 * 60 * 1_000,
          recentActivityGraceMs: 60 * 60 * 1_000,
          dryRun: false,
        }),
        new Set(),
      );

      expect(result).toEqual({
        scanned: 0,
        deleted: 0,
        protectedCount: 0,
        recentActiveSkipped: 0,
        mainNotExpiredSkipped: 0,
        subagentNotExpiredSkipped: 0,
        dryRunSkipped: 0,
        errors: [],
        deletions: [],
      });
    });
  });
});
