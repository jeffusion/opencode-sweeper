import type { Dirent, Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { CodexRequestError, type CodexRpcClient, createCodexClient } from "./codex-rpc.js";

export const SUPPORTED_CODEX_VERSION = "0.163.0";

const PAGE_LIMIT = 100;
const MAX_LIST_PAGES = 1000;
const MAX_UPDATED_AT_SECONDS = 100_000_000_000; // 1e11: larger looks like milliseconds
const UUID_SOURCE = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const TIMESTAMP_SOURCE = "\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}";
// rollout-<19char timestamp>-<stable thread UUID>[_<replacement UUID>].jsonl[.zst]
const ROLLOUT_NAME = new RegExp(
  `^rollout-(${TIMESTAMP_SOURCE})-(${UUID_SOURCE})(?:_(${UUID_SOURCE}))?\\.jsonl(?:\\.zst)?$`,
);

// The protocol defaults sourceKinds to interactive sources, which hides
// subagents; every request must spell out all ten sources explicitly.
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
] as const;

const ACTIVE_FLAGS = new Set(["waitingOnApproval", "waitingOnUserInput"]);
const SYSTEM_ERROR_MESSAGE = "状态异常（systemError），涉及该树的删除已阻断";

export type CodexThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active"; activeFlags: string[] };

export type CodexThread = {
  id: string;
  /** Unix seconds, from thread/read metadata. */
  updatedAt: number;
  parentThreadId: string | null;
  forkedFromId: string | null;
  status: CodexThreadStatus;
  archived: boolean;
  /** Current rollout path reported by thread/read metadata. */
  path: string;
};

export type CodexScan = {
  threads: CodexThread[];
  complete: boolean;
  errors: string[];
};

export type CodexPlanCounts = {
  protectedCount: number;
  recentActiveSkipped: number;
  mainNotExpiredSkipped: number;
  subagentNotExpiredSkipped: number;
  cascadeBlockedSkipped: number;
};

export type CodexPlan = {
  roots: Array<{ id: string; ids: string[] }>;
  blocked: Array<{ id: string; reasons: string[] }>;
  counts: CodexPlanCounts;
  errors: Array<{ id: string; error: string }>;
};

export type CodexDeletion = {
  id: string;
  parentThreadId?: string;
  archived?: true;
  dryRun: boolean;
};

export type CodexSweepResult = CodexPlanCounts & {
  scanned: number;
  archivedScanned: number;
  deleted: number;
  dryRunSkipped: number;
  dryRun: boolean;
  errors: Array<{ id: string; error: string }>;
  deletions: CodexDeletion[];
  blocked: Array<{ id: string; reasons: string[] }>;
};

export type CodexPlanOptions = {
  expiryMs: number;
  subagentExpiryMs: number;
  recentActivityGraceMs: number;
  protect: readonly string[];
  loadedIds?: ReadonlySet<string>;
  nowMs?: number;
};

export type CodexRunOptions = {
  expiryMs: number;
  subagentExpiryMs: number;
  recentActivityGraceMs: number;
  dryRun: boolean;
  protect: readonly string[];
  env?: NodeJS.ProcessEnv;
  createClient?: (env: NodeJS.ProcessEnv) => Promise<CodexRpcClient>;
  now?: () => number;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasKey(record: Record<string, unknown>, key: string, context: string): unknown {
  if (!Object.hasOwn(record, key)) {
    throw new Error(`Codex 会话缺少字段 ${key}（${context}）`);
  }
  return record[key];
}

function nullableThreadID(value: unknown, field: string, id: string): string | null {
  if (value === null) return null;
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`Codex 会话 ${id} 的 ${field} 不是 null 或非空字符串`);
}

function parseStatus(value: unknown, id: string): CodexThreadStatus {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Codex 会话 ${id} 的 status 结构无效`);
  }
  const type = (value as { type?: unknown }).type;
  if (type === "active") {
    const flags = (value as { activeFlags?: unknown }).activeFlags;
    if (
      !Array.isArray(flags) ||
      flags.some((flag) => typeof flag !== "string" || !ACTIVE_FLAGS.has(flag))
    ) {
      throw new Error(`Codex 会话 ${id} 的 activeFlags 无效`);
    }
    return { type: "active", activeFlags: [...flags] as string[] };
  }
  if (type === "notLoaded" || type === "idle" || type === "systemError") {
    return { type };
  }
  throw new Error(`Codex 会话 ${id} 的 status 未知: ${String(type)}`);
}

type InventoryFile = { path: string; plainPath: string; archived: boolean };
type InventoryGroup = { files: InventoryFile[]; plainPaths: Set<string> };

function plainPath(path: string): string {
  return path.endsWith(".zst") ? path.slice(0, -4) : path;
}

async function readInventoryRoot(
  root: string,
  archived: boolean,
  groups: Map<string, InventoryGroup>,
): Promise<void> {
  let info: Stats;
  try {
    info = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`无法读取 Codex 会话目录 ${root}: ${messageOf(error)}`);
  }
  if (info.isSymbolicLink()) throw new Error(`Codex 会话目录是 symlink，拒绝跟随: ${root}`);
  if (!info.isDirectory()) throw new Error(`Codex 会话根不是目录: ${root}`);

  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    if (directory === undefined) break;
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw new Error(`无法读取 Codex 会话目录 ${directory}: ${messageOf(error)}`);
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Codex 会话目录中存在 symlink，拒绝跟随: ${full}`);
      }
      const lower = entry.name.toLowerCase();
      const suspicious = lower.includes("rollout") || lower.includes(".jsonl");
      if (suspicious && !entry.isFile()) {
        // A rollout-looking directory, FIFO or socket cannot be mapped and must
        // not be silently dropped; ordinary non-file entries stay ignored.
        throw new Error(`Codex 会话目录中存在疑似会话条目但不是普通文件: ${full}`);
      }
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!suspicious) continue;
      const match = ROLLOUT_NAME.exec(entry.name);
      if (match === null) throw new Error(`无法解析 Codex rollout 文件名: ${full}`);
      const id = match[2];
      if (id === undefined) throw new Error(`无法解析 Codex rollout 文件名: ${full}`);
      const group = groups.get(id) ?? { files: [], plainPaths: new Set<string>() };
      const file = { path: full, plainPath: plainPath(full), archived };
      group.files.push(file);
      group.plainPaths.add(file.plainPath);
      groups.set(id, group);
    }
  }
}

async function inventoryCodexHome(home: string): Promise<Map<string, InventoryGroup>> {
  const groups = new Map<string, InventoryGroup>();
  await readInventoryRoot(join(home, "sessions"), false, groups);
  await readInventoryRoot(join(home, "archived_sessions"), true, groups);
  return groups;
}

function parseListPageIDs(raw: unknown): { ids: string[]; nextCursor?: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Codex thread/list 响应结构无效");
  }
  const data = (raw as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error("Codex thread/list 响应缺少 data 数组");
  }
  const ids: string[] = [];
  for (const entry of data) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Codex thread/list 返回了无效的会话对象");
    }
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error("Codex thread/list 返回了无效的会话 ID");
    }
    ids.push(id);
  }
  const cursor = (raw as { nextCursor?: unknown }).nextCursor;
  if (cursor === null || cursor === undefined || cursor === "") {
    return { ids };
  }
  if (typeof cursor !== "string") {
    throw new Error("Codex thread/list 响应包含无效的 nextCursor");
  }
  return { ids, nextCursor: cursor };
}

function listParams(archived: boolean, cursor: string | undefined): Record<string, unknown> {
  const params: Record<string, unknown> = {
    archived,
    limit: PAGE_LIMIT,
    modelProviders: [],
    sortDirection: "asc",
    sortKey: "updated_at",
    sourceKinds: [...ALL_SOURCE_KINDS],
  };
  if (cursor !== undefined) params.cursor = cursor;
  return params;
}

async function listGroupIDs(client: CodexRpcClient, archived: boolean): Promise<string[]> {
  const ids: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const response = await client.request("thread/list", listParams(archived, cursor));
    const parsed = parseListPageIDs(response);
    ids.push(...parsed.ids);
    if (parsed.nextCursor === undefined) return ids;
    if (seenCursors.has(parsed.nextCursor)) {
      throw new Error("Codex thread/list 游标重复或分页未前进");
    }
    seenCursors.add(parsed.nextCursor);
    cursor = parsed.nextCursor;
  }
  throw new Error("Codex thread/list 分页超过上限");
}

function parseMetadata(raw: unknown, requestedID: string, group: InventoryGroup): CodexThread {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Codex thread/read ${requestedID} 响应结构无效`);
  }
  const thread = (raw as { thread?: unknown }).thread;
  if (thread === null || typeof thread !== "object" || Array.isArray(thread)) {
    throw new Error(`Codex thread/read ${requestedID} 响应缺少 thread`);
  }
  const record = thread as Record<string, unknown>;
  const id = hasKey(record, "id", `thread/read ${requestedID}`);
  if (id !== requestedID) {
    throw new Error(`Codex thread/read 返回 ID 与请求不一致: ${String(id)} != ${requestedID}`);
  }
  const updatedAt = hasKey(record, "updatedAt", id);
  if (
    typeof updatedAt !== "number" ||
    !Number.isInteger(updatedAt) ||
    updatedAt < 0 ||
    updatedAt > MAX_UPDATED_AT_SECONDS
  ) {
    throw new Error(`Codex 会话 ${id} 的 updatedAt 不是合理的整数秒`);
  }
  const parentThreadId = nullableThreadID(
    hasKey(record, "parentThreadId", id),
    "parentThreadId",
    id,
  );
  const forkedFromId = nullableThreadID(hasKey(record, "forkedFromId", id), "forkedFromId", id);
  const status = parseStatus(hasKey(record, "status", id), id);
  const currentPath = hasKey(record, "path", id);
  if (typeof currentPath !== "string" || currentPath === "" || !isAbsolute(currentPath)) {
    throw new Error(`Codex 会话 ${id} 的 path 不是绝对路径`);
  }
  const normalized = plainPath(currentPath);
  if (!group.plainPaths.has(normalized)) {
    throw new Error(`Codex 会话 ${id} 的 path 与文件 inventory 不匹配: ${currentPath}`);
  }
  const file = group.files.find((entry) => entry.plainPath === normalized);
  if (file === undefined) {
    throw new Error(`Codex 会话 ${id} 的 path 无法映射到归档 root`);
  }
  return {
    id,
    updatedAt,
    parentThreadId,
    forkedFromId,
    status,
    archived: file.archived,
    path: currentPath,
  };
}

/**
 * Complete discovery: supported version + verified codexHome, both official
 * archive lists, the standard rollout filename inventory, and one official
 * thread/read per union ID. Anything unreadable makes the whole scan
 * incomplete; a partial view is never returned.
 */
export async function scanCodexThreads(client: CodexRpcClient): Promise<CodexScan> {
  try {
    if (!isSupportedVersion(client.version)) {
      throw new Error(
        `不支持的 Codex 版本: ${client.version.trim()}（仅支持 ${SUPPORTED_CODEX_VERSION}）`,
      );
    }
    const home = client.codexHome;
    if (typeof home !== "string" || home === "" || !isAbsolute(home)) {
      throw new Error("Codex codexHome 不是绝对路径");
    }
    let homeInfo: Stats;
    try {
      homeInfo = await lstat(home);
    } catch (error) {
      throw new Error(`Codex codexHome 不可读: ${messageOf(error)}`);
    }
    if (!homeInfo.isDirectory()) {
      throw new Error("Codex codexHome 不是目录");
    }
    const normal = await listGroupIDs(client, false);
    const archived = await listGroupIDs(client, true);
    const groups = await inventoryCodexHome(home);
    const normalSet = new Set(normal);
    const archivedSet = new Set(archived);
    for (const id of normalSet) {
      if (archivedSet.has(id)) {
        throw new Error(`Codex 会话 ID 冲突（同一会话出现在多个列表分组）: ${id}`);
      }
    }
    const ids = [...new Set([...normalSet, ...archivedSet, ...groups.keys()])].sort();
    const threads: CodexThread[] = [];
    for (const id of ids) {
      const group = groups.get(id);
      if (group === undefined) {
        throw new Error(`官方列表中的会话 ${id} 缺少标准 rollout 文件`);
      }
      const raw = await client.request("thread/read", { threadId: id, includeTurns: false });
      threads.push(parseMetadata(raw, id, group));
    }
    return { threads, complete: true, errors: [] };
  } catch (error) {
    return { threads: [], complete: false, errors: [messageOf(error)] };
  }
}

async function listLoadedThreadIDs(client: CodexRpcClient): Promise<Set<string>> {
  const ids = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const params: Record<string, unknown> = { limit: PAGE_LIMIT };
    if (cursor !== undefined) params.cursor = cursor;
    const raw = await client.request("thread/loaded/list", params);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Codex thread/loaded/list 响应结构无效");
    }
    const data = (raw as { data?: unknown }).data;
    if (!Array.isArray(data) || data.some((entry) => typeof entry !== "string")) {
      throw new Error("Codex thread/loaded/list 响应 data 无效");
    }
    for (const id of data as string[]) ids.add(id);
    const next = (raw as { nextCursor?: unknown }).nextCursor;
    if (next === null || next === undefined || next === "") return ids;
    if (typeof next !== "string") {
      throw new Error("Codex thread/loaded/list 响应包含无效的 nextCursor");
    }
    if (seenCursors.has(next)) {
      throw new Error("Codex thread/loaded/list 游标重复或分页未前进");
    }
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error("Codex thread/loaded/list 分页超过上限");
}

function isSupportedVersion(version: string): boolean {
  const match = /^(?:codex(?:-cli)?\s+)?(\d+\.\d+\.\d+)$/.exec(version.trim());
  return match?.[1] === SUPPORTED_CODEX_VERSION;
}

function depthOf(byID: ReadonlyMap<string, CodexThread>, thread: CodexThread): number {
  let depth = 0;
  let current = thread;
  const visited = new Set<string>([thread.id]);
  while (current.parentThreadId !== null) {
    const parent = byID.get(current.parentThreadId);
    if (parent === undefined || visited.has(parent.id)) break;
    visited.add(parent.id);
    depth += 1;
    current = parent;
  }
  return depth;
}

/**
 * Build the spawn forest, blocking sets and deletion roots from one complete
 * enumeration. Fork references only block; they are never treated as parent
 * edges. Any unreadable relation fails closed.
 */
export function planCodexDeletions(
  threads: readonly CodexThread[],
  options: CodexPlanOptions,
): CodexPlan {
  const nowMs = options.nowMs ?? Date.now();
  const byID = new Map<string, CodexThread>();
  for (const thread of threads) {
    if (byID.has(thread.id)) {
      throw new Error(`Codex 会话 ID 冲突: ${thread.id}`);
    }
    byID.set(thread.id, thread);
  }

  const children = new Map<string, string[]>();
  const forkSources = new Set<string>();
  for (const thread of threads) {
    if (thread.parentThreadId !== null) {
      const siblings = children.get(thread.parentThreadId) ?? [];
      siblings.push(thread.id);
      children.set(thread.parentThreadId, siblings);
    }
    if (thread.forkedFromId !== null) forkSources.add(thread.forkedFromId);
  }

  const reasons = new Map<string, Set<string>>();
  const addReason = (id: string, reason: string): void => {
    const set = reasons.get(id) ?? new Set<string>();
    set.add(reason);
    reasons.set(id, set);
  };
  const addAncestors = (id: string, reason: string): void => {
    let current = byID.get(id);
    const visited = new Set<string>([id]);
    while (current !== undefined && current.parentThreadId !== null) {
      const parentID = current.parentThreadId;
      if (visited.has(parentID)) break;
      visited.add(parentID);
      addReason(parentID, reason);
      current = byID.get(parentID);
    }
  };
  const descendantsOf = (id: string): string[] => {
    const found: string[] = [];
    const visited = new Set<string>([id]);
    const stack = [...(children.get(id) ?? [])];
    while (stack.length > 0) {
      const next = stack.pop();
      if (next === undefined || visited.has(next)) continue;
      visited.add(next);
      found.push(next);
      stack.push(...(children.get(next) ?? []));
    }
    return found;
  };

  const protectedIDs = new Set(options.protect);
  const observedProtected = new Set<string>();
  for (const thread of threads) {
    if (!protectedIDs.has(thread.id)) continue;
    observedProtected.add(thread.id);
    addReason(thread.id, "受保护");
    addAncestors(thread.id, "受保护会话的祖先");
  }

  const errors: CodexPlan["errors"] = [];
  for (const thread of threads) {
    if (thread.status.type === "active") {
      addReason(thread.id, "运行中（active）");
      addAncestors(thread.id, "运行中（active）的祖先");
      continue;
    }
    if (thread.status.type === "idle") {
      // idle means this app-server has the thread loaded but not running; it
      // still blocks itself and its ancestors even when loaded/list is empty.
      addReason(thread.id, "空闲（idle）");
      addAncestors(thread.id, "空闲（idle）的祖先");
      continue;
    }
    if (thread.status.type === "systemError") {
      errors.push({
        id: thread.id,
        error: SYSTEM_ERROR_MESSAGE,
      });
      addReason(thread.id, "状态异常（systemError）");
      addAncestors(thread.id, "状态异常（systemError）的祖先");
      for (const childID of descendantsOf(thread.id)) {
        addReason(childID, "状态异常（systemError）的后代");
      }
    }
  }

  for (const sourceID of forkSources) {
    if (!byID.has(sourceID)) continue;
    addReason(sourceID, "被存活会话 fork 引用");
    addAncestors(sourceID, "被存活会话 fork 引用的祖先");
  }

  if (options.loadedIds !== undefined && options.loadedIds.size > 0) {
    // A non-empty loaded list means this connection already has sessions
    // loaded; the run must not delete anything at all.
    for (const thread of threads) {
      addReason(thread.id, "本连接 loaded 列表非空，阻断全部删除");
    }
  }

  const relationState = (thread: CodexThread): "ok" | "unknown" | "cycle" => {
    let current: CodexThread | undefined = thread;
    const visited = new Set<string>();
    while (current !== undefined) {
      if (visited.has(current.id)) return "cycle";
      visited.add(current.id);
      if (current.parentThreadId === null) return "ok";
      current = byID.get(current.parentThreadId);
      if (current === undefined) return "unknown";
    }
    return "ok";
  };
  for (const thread of threads) {
    const state = relationState(thread);
    if (state === "ok") continue;
    const reason = state === "unknown" ? "父会话不在本次完整枚举结果中" : "父链成环";
    addReason(thread.id, reason);
    for (const childID of descendantsOf(thread.id)) addReason(childID, reason);
  }

  const counts: CodexPlanCounts = {
    protectedCount: 0,
    recentActiveSkipped: 0,
    mainNotExpiredSkipped: 0,
    subagentNotExpiredSkipped: 0,
    cascadeBlockedSkipped: 0,
  };
  const deletable = new Set<string>();
  for (const thread of threads) {
    if (observedProtected.has(thread.id)) {
      counts.protectedCount += 1;
      continue;
    }
    const ageMs = nowMs - thread.updatedAt * 1000;
    if (ageMs < options.recentActivityGraceMs) {
      counts.recentActiveSkipped += 1;
      continue;
    }
    const thresholdMs =
      thread.parentThreadId === null ? options.expiryMs : options.subagentExpiryMs;
    if (ageMs < thresholdMs) {
      if (thread.parentThreadId === null) {
        counts.mainNotExpiredSkipped += 1;
      } else {
        counts.subagentNotExpiredSkipped += 1;
      }
      continue;
    }
    if ((reasons.get(thread.id)?.size ?? 0) > 0) {
      counts.cascadeBlockedSkipped += 1;
      continue;
    }
    deletable.add(thread.id);
  }

  const roots: CodexPlan["roots"] = [];
  const covered = new Set<string>();
  const ordered = threads
    .filter((thread) => deletable.has(thread.id))
    .map((thread) => ({ thread, depth: depthOf(byID, thread) }))
    .sort((left, right) => left.depth - right.depth);
  for (const { thread } of ordered) {
    if (covered.has(thread.id)) continue;
    const ids = [thread.id, ...descendantsOf(thread.id)];
    if (ids.every((id) => deletable.has(id))) {
      roots.push({ id: thread.id, ids });
      for (const id of ids) covered.add(id);
    } else {
      counts.cascadeBlockedSkipped += 1;
      addReason(thread.id, "子树包含不可删除会话");
    }
  }

  const blocked: CodexPlan["blocked"] = [];
  for (const thread of threads) {
    const set = reasons.get(thread.id);
    if (set !== undefined && set.size > 0) {
      blocked.push({ id: thread.id, reasons: [...set] });
    }
  }

  return { roots, blocked, counts, errors };
}

function makeResult(scan: CodexScan, plan: CodexPlan, dryRun: boolean): CodexSweepResult {
  return {
    ...plan.counts,
    scanned: scan.threads.length,
    archivedScanned: scan.threads.filter((thread) => thread.archived).length,
    deleted: 0,
    dryRunSkipped: 0,
    dryRun,
    errors: [...plan.errors],
    deletions: [],
    blocked: plan.blocked,
  };
}

function deletionRecord(
  thread: CodexThread | undefined,
  id: string,
  dryRun: boolean,
): CodexDeletion {
  const record: CodexDeletion = { id, dryRun };
  if (thread?.parentThreadId !== null && thread?.parentThreadId !== undefined) {
    record.parentThreadId = thread.parentThreadId;
  }
  if (thread?.archived === true) record.archived = true;
  return record;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return left.every((id) => expected.has(id));
}

function statusKey(status: CodexThreadStatus): string {
  return status.type === "active"
    ? `active:${[...status.activeFlags].sort().join(",")}`
    : status.type;
}

/** Any projected metadata change for one node invalidates its planned root. */
function metadataChanged(before: CodexThread, after: CodexThread): boolean {
  return (
    before.parentThreadId !== after.parentThreadId ||
    before.forkedFromId !== after.forkedFromId ||
    before.updatedAt !== after.updatedAt ||
    before.path !== after.path ||
    before.archived !== after.archived ||
    statusKey(before.status) !== statusKey(after.status)
  );
}

async function safeClose(client: CodexRpcClient | undefined): Promise<void> {
  if (client === undefined) return;
  try {
    await client.close();
  } catch {
    // Best effort: a broken pipe while shutting down must not mask the result.
  }
}

/**
 * Run a Codex sweep. Version/capability failures throw (no deletion happens);
 * runtime deletion failures are collected in the result so earlier confirmed
 * deletions stay visible.
 */
export async function runCodexSweep(options: CodexRunOptions): Promise<CodexSweepResult> {
  const create = options.createClient ?? createCodexClient;
  const env = options.env ?? process.env;
  const nowMs = options.now ? options.now() : Date.now();

  let client: CodexRpcClient | null = await create(env);
  const current = (): CodexRpcClient => {
    if (client === null) throw new Error("app-server 连接已关闭");
    return client;
  };
  try {
    if (!isSupportedVersion(current().version)) {
      throw new Error(
        `不支持的 Codex 版本: ${current().version.trim()}（仅支持 ${SUPPORTED_CODEX_VERSION}）`,
      );
    }
    const codexHome = current().codexHome;

    const initial = await scanCodexThreads(current());
    if (!initial.complete) {
      throw new Error(`Codex 完整发现失败: ${initial.errors.join("; ")}`);
    }
    const loaded = await listLoadedThreadIDs(current());
    if (loaded.size > 0) {
      throw new Error("本连接 thread/loaded/list 非空，已阻断全部删除");
    }
    const planOptions: CodexPlanOptions = {
      expiryMs: options.expiryMs,
      subagentExpiryMs: options.subagentExpiryMs,
      recentActivityGraceMs: options.recentActivityGraceMs,
      protect: options.protect,
      loadedIds: loaded,
      nowMs,
    };
    const plan = planCodexDeletions(initial.threads, planOptions);
    const result = makeResult(initial, plan, options.dryRun);

    if (options.dryRun) {
      const byID = new Map(initial.threads.map((thread) => [thread.id, thread]));
      for (const root of plan.roots) {
        for (const id of root.ids) {
          result.dryRunSkipped += 1;
          result.deletions.push(deletionRecord(byID.get(id), id, true));
        }
      }
      return result;
    }

    const initialByID = new Map(initial.threads.map((thread) => [thread.id, thread]));
    for (const planned of plan.roots) {
      const fresh = await scanCodexThreads(current());
      if (!fresh.complete) {
        result.errors.push({
          id: planned.id,
          error: `删除前完整发现失败: ${fresh.errors.join("; ")}`,
        });
        break;
      }

      let freshLoaded: Set<string>;
      try {
        freshLoaded = await listLoadedThreadIDs(current());
      } catch (error) {
        result.errors.push({
          id: planned.id,
          error: `删除前 loaded 重验失败: ${messageOf(error)}`,
        });
        break;
      }
      if (freshLoaded.size > 0) {
        result.errors.push({
          id: planned.id,
          error: "本连接 thread/loaded/list 非空，已阻断全部删除",
        });
        break;
      }

      let freshPlan: CodexPlan;
      try {
        freshPlan = planCodexDeletions(fresh.threads, planOptions);
      } catch (error) {
        result.errors.push({
          id: planned.id,
          error: `删除前重验规划失败: ${messageOf(error)}`,
        });
        break;
      }
      for (const revalidationError of freshPlan.errors) {
        const duplicate = result.errors.some(
          (entry) => entry.id === revalidationError.id && entry.error === revalidationError.error,
        );
        if (!duplicate) result.errors.push(revalidationError);
      }
      const freshRoot = freshPlan.roots.find((root) => root.id === planned.id);
      if (freshRoot === undefined || !sameSet(freshRoot.ids, planned.ids)) {
        result.errors.push({
          id: planned.id,
          error: "删除前重验发现子树、关系或状态已变化，停止本轮后续删除",
        });
        break;
      }

      const freshByID = new Map(fresh.threads.map((thread) => [thread.id, thread]));
      const metadataDiffer = freshRoot.ids.some((id) => {
        const before = initialByID.get(id);
        const after = freshByID.get(id);
        return before === undefined || after === undefined || metadataChanged(before, after);
      });
      if (metadataDiffer) {
        result.errors.push({
          id: planned.id,
          error: "删除前重验发现父链、状态、path 或 metadata 已变化，停止本轮后续删除",
        });
        break;
      }

      const expected = new Set(freshRoot.ids);
      let outcome: "ok" | "rejected" | "unknown" = "ok";
      try {
        await current().request("thread/delete", { threadId: planned.id });
      } catch (error) {
        if (error instanceof CodexRequestError) {
          result.errors.push({ id: planned.id, error: `删除请求被拒绝: ${messageOf(error)}` });
          outcome = "rejected";
        } else {
          result.errors.push({
            id: planned.id,
            error: `删除结果未知（超时或传输中断）: ${messageOf(error)}`,
          });
          outcome = "unknown";
        }
      }

      if (outcome === "unknown") {
        // The response may or may not have reached the server. Never resend;
        // verify through a fresh read-only app-server instead.
        await safeClose(client ?? undefined);
        client = null;
        let post: CodexScan;
        try {
          const replacement = await create(env);
          client = replacement;
          if (!isSupportedVersion(replacement.version)) {
            throw new Error(
              `只读复核客户端版本不受支持: ${replacement.version.trim()}（仅支持 ${SUPPORTED_CODEX_VERSION}）`,
            );
          }
          if (replacement.codexHome !== codexHome) {
            throw new Error("只读复核客户端 codexHome 与初始连接不一致");
          }
          post = await scanCodexThreads(replacement);
          if (!post.complete) throw new Error(post.errors.join("; "));
        } catch (error) {
          result.errors.push({ id: planned.id, error: `只读复核失败: ${messageOf(error)}` });
          break;
        }
        reconcile(result, expected, fresh, post, freshByID);
        break;
      }

      let post = await scanCodexThreads(current());
      let rebuiltReadOnly = false;
      let postScanFault: string | undefined;
      if (!post.complete) {
        // The app-server may have died with the delete response; fall back to
        // a fresh read-only process once. A rebuilt client must never issue
        // another delete, and its version must be verified before trusting an
        // empty enumeration as "everything was deleted".
        postScanFault = post.errors.join("; ");
        await safeClose(client ?? undefined);
        client = null;
        try {
          const replacement = await create(env);
          client = replacement;
          if (!isSupportedVersion(replacement.version)) {
            throw new Error(
              `只读复核客户端版本不受支持: ${replacement.version.trim()}（仅支持 ${SUPPORTED_CODEX_VERSION}）`,
            );
          }
          if (replacement.codexHome !== codexHome) {
            throw new Error("只读复核客户端 codexHome 与初始连接不一致");
          }
          post = await scanCodexThreads(replacement);
          if (!post.complete) throw new Error(post.errors.join("; "));
        } catch (fallbackError) {
          result.errors.push({
            id: planned.id,
            error: `删除后复核失败（原扫描错误: ${postScanFault}）: ${messageOf(fallbackError)}`,
          });
          break;
        }
        rebuiltReadOnly = true;
      }

      const verified = reconcile(result, expected, fresh, post, freshByID);
      if (postScanFault !== undefined) {
        result.errors.push({
          id: planned.id,
          error: `删除后复核扫描失败，已用只读新进程复核: ${postScanFault}`,
        });
      }
      if (rebuiltReadOnly || !verified || outcome === "rejected") break;
    }

    return result;
  } finally {
    await safeClose(client ?? undefined);
  }
}

/**
 * Confirm the real outcome of one delete: only IDs missing from the post
 * snapshot count as deleted, and any unplanned disappearance is an error.
 */
function reconcile(
  result: CodexSweepResult,
  expected: ReadonlySet<string>,
  before: CodexScan,
  after: CodexScan,
  beforeByID: ReadonlyMap<string, CodexThread>,
): boolean {
  const afterIDs = new Set(after.threads.map((thread) => thread.id));
  let ok = true;
  for (const thread of after.threads) {
    if (thread.status.type !== "systemError") continue;
    const duplicate = result.errors.some(
      (entry) => entry.id === thread.id && entry.error === SYSTEM_ERROR_MESSAGE,
    );
    if (!duplicate) result.errors.push({ id: thread.id, error: SYSTEM_ERROR_MESSAGE });
  }
  for (const id of expected) {
    if (afterIDs.has(id)) {
      result.errors.push({ id, error: "删除后仍存在" });
      ok = false;
      continue;
    }
    result.deleted += 1;
    result.deletions.push(deletionRecord(beforeByID.get(id), id, false));
  }
  const unexpected = before.threads
    .filter((thread) => !expected.has(thread.id) && !afterIDs.has(thread.id))
    .map((thread) => thread.id);
  if (unexpected.length > 0) {
    result.errors.push({ id: unexpected[0] ?? "", error: `计划外消失: ${unexpected.join(", ")}` });
    ok = false;
  }
  return ok;
}

export function formatCodexResult(result: CodexSweepResult): string {
  const lines = [
    result.dryRun
      ? "Codex 扫描完成（预览）：以下条目为候选，不保证可以删除。"
      : result.errors.length > 0
        ? "Codex 清理结束，存在错误。"
        : "Codex 清理完成。",
    `扫描: ${result.scanned}`,
    `归档扫描: ${result.archivedScanned}`,
    `已删除: ${result.deleted}`,
    `受保护: ${result.protectedCount}`,
    `最近活动跳过: ${result.recentActiveSkipped}`,
    `主会话未过期跳过: ${result.mainNotExpiredSkipped}`,
    `子会话未过期跳过: ${result.subagentNotExpiredSkipped}`,
    `级联阻塞跳过: ${result.cascadeBlockedSkipped}`,
    `预览跳过: ${result.dryRunSkipped}`,
    `错误: ${result.errors.length}`,
  ];
  if (result.deletions.length > 0) {
    lines.push(result.dryRun ? "候选（不保证可删除）:" : "删除明细:");
    for (const deletion of result.deletions) {
      const tag = deletion.dryRun ? "DRY-RUN" : "DELETED";
      const archived = deletion.archived === true ? " [archived]" : "";
      const parent =
        deletion.parentThreadId === undefined ? "" : ` (parent: ${deletion.parentThreadId})`;
      lines.push(`  [${tag}] ${deletion.id}${archived}${parent}`);
    }
  }
  if (result.blocked.length > 0) {
    lines.push("受阻:");
    for (const entry of result.blocked) {
      lines.push(`  ${entry.id}: ${entry.reasons.join("; ")}`);
    }
  }
  return lines.join("\n");
}
