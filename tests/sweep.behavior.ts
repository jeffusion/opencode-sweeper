import { describe, expect, it } from "bun:test";

import { runSweep } from "../src/sweep";
import {
  FIXED_NOW,
  MockSweeperClient,
  defaultSweeperOpts,
  makeSession,
  withMockedNow,
} from "./sweep-support";

describe("runSweep", () => {
  it("deletes every expired session", async () => {
    await withMockedNow(FIXED_NOW, async () => {
      const client = new MockSweeperClient([
        makeSession({ id: "a", ageMs: 8 * 24 * 60 * 60 * 1_000, title: "a", directory: "/a" }),
        makeSession({ id: "b", ageMs: 8 * 24 * 60 * 60 * 1_000, title: "b", directory: "/b" }),
        makeSession({ id: "c", ageMs: 8 * 24 * 60 * 60 * 1_000, title: "c", directory: "/c" }),
      ]);

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
        scanned: 3,
        deleted: 3,
        protectedCount: 0,
        recentActiveSkipped: 0,
        mainNotExpiredSkipped: 0,
        subagentNotExpiredSkipped: 0,
        dryRunSkipped: 0,
        errors: [],
        deletions: [
          { id: "a", title: "a", dryRun: false },
          { id: "b", title: "b", dryRun: false },
          { id: "c", title: "c", dryRun: false },
        ],
      });
    });
  });

  it("deletes only expired sessions when fresh ones are still within grace", async () => {
    await withMockedNow(FIXED_NOW, async () => {
      const client = new MockSweeperClient([
        makeSession({
          id: "expired",
          ageMs: 8 * 24 * 60 * 60 * 1_000,
          title: "expired",
          directory: "/expired",
        }),
        makeSession({ id: "fresh", ageMs: 60 * 1_000, title: "fresh", directory: "/fresh" }),
      ]);

      const result = await runSweep(
        client,
        defaultSweeperOpts({
          expiryMs: 7 * 24 * 60 * 60 * 1_000,
          recentActivityGraceMs: 60 * 60 * 1_000,
          dryRun: false,
        }),
        new Set(),
      );

      expect(result.deleted).toBe(1);
      expect(result.recentActiveSkipped).toBe(1);
      expect(result.mainNotExpiredSkipped).toBe(0);
      expect(result.subagentNotExpiredSkipped).toBe(0);
      expect(result.deletions).toEqual([{ id: "expired", title: "expired", dryRun: false }]);
    });
  });

  it("never deletes protected sessions", async () => {
    await withMockedNow(FIXED_NOW, async () => {
      const client = new MockSweeperClient([
        makeSession({
          id: "protected",
          ageMs: 8 * 24 * 60 * 60 * 1_000,
          title: "protected",
          directory: "/protected",
        }),
      ]);

      const result = await runSweep(
        client,
        defaultSweeperOpts({
          expiryMs: 7 * 24 * 60 * 60 * 1_000,
          recentActivityGraceMs: 60 * 60 * 1_000,
          dryRun: false,
        }),
        new Set(["protected"]),
      );

      expect(result.protectedCount).toBe(1);
      expect(result.deleted).toBe(0);
      expect(result.deletions).toEqual([]);
      expect(client.deleteCalls).toEqual([]);
    });
  });

  it("records dry-run deletions without calling delete", async () => {
    await withMockedNow(FIXED_NOW, async () => {
      const client = new MockSweeperClient([
        makeSession({
          id: "dry",
          ageMs: 8 * 24 * 60 * 60 * 1_000,
          title: "dry",
          directory: "/dry",
          parentID: "root",
        }),
      ]);

      const result = await runSweep(
        client,
        defaultSweeperOpts({
          expiryMs: 7 * 24 * 60 * 60 * 1_000,
          recentActivityGraceMs: 60 * 60 * 1_000,
          dryRun: true,
        }),
        new Set(),
      );

      expect(result.dryRunSkipped).toBe(1);
      expect(result.deleted).toBe(0);
      expect(result.deletions).toEqual([
        { id: "dry", title: "dry", parentID: "root", dryRun: true },
      ]);
      expect(client.deleteCalls).toEqual([]);
    });
  });

  it("deletes expired sessions when recent activity grace is zero", async () => {
    await withMockedNow(FIXED_NOW, async () => {
      const client = new MockSweeperClient([
        makeSession({
          id: "old-a",
          ageMs: 2 * 24 * 60 * 60 * 1_000,
          title: "old-a",
          directory: "/old-a",
        }),
        makeSession({
          id: "old-b",
          ageMs: 8 * 24 * 60 * 60 * 1_000,
          title: "old-b",
          directory: "/old-b",
        }),
      ]);

      const result = await runSweep(
        client,
        defaultSweeperOpts({
          expiryMs: 1,
          recentActivityGraceMs: 0,
          dryRun: false,
        }),
        new Set(),
      );

      expect(result.deleted).toBe(2);
      expect(result.recentActiveSkipped).toBe(0);
      expect(result.deletions).toEqual([
        { id: "old-a", title: "old-a", dryRun: false },
        { id: "old-b", title: "old-b", dryRun: false },
      ]);
    });
  });
});
