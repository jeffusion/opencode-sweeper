import { describe, expect, it } from "bun:test";

import { runSweep } from "../src/sweep";
import {
  FIXED_NOW,
  MockSweeperClient,
  defaultSweeperOpts,
  makeSession,
  withMockedNow,
} from "./sweep-support";

describe("runSweep mixed coverage", () => {
  it("tracks protected, fresh, not-expired, and dry-run sessions in one sweep", async () => {
    await withMockedNow(FIXED_NOW, async () => {
      const client = new MockSweeperClient([
        makeSession({
          id: "protected",
          ageMs: 8 * 24 * 60 * 60 * 1_000,
          title: "protected",
          directory: "/protected",
        }),
        makeSession({ id: "fresh", ageMs: 5 * 60 * 1_000, title: "fresh", directory: "/fresh" }),
        makeSession({
          id: "not-expired",
          ageMs: 2 * 24 * 60 * 60 * 1_000,
          title: "not-expired",
          directory: "/not-expired",
        }),
        makeSession({
          id: "dry",
          ageMs: 8 * 24 * 60 * 60 * 1_000,
          title: "dry",
          directory: "/dry",
        }),
      ]);

      const result = await runSweep(
        client,
        defaultSweeperOpts({
          expiryMs: 7 * 24 * 60 * 60 * 1_000,
          recentActivityGraceMs: 60 * 60 * 1_000,
          dryRun: true,
        }),
        new Set(["protected"]),
      );

      expect(result.protectedCount).toBe(1);
      expect(result.recentActiveSkipped).toBe(1);
      expect(result.mainNotExpiredSkipped).toBe(1);
      expect(result.subagentNotExpiredSkipped).toBe(0);
      expect(result.dryRunSkipped).toBe(1);
      expect(result.deleted).toBe(0);
      expect(result.deletions).toEqual([{ id: "dry", title: "dry", dryRun: true }]);
    });
  });

  it("uses subagentExpiryMs for subagent-only sessions (long-running-parent scenario)", async () => {
    await withMockedNow(FIXED_NOW, async () => {
      const client = new MockSweeperClient([
        makeSession({
          id: "still-active-main",
          ageMs: 2 * 24 * 60 * 60 * 1_000,
          title: "main",
          directory: "/main",
        }),
        makeSession({
          id: "stale-subagent-1",
          ageMs: 2 * 60 * 60 * 1_000,
          title: "sub-1",
          directory: "/main",
          parentID: "still-active-main",
        }),
        makeSession({
          id: "stale-subagent-2",
          ageMs: 90 * 60 * 1_000,
          title: "sub-2",
          directory: "/main",
          parentID: "still-active-main",
        }),
        makeSession({
          id: "young-subagent",
          ageMs: 10 * 60 * 1_000,
          title: "young-sub",
          directory: "/main",
          parentID: "still-active-main",
        }),
      ]);

      const result = await runSweep(
        client,
        defaultSweeperOpts({
          expiryMs: 30 * 24 * 60 * 60 * 1_000,
          subagentExpiryMs: 60 * 60 * 1_000,
          recentActivityGraceMs: 5 * 60 * 1_000,
          dryRun: false,
        }),
        new Set(),
      );

      expect(result.scanned).toBe(4);
      expect(result.deleted).toBe(2);
      expect(result.mainNotExpiredSkipped).toBe(1);
      expect(result.subagentNotExpiredSkipped).toBe(1);
      expect(result.recentActiveSkipped).toBe(0);
      expect(result.protectedCount).toBe(0);
      expect(result.deletions).toEqual([
        { id: "stale-subagent-1", title: "sub-1", parentID: "still-active-main", dryRun: false },
        { id: "stale-subagent-2", title: "sub-2", parentID: "still-active-main", dryRun: false },
      ]);
      expect(client.deleteCalls).toEqual(["stale-subagent-1", "stale-subagent-2"]);
    });
  });

  it("preserves a parent whose subagent is deleted when subagentExpiryMs is shorter", async () => {
    await withMockedNow(FIXED_NOW, async () => {
      const client = new MockSweeperClient([
        makeSession({
          id: "parent",
          ageMs: 5 * 24 * 60 * 60 * 1_000,
          title: "parent",
          directory: "/main",
        }),
        makeSession({
          id: "child",
          ageMs: 5 * 24 * 60 * 60 * 1_000,
          title: "child",
          directory: "/main",
          parentID: "parent",
        }),
      ]);

      const result = await runSweep(
        client,
        defaultSweeperOpts({
          expiryMs: 30 * 24 * 60 * 60 * 1_000,
          subagentExpiryMs: 1 * 24 * 60 * 60 * 1_000,
          recentActivityGraceMs: 5 * 60 * 1_000,
          dryRun: false,
        }),
        new Set(),
      );

      expect(result.deleted).toBe(1);
      expect(result.mainNotExpiredSkipped).toBe(1);
      expect(result.subagentNotExpiredSkipped).toBe(0);
      expect(result.deletions).toEqual([
        { id: "child", title: "child", parentID: "parent", dryRun: false },
      ]);
      expect(client.deleteCalls).toEqual(["child"]);
    });
  });

  it("preserves expired ancestors of protected subagents", async () => {
    await withMockedNow(FIXED_NOW, async () => {
      const client = new MockSweeperClient([
        makeSession({
          id: "expired-parent",
          ageMs: 40 * 24 * 60 * 60 * 1_000,
          title: "expired parent",
          directory: "/main",
        }),
        makeSession({
          id: "protected-child",
          ageMs: 40 * 24 * 60 * 60 * 1_000,
          title: "protected child",
          directory: "/main",
          parentID: "expired-parent",
        }),
        makeSession({
          id: "stale-sibling",
          ageMs: 40 * 24 * 60 * 60 * 1_000,
          title: "stale sibling",
          directory: "/main",
          parentID: "expired-parent",
        }),
      ]);

      const result = await runSweep(
        client,
        defaultSweeperOpts({
          expiryMs: 30 * 24 * 60 * 60 * 1_000,
          subagentExpiryMs: 7 * 24 * 60 * 60 * 1_000,
          recentActivityGraceMs: 60 * 60 * 1_000,
          dryRun: false,
        }),
        new Set(["protected-child"]),
      );

      expect(result.protectedCount).toBe(2);
      expect(result.deleted).toBe(1);
      expect(result.deletions).toEqual([
        {
          id: "stale-sibling",
          title: "stale sibling",
          parentID: "expired-parent",
          dryRun: false,
        },
      ]);
      expect(client.deleteCalls).toEqual(["stale-sibling"]);
    });
  });
});
