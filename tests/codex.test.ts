import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexRequestError, type CodexRpcClient, CodexTransportError } from "../src/codex-rpc.js";
import {
  type CodexRunOptions,
  formatCodexResult,
  runCodexSweep,
  scanCodexThreads,
} from "../src/codex.js";

const NOW_MS = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const STAMP = "2025-04-10T12-34-56";

const ALL_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
];

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type ThreadState = {
  id: string;
  updatedAt: number;
  parentThreadId: string | null;
  forkedFromId: string | null;
  status: unknown;
  archived: boolean;
  path: string;
};

type Spec = Pick<ThreadState, "id"> &
  Partial<ThreadState> & {
    ageMs?: number;
    omitFromList?: boolean;
  };

/** A shared fake codexHome and app-server state; each client is a separate connection. */
class Project {
  readonly home: string;
  version = "0.163.0";
  loaded: string[] = [];
  threads = new Map<string, ThreadState>();
  omitFromList = new Set<string>();
  listRequests: Array<{ method: string; params: Record<string, unknown> }> = [];
  readRequests: string[] = [];
  deleteRequests: string[] = [];
  archiveError = false;
  repeatCursor = false;
  pageSize = 100;
  listCalls = 0;
  onList: ((call: number) => void | Promise<void>) | undefined;
  deleteBehavior: ((id: string) => void | Promise<void>) | undefined;

  constructor(home: string) {
    this.home = home;
  }

  async add(spec: Spec): Promise<void> {
    const archived = spec.archived ?? false;
    const directory = join(this.home, archived ? "archived_sessions" : "sessions");
    await mkdir(directory, { recursive: true });
    const path = join(directory, `rollout-${STAMP}-${spec.id}.jsonl`);
    await writeFile(path, "");
    this.threads.set(spec.id, {
      id: spec.id,
      updatedAt: Math.floor((NOW_MS - (spec.ageMs ?? 0)) / 1000),
      parentThreadId: spec.parentThreadId ?? null,
      forkedFromId: spec.forkedFromId ?? null,
      status: spec.status ?? { type: "notLoaded" },
      archived,
      path,
    });
    if (spec.omitFromList === true) this.omitFromList.add(spec.id);
  }

  async removeThread(...ids: string[]): Promise<void> {
    for (const id of ids) {
      const thread = this.threads.get(id);
      if (!thread) throw new Error(`missing fixture thread ${id}`);
      await rm(thread.path);
      this.threads.delete(id);
    }
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (method === "thread/loaded/list") return { data: this.loaded, nextCursor: null };
    if (method === "thread/read") {
      const id = String(params.threadId);
      this.readRequests.push(id);
      const state = this.threads.get(id);
      if (state === undefined) throw new Error(`thread not found: ${id}`);
      return { thread: state };
    }
    if (method === "thread/list") {
      this.listRequests.push({ method, params });
      this.listCalls += 1;
      await this.onList?.(this.listCalls);
      if (params.archived === true && this.archiveError) {
        throw new CodexRequestError("archived listing unsupported");
      }
      if (this.repeatCursor) return { data: [], nextCursor: "loop" };
      const archived = params.archived === true;
      const ids = [...this.threads.values()]
        .filter((state) => state.archived === archived)
        .filter((state) => !this.omitFromList.has(state.id))
        .map((state) => state.id);
      const start = typeof params.cursor === "string" ? Number(params.cursor) : 0;
      const page = ids.slice(start, start + this.pageSize);
      const next = start + this.pageSize < ids.length ? String(start + this.pageSize) : null;
      return { data: page.map((id) => ({ id })), nextCursor: next };
    }
    if (method === "thread/delete") {
      const id = String(params.threadId);
      this.deleteRequests.push(id);
      if (this.deleteBehavior) await this.deleteBehavior(id);
      else await this.removeThread(id);
      return {};
    }
    throw new Error(`unexpected method: ${method}`);
  }
}

async function project(specs: Spec[] = []): Promise<Project> {
  const home = await mkdtemp(join(tmpdir(), "opencode-sweeper-codex-"));
  roots.push(home);
  const state = new Project(home);
  for (const spec of specs) await state.add(spec);
  return state;
}

const BASE: Omit<CodexRunOptions, "createClient"> = {
  expiryMs: 30 * DAY,
  subagentExpiryMs: 7 * DAY,
  recentActivityGraceMs: HOUR,
  dryRun: false,
  protect: [],
  now: () => NOW_MS,
};

function runOn(
  state: Project,
  overrides: Partial<CodexRunOptions> = {},
  replacementVersion?: string,
) {
  const clients: CodexRpcClient[] = [];
  const run = runCodexSweep({
    ...BASE,
    ...overrides,
    createClient: async () => {
      const client: CodexRpcClient = {
        codexHome: state.home,
        version: clients.length === 0 ? state.version : (replacementVersion ?? state.version),
        request: (method, params) => state.request(method, params),
        async close() {},
      };
      clients.push(client);
      return client;
    },
  });
  return { run, clients };
}

const id = (n: number): string => `0190a000-0000-7000-8000-${String(n).padStart(12, "0")}`;

function stateOf(state: Project, threadID: string): ThreadState {
  const thread = state.threads.get(threadID);
  if (thread === undefined) throw new Error(`missing fake thread ${threadID}`);
  return thread;
}

describe("codex sweep", () => {
  it("groups old replacement and current compressed rollout across roots", async () => {
    const state = await project([{ id: id(1), ageMs: 31 * DAY, archived: true }]);
    const thread = stateOf(state, id(1));
    await rm(thread.path);
    await writeFile(`${thread.path}.zst`, "");
    await mkdir(join(state.home, "sessions"));
    await writeFile(join(state.home, "sessions", `rollout-${STAMP}-${id(1)}_${id(2)}.jsonl`), "");
    const scan = await scanCodexThreads({
      version: state.version,
      codexHome: state.home,
      request: (method, params) => state.request(method, params),
      async close() {},
    });
    expect(scan.complete).toBe(true);
    expect(scan.threads).toHaveLength(1);
    expect(scan.threads[0]).toMatchObject({ id: id(1), archived: true, path: thread.path });
  });

  for (const scenario of [
    "version",
    "pagination",
    "archive",
    "path",
    "symlink",
    "status",
    "loaded",
  ]) {
    it(`sends zero deletes on unsafe discovery: ${scenario}`, async () => {
      const state = await project([{ id: id(1), ageMs: 31 * DAY }]);
      const thread = stateOf(state, id(1));
      switch (scenario) {
        case "version":
          state.version = "0.100.0";
          break;
        case "pagination":
          state.repeatCursor = true;
          break;
        case "archive":
          state.archiveError = true;
          break;
        case "path":
          thread.path = join(state.home, "outside.jsonl");
          break;
        case "symlink":
          await rm(thread.path);
          await symlink(join(state.home, "missing"), thread.path);
          break;
        case "status":
          thread.status = { type: "mystery" };
          break;
        case "loaded":
          state.loaded = [id(1)];
          break;
      }
      await expect(runOn(state).run).rejects.toThrow();
      expect(state.deleteRequests).toEqual([]);
    });
  }

  it("protects a descendant and its ancestors without blocking an unrelated root", async () => {
    const state = await project([
      { id: id(1), ageMs: 31 * DAY },
      { id: id(2), ageMs: 8 * DAY, parentThreadId: id(1) },
      { id: id(3), ageMs: 31 * DAY },
    ]);
    const result = await runOn(state, { protect: [id(2)] }).run;
    expect(state.deleteRequests).toEqual([id(3)]);
    expect(result.deleted).toBe(1);
    await expect(stat(stateOf(state, id(2)).path)).resolves.toBeDefined();
  });
  it("previews valid metadata with full filters and performs no delete", async () => {
    const state = await project([
      { id: id(1), ageMs: 31 * DAY, archived: true },
      { id: id(2), ageMs: 31 * DAY },
      { id: id(3), ageMs: HOUR / 2, parentThreadId: id(2), omitFromList: true },
      { id: id(4), ageMs: 31 * DAY, archived: true },
      { id: id(5), ageMs: 31 * DAY },
    ]);
    state.pageSize = 1;
    const { run } = runOn(state, { dryRun: true });

    const result = await run;

    expect(state.deleteRequests).toEqual([]);
    expect(result.scanned).toBe(5);
    expect(result.archivedScanned).toBe(2);
    expect(result.deletions).toContainEqual({ id: id(1), dryRun: true, archived: true });
    expect(state.readRequests).toContain(id(3));
    expect(result.blocked.map((entry) => entry.id)).toContain(id(2));
    expect(result.deletions.some((entry) => entry.id === id(2))).toBe(false);
    for (const archived of [false, true]) {
      expect(
        state.listRequests.some(
          ({ params }) => params.archived === archived && params.cursor === "1",
        ),
      ).toBe(true);
    }
    const output = formatCodexResult(result);
    expect(output).toContain("候选");
    expect(output).toContain("[DRY-RUN]");
    for (const { params } of state.listRequests) {
      expect(params.sourceKinds).toEqual(ALL_SOURCE_KINDS);
      expect(params.modelProviders).toEqual([]);
      expect(params).not.toHaveProperty("cwd");
      expect(params).not.toHaveProperty("projectId");
      expect(params.limit).toBe(100);
    }
    expect(state.listRequests.some(({ params }) => params.archived === true)).toBe(true);
    expect(state.listRequests.some(({ params }) => params.archived === false)).toBe(true);
  });

  it("uses metadata fork references even though the list never carries them", async () => {
    const state = await project([
      { id: id(12), ageMs: 31 * DAY },
      { id: id(13), ageMs: 31 * DAY, forkedFromId: id(12) },
    ]);
    const { run } = runOn(state, { dryRun: true });

    const result = await run;

    expect(result.deletions.map((entry) => entry.id)).toEqual([id(13)]);
    expect(result.blocked).toContainEqual({ id: id(12), reasons: ["被存活会话 fork 引用"] });
  });

  for (const archived of [false, true]) {
    it(`counts ${archived ? "archived" : "normal"} cascade only after files disappear`, async () => {
      const state = await project([
        { id: id(30), ageMs: 31 * DAY, archived },
        { id: id(31), ageMs: 8 * DAY, parentThreadId: id(30), archived },
      ]);
      const paths = [stateOf(state, id(30)).path, stateOf(state, id(31)).path];
      state.deleteBehavior = () => state.removeThread(id(30), id(31));
      const { run } = runOn(state);

      const result = await run;

      for (const path of paths) await expect(stat(path)).rejects.toThrow();
      expect(result.errors).toEqual([]);
      expect(result.deleted).toBe(2);
      expect(state.deleteRequests).toEqual([id(30)]);
      expect(result.deletions.map((entry) => entry.id).sort()).toEqual([id(30), id(31)].sort());
    });
  }

  it("does not count a child that survives the parent delete", async () => {
    const state = await project([
      { id: id(32), ageMs: 31 * DAY },
      { id: id(33), ageMs: 8 * DAY, parentThreadId: id(32) },
    ]);
    state.deleteBehavior = (target) => state.removeThread(target);
    const { run } = runOn(state);

    const result = await run;

    expect(result.deleted).toBe(1);
    expect(result.errors.some((entry) => entry.id === id(33))).toBe(true);
    expect(state.deleteRequests).toEqual([id(32)]);
  });

  it("reports an unplanned disappearance and stops later roots", async () => {
    const state = await project([
      { id: id(34), ageMs: 31 * DAY },
      { id: id(35), ageMs: 31 * DAY },
    ]);
    state.deleteBehavior = async (target) => {
      await state.removeThread(target);
      if (target === id(34)) await state.removeThread(id(35));
    };
    const { run } = runOn(state);

    const result = await run;

    expect(result.errors.some((entry) => entry.error.includes("计划外消失"))).toBe(true);
    expect(state.deleteRequests).toEqual([id(34)]);
  });

  it("treats a business rejection as rejected, verifies, and does not retry", async () => {
    const state = await project([{ id: id(36), ageMs: 31 * DAY }]);
    state.deleteBehavior = () => {
      throw new CodexRequestError("request rejected");
    };
    const { run } = runOn(state);

    const result = await run;

    expect(result.deleted).toBe(0);
    expect(result.errors.some((entry) => entry.error.includes("删除请求被拒绝"))).toBe(true);
    expect(state.deleteRequests).toEqual([id(36)]);
  });

  for (const version of ["0.163.0", "0.100.0"]) {
    it(`checks a timeout once with read-only replacement ${version} and stops`, async () => {
      const state = await project([
        { id: id(38), ageMs: 31 * DAY },
        { id: id(39), ageMs: 31 * DAY },
      ]);
      state.deleteBehavior = async (target) => {
        await state.removeThread(target);
        throw new CodexTransportError("delete timed out");
      };
      const { run, clients } = runOn(state, {}, version);
      const result = await run;
      expect(result.deleted).toBe(version === "0.163.0" ? 1 : 0);
      expect(
        result.errors.some((entry) =>
          entry.error.includes(version === "0.163.0" ? "结果未知" : "版本不受支持"),
        ),
      ).toBe(true);
      expect(state.deleteRequests).toEqual([id(38)]);
      expect(clients).toHaveLength(2);
    });
  }

  it("stops later roots when a younger child appears before the delete rescan", async () => {
    const state = await project([
      { id: id(45), ageMs: 31 * DAY },
      { id: id(100), ageMs: 31 * DAY },
    ]);
    state.onList = async (call) => {
      if (call === 3) {
        await state.add({
          id: id(46),
          ageMs: HOUR / 2,
          parentThreadId: id(45),
        });
      }
    };
    const { run } = runOn(state);

    const result = await run;

    expect(state.deleteRequests).toEqual([]);
    expect(result.deleted).toBe(0);
    expect(
      result.errors.some(
        (entry) => entry.id === id(45) && entry.error.includes("停止本轮后续删除"),
      ),
    ).toBe(true);
  });

  it("stops later roots when metadata changes inside the same subtree", async () => {
    const state = await project([
      { id: id(47), ageMs: 31 * DAY },
      { id: id(48), ageMs: 8 * DAY, parentThreadId: id(47) },
      { id: id(49), ageMs: 8 * DAY, parentThreadId: id(47) },
      { id: id(101), ageMs: 31 * DAY },
    ]);
    state.onList = (call) => {
      if (call === 3) {
        stateOf(state, id(48)).parentThreadId = id(49);
      }
    };
    const { run } = runOn(state);

    const result = await run;

    expect(state.deleteRequests).toEqual([]);
    expect(result.deleted).toBe(0);
    expect(
      result.errors.some((entry) => entry.id === id(47) && entry.error.includes("metadata 已变化")),
    ).toBe(true);
  });

  it("deletes independent roots but keeps systemError errors", async () => {
    const state = await project([
      { id: id(53), ageMs: 31 * DAY },
      { id: id(54), ageMs: 8 * DAY, parentThreadId: id(53), status: { type: "systemError" } },
      { id: id(56), ageMs: 8 * DAY, parentThreadId: id(54) },
      { id: id(55), ageMs: 31 * DAY },
    ]);
    const { run } = runOn(state);

    const result = await run;

    expect(result.deleted).toBe(1);
    expect(result.errors.some((entry) => entry.id === id(54))).toBe(true);
    expect(state.deleteRequests).toEqual([id(55)]);
    for (const n of [53, 54, 56]) {
      await expect(stat(stateOf(state, id(n)).path)).resolves.toBeDefined();
    }
  });

  it("keeps a protected session that becomes systemError after the last delete", async () => {
    const state = await project([
      { id: id(110), ageMs: 31 * DAY },
      { id: id(111), ageMs: 31 * DAY },
    ]);
    state.onList = (call) => {
      // Root 110's post-delete rescan starts at call 5; 111 was unreachable
      // (protected) before, and no later freshPlan will re-check it.
      if (call === 5) stateOf(state, id(111)).status = { type: "systemError" };
    };
    const { run } = runOn(state, { protect: [id(111)] });

    const result = await run;

    expect(result.deleted).toBe(1);
    expect(result.deletions).toEqual([{ id: id(110), dryRun: false }]);
    expect(result.errors).toContainEqual({
      id: id(111),
      error: "状态异常（systemError），涉及该树的删除已阻断",
    });
    expect(state.deleteRequests).toEqual([id(110)]);
  });

  for (const status of [
    { type: "idle" },
    { type: "active", activeFlags: ["waitingOnUserInput"] },
  ]) {
    it(`protects an ${status.type} parent but permits its expired child`, async () => {
      const state = await project([
        { id: id(56), ageMs: 31 * DAY, status },
        { id: id(57), ageMs: 8 * DAY, parentThreadId: id(56) },
      ]);
      const result = await runOn(state).run;
      expect(result.errors).toEqual([]);
      expect(result.deleted).toBe(1);
      expect(state.deleteRequests).toEqual([id(57)]);
    });
  }
});
