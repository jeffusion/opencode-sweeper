import { describe, expect, it } from "bun:test";

import { runSweep } from "../src/sweep";
import type { SessionLike, SweeperClient } from "../src/sweep";
import {
  FIXED_NOW,
  MockSweeperClient,
  defaultSweeperOpts,
  makeSession,
  withMockedNow,
} from "./sweep-support";

const opts = defaultSweeperOpts({
  expiryMs: 100,
  subagentExpiryMs: 100,
  recentActivityGraceMs: 10,
  dryRun: false,
});

describe("runSweep cascade protection", () => {
  it("protects a protected child and its parent while deleting unrelated sessions", async () => {
    await withMockedNow(FIXED_NOW, async () => {
      const client = new MockSweeperClient([
        makeSession({ id: "parent", ageMs: 1_000, title: "parent", directory: "/parent" }),
        makeSession({
          id: "child",
          parentID: "parent",
          ageMs: 1_000,
          title: "child",
          directory: "/child",
        }),
        makeSession({ id: "other", ageMs: 1_000, title: "other", directory: "/other" }),
      ]);

      const result = await runSweep(client, opts, new Set(["child"]));

      expect(client.deleteCalls).toEqual(["other"]);
      expect(result.protectedCount).toBe(1);
      expect(result.cascadeBlockedSkipped).toBe(1);
      expect(result.deleted).toBe(1);
    });
  });

  it("protects every ancestor of a protected deep descendant", async () => {
    await withMockedNow(FIXED_NOW, async () => {
      const client = new MockSweeperClient([
        makeSession({ id: "root", ageMs: 1_000, title: "root", directory: "/root" }),
        makeSession({
          id: "middle",
          parentID: "root",
          ageMs: 1_000,
          title: "middle",
          directory: "/middle",
        }),
        makeSession({
          id: "leaf",
          parentID: "middle",
          ageMs: 1_000,
          title: "leaf",
          directory: "/leaf",
        }),
        makeSession({ id: "other", ageMs: 1_000, title: "other", directory: "/other" }),
      ]);

      const result = await runSweep(client, opts, new Set(["leaf"]));

      expect(client.deleteCalls).toEqual(["other"]);
      expect(result.cascadeBlockedSkipped).toBe(2);
    });
  });

  it("does not delete a parent when its child has not reached subagent expiry", async () => {
    await withMockedNow(FIXED_NOW, async () => {
      const client = new MockSweeperClient([
        makeSession({ id: "parent", ageMs: 1_000, title: "parent", directory: "/parent" }),
        makeSession({
          id: "child",
          parentID: "parent",
          ageMs: 50,
          title: "child",
          directory: "/child",
        }),
        makeSession({ id: "other", ageMs: 1_000, title: "other", directory: "/other" }),
      ]);

      const result = await runSweep(client, opts, new Set());

      expect(client.deleteCalls).toEqual(["other"]);
      expect(result.subagentNotExpiredSkipped).toBe(1);
      expect(result.cascadeBlockedSkipped).toBe(1);
    });
  });

  it("treats empty parent IDs as roots and safely blocks parent cycles", async () => {
    await withMockedNow(FIXED_NOW, async () => {
      const client = new MockSweeperClient([
        makeSession({
          id: "cycle-a",
          parentID: "cycle-b",
          ageMs: 1_000,
          title: "a",
          directory: "/a",
        }),
        makeSession({
          id: "cycle-b",
          parentID: "cycle-a",
          ageMs: 1_000,
          title: "b",
          directory: "/b",
        }),
        makeSession({
          id: "empty-parent",
          parentID: "",
          ageMs: 1_000,
          title: "empty",
          directory: "/empty",
        }),
      ]);

      const result = await runSweep(client, opts, new Set(["cycle-a"]));

      expect(client.deleteCalls).toEqual(["empty-parent"]);
      expect(result.protectedCount).toBe(1);
      expect(result.cascadeBlockedSkipped).toBe(1);
    });
  });

  it("rechecks protection after an in-flight delete before deleting a parent", async () => {
    await withMockedNow(FIXED_NOW, async () => {
      const sessions = [
        makeSession({ id: "first", ageMs: 1_000, title: "first", directory: "/first" }),
        makeSession({ id: "parent", ageMs: 1_000, title: "parent", directory: "/parent" }),
        makeSession({
          id: "child",
          parentID: "parent",
          ageMs: 1_000,
          title: "child",
          directory: "/child",
        }),
      ];
      const protectedIDs = new Set<string>();
      const calls: string[] = [];
      let releaseFirst!: () => void;
      let startedFirst!: () => void;
      const firstStarted = new Promise<void>((resolve) => {
        startedFirst = resolve;
      });
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const client: SweeperClient = {
        session: {
          list: async () => sessions,
          delete: async ({ path: { id } }) => {
            calls.push(id);
            if (id === "first") {
              startedFirst();
              await firstGate;
            }
            return true;
          },
        },
      };

      const sweeping = runSweep(client, opts, protectedIDs);
      await firstStarted;
      protectedIDs.add("child");
      releaseFirst();
      const result = await sweeping;

      expect(calls).toEqual(["first"]);
      expect(result.cascadeBlockedSkipped).toBe(1);
      expect(result.deleted).toBe(1);
    });
  });

  it("rejects duplicate IDs before any delete", async () => {
    await withMockedNow(FIXED_NOW, async () => {
      const client = new MockSweeperClient([
        makeSession({ id: "duplicate", ageMs: 1_000, title: "old", directory: "/old" }),
        makeSession({
          id: "duplicate",
          parentID: "other",
          ageMs: 50,
          title: "new",
          directory: "/new",
        }),
      ]);

      await expect(runSweep(client, opts, new Set())).rejects.toThrow(
        /duplicate session ID: duplicate/,
      );
      expect(client.deleteCalls).toEqual([]);
    });
  });

  it("deletes an eligible tree from its root once and counts cascaded descendants", async () => {
    await withMockedNow(FIXED_NOW, async () => {
      const client = new MockSweeperClient([
        makeSession({
          id: "child",
          parentID: "root",
          ageMs: 1_000,
          title: "child",
          directory: "/child",
        }),
        makeSession({ id: "root", ageMs: 1_000, title: "root", directory: "/root" }),
        makeSession({
          id: "grandchild",
          parentID: "child",
          ageMs: 1_000,
          title: "grandchild",
          directory: "/grandchild",
        }),
      ]);

      const result = await runSweep(client, opts, new Set());

      expect(client.deleteCalls).toEqual(["root"]);
      expect(result.deleted).toBe(3);
      expect(result.deletions.map(({ id }) => id)).toEqual(["root", "child", "grandchild"]);
    });
  });

  it("does not delete unprotected cycles or self-parent sessions", async () => {
    await withMockedNow(FIXED_NOW, async () => {
      const client = new MockSweeperClient([
        makeSession({ id: "a", parentID: "b", ageMs: 1_000, title: "a", directory: "/a" }),
        makeSession({ id: "b", parentID: "a", ageMs: 1_000, title: "b", directory: "/b" }),
        makeSession({
          id: "self",
          parentID: "self",
          ageMs: 1_000,
          title: "self",
          directory: "/self",
        }),
        makeSession({ id: "other", ageMs: 1_000, title: "other", directory: "/other" }),
      ]);

      const result = await runSweep(client, opts, new Set());

      expect(client.deleteCalls).toEqual(["other"]);
      expect(result.cascadeBlockedSkipped).toBe(3);
    });
  });

  it("uses separate main/subagent thresholds and grace before allowing cascade", async () => {
    await withMockedNow(FIXED_NOW, async () => {
      const customOpts = defaultSweeperOpts({
        expiryMs: 500,
        subagentExpiryMs: 100,
        recentActivityGraceMs: 60,
        dryRun: false,
      });
      const sessions: SessionLike[] = [
        makeSession({ id: "root", ageMs: 1_000, title: "root", directory: "/root" }),
        makeSession({
          id: "not-old-enough",
          parentID: "root",
          ageMs: 80,
          title: "young",
          directory: "/young",
        }),
        makeSession({
          id: "recent",
          parentID: "root",
          ageMs: 40,
          title: "recent",
          directory: "/recent",
        }),
        makeSession({ id: "unrelated", ageMs: 1_000, title: "other", directory: "/other" }),
      ];
      const client = new MockSweeperClient(sessions);

      const result = await runSweep(client, customOpts, new Set());

      expect(client.deleteCalls).toEqual(["unrelated"]);
      expect(result.subagentNotExpiredSkipped).toBe(1);
      expect(result.recentActiveSkipped).toBe(1);
      expect(result.cascadeBlockedSkipped).toBe(1);
    });
  });
});
