import { type OpenCode, isSessionNotFoundError } from "@opencode/client";
import type { SessionInfo } from "@opencode/client";
import type { Plugin } from "@opencode/plugin";
import { hasVerifiedPackagePlugin, runV2AutoUpdate } from "./auto-update-v2.js";
import { parseOptions } from "./options.js";
import { redactSecrets } from "./redact.js";
import {
  type SessionLike,
  SweepAbortError,
  type SweepResult,
  type SweeperClient,
  runSweep,
} from "./sweep.js";
import { resolveCurrentProcessClient } from "./v2-endpoint.js";
import { runSweepExclusive, sweepQueueID } from "./v2-sweep-queue.js";

export { redactSecrets };

type SetupContext = Plugin.Context;
type AutoUpdateRunner = typeof runV2AutoUpdate;
type MakeClient = (signal: AbortSignal) => Promise<ReturnType<typeof OpenCode.make>>;
type SetupV2Options = {
  runAutoUpdate?: AutoUpdateRunner;
  retryDelayMs?: number;
  makeClient?: MakeClient;
};
const ABORTED_AUTO_UPDATE = Symbol("aborted auto-update");

function awaitAbortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T | typeof ABORTED_AUTO_UPDATE> {
  if (signal.aborted) return Promise.resolve(ABORTED_AUTO_UPDATE);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      resolve(ABORTED_AUTO_UPDATE);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

const COMMAND_TEMPLATE =
  "Run the `sweep` tool now and report its result back to the user verbatim. Do not summarize or omit counts.";

// Only a host version whose archived-list semantics were verified in an isolated
// environment may be swept. 2.1.3 is the audited baseline; a newer version needs the
// same verification before it is added here. Anything else is diagnose-only (zero deletes).
const VERIFIED_ARCHIVED_HOST_VERSIONS = new Set(["2.1.3"]);

function assertVerifiedArchivedHost(version: string): void {
  if (VERIFIED_ARCHIVED_HOST_VERSIONS.has(version)) return;
  throw new Error(
    `OpenCode host version ${version === "" ? "unknown" : version} is not supported for archived session enumeration; refusing to sweep.`,
  );
}

/** Format an error for logs without authorization headers or other secret fields. */
export function redactError(error: unknown): string {
  const name = error instanceof Error ? redactSecrets(error.name) : "Error";
  const message = error instanceof Error ? error.message : "unexpected error";
  return `${name}: ${redactSecrets(message)}`;
}

function isSessionMissing(error: unknown, id: string): boolean {
  return isSessionNotFoundError(error) && error.sessionID === id;
}

function assertNotAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("sweep aborted");
}

function forwardAbort(source: AbortSignal, destination: AbortController): () => void {
  const abort = () => {
    if (!destination.signal.aborted) destination.abort(source.reason);
  };
  if (source.aborted) {
    abort();
    return () => undefined;
  }
  source.addEventListener("abort", abort, { once: true });
  return () => source.removeEventListener("abort", abort);
}

export function createSweepInvoker<T>(
  start: (signal: AbortSignal) => Promise<T>,
  lifecycleSignal: AbortSignal,
) {
  let running: Promise<T> | undefined;
  let controller: AbortController | undefined;
  let removeAbortListeners: Array<() => void> = [];

  const invoke = (invocationSignal?: AbortSignal): Promise<T> => {
    if (lifecycleSignal.aborted) {
      return Promise.reject(
        lifecycleSignal.reason instanceof Error
          ? lifecycleSignal.reason
          : new Error("sweep aborted"),
      );
    }
    if (running) {
      if (invocationSignal && controller) {
        const removeListener = forwardAbort(invocationSignal, controller);
        if (controller.signal.aborted) removeListener();
        else removeAbortListeners.push(removeListener);
      }
      return running;
    }

    const currentController = new AbortController();
    controller = currentController;
    removeAbortListeners = [forwardAbort(lifecycleSignal, currentController)];
    if (invocationSignal) {
      const removeListener = forwardAbort(invocationSignal, currentController);
      if (currentController.signal.aborted) removeListener();
      else removeAbortListeners.push(removeListener);
    }
    running = start(currentController.signal).finally(() => {
      for (const removeListener of removeAbortListeners) removeListener();
      removeAbortListeners = [];
      if (controller === currentController) controller = undefined;
      running = undefined;
    });
    return running;
  };

  return {
    invoke,
    wait: async () => {
      await running?.catch(() => undefined);
    },
  };
}

function mapSession(info: SessionInfo, directory: string): SessionLike {
  return {
    id: info.id,
    ...(info.parentID === undefined ? {} : { parentID: info.parentID }),
    title: info.title ?? info.id,
    directory,
    ...(typeof info.time.archived === "number" ? { archived: true } : {}),
    time: { created: info.time.created, updated: info.time.updated },
  };
}

function assertArchivedGroup(archived: boolean, session: SessionInfo): void {
  const archivedAt: number | null | undefined = session.time.archived;
  const consistent = archived
    ? typeof archivedAt === "number"
    : archivedAt === undefined || archivedAt === null;
  if (consistent) return;
  throw new Error(
    `session.list archived=${archived} returned session ${session.id} with an inconsistent time.archived value; refusing to sweep.`,
  );
}

/**
 * List every page before returning any results, so a paging failure never permits partial
 * deletion. Each group is also checked against its filter, because an empty list or a
 * successful request cannot prove the host actually applied `archived`.
 */
export async function listAll(
  client: ReturnType<typeof OpenCode.make>,
  archived: boolean,
  signal?: AbortSignal,
): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    if (signal) assertNotAborted(signal);
    const page = await client.session.list(
      {
        limit: 100,
        order: "asc",
        archived,
        ...(cursor ? { cursor } : {}),
      },
      signal ? { signal } : undefined,
    );
    for (const session of page.data) assertArchivedGroup(archived, session);
    sessions.push(...page.data);
    const next = page.cursor.next ?? undefined;
    if (next === undefined) break;
    if (seenCursors.has(next) || next === cursor) {
      throw new Error(`session.list repeated cursor: ${next}`);
    }
    seenCursors.add(next);
    cursor = next;
  }

  const unique = new Map<string, SessionInfo>();
  for (const session of sessions) {
    const previous = unique.get(session.id);
    if (previous === undefined) {
      unique.set(session.id, session);
      continue;
    }
    if (
      previous.parentID !== session.parentID ||
      previous.time.created !== session.time.created ||
      previous.time.updated !== session.time.updated ||
      previous.title !== session.title
    ) {
      throw new Error(
        `session.list returned conflicting records for session ${session.id}; refusing to sweep.`,
      );
    }
  }
  return [...unique.values()];
}

/** Read both archived and normal lists in full; any overlap means the filter contract is broken. */
export async function listBothGroups(
  client: ReturnType<typeof OpenCode.make>,
  signal?: AbortSignal,
): Promise<SessionInfo[]> {
  const normal = await listAll(client, false, signal);
  if (signal) assertNotAborted(signal);
  const archived = await listAll(client, true, signal);
  const normalIDs = new Set(normal.map((session) => session.id));
  for (const session of archived) {
    if (normalIDs.has(session.id)) {
      throw new Error(
        `session ${session.id} appeared in both archived and normal lists; refusing to sweep.`,
      );
    }
  }
  return [...normal, ...archived];
}

function getActiveIDs(
  active: Awaited<ReturnType<ReturnType<typeof OpenCode.make>["session"]["active"]>>,
): Set<string> {
  return new Set(Object.keys(active));
}

function makeSessionMap(sessions: SessionInfo[]): Map<string, SessionInfo> {
  return new Map(sessions.map((session) => [session.id, session]));
}

function subtreeIDs(sessions: Map<string, SessionInfo>, rootID: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const session of sessions.values()) {
    if (!session.parentID) continue;
    const siblings = children.get(session.parentID) ?? [];
    siblings.push(session.id);
    children.set(session.parentID, siblings);
  }
  const result = new Set<string>();
  const pending = [rootID];
  while (pending.length > 0) {
    const id = pending.pop();
    if (id === undefined) continue;
    if (result.has(id)) continue;
    result.add(id);
    pending.push(...(children.get(id) ?? []));
  }
  return result;
}

function protectedClosure(
  sessions: Map<string, SessionInfo>,
  protectedIDs: ReadonlySet<string>,
  activeIDs: ReadonlySet<string>,
): Set<string> {
  const result = new Set<string>();
  for (const id of [...protectedIDs, ...activeIDs]) {
    let current = sessions.get(id);
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      result.add(current.id);
      visited.add(current.id);
      current = current.parentID ? sessions.get(current.parentID) : undefined;
    }
  }
  return result;
}

function isExpired(
  session: SessionInfo,
  opts: ReturnType<typeof parseOptions>,
  now: number,
): boolean {
  const ageMs = now - session.time.updated;
  const threshold = session.parentID ? opts.subagentExpiryMs : opts.expiryMs;
  return ageMs >= opts.recentActivityGraceMs && ageMs >= threshold;
}

async function resolveClient(signal: AbortSignal): Promise<ReturnType<typeof OpenCode.make>> {
  return resolveCurrentProcessClient({ signal });
}

export async function sweepWithClient(
  client: ReturnType<typeof OpenCode.make>,
  directory: string,
  opts: ReturnType<typeof parseOptions>,
  protectedIDs: Set<string>,
  signal: AbortSignal = new AbortController().signal,
) {
  const host = await client.server.info({ signal });
  assertNotAborted(signal);
  // Unverified hosts stay diagnose-only: no scan result, no delete. This is stronger than
  // "request succeeded", which an old host can do by silently ignoring `archived`.
  assertVerifiedArchivedHost(host.version);
  const sessions = await listBothGroups(client, signal);
  assertNotAborted(signal);
  const active = getActiveIDs(await client.session.active({ signal }));
  assertNotAborted(signal);
  const initialByID = makeSessionMap(sessions);
  const wrapped: SweeperClient = {
    session: {
      async list() {
        return sessions.map((session) => mapSession(session, directory));
      },
      async delete({ path: { id } }) {
        assertNotAborted(signal);
        // Re-check the exact candidate and active state immediately before removal. API calls
        // are not atomic, so a session may still become active after these checks.
        const [fresh, currentActive] = await Promise.all([
          listBothGroups(client, signal),
          client.session.active({ signal }),
        ]).catch((error: unknown) => {
          // Revalidation cannot prove the tree is still safe: stop later deletes, keep confirmed ones.
          throw new SweepAbortError(error instanceof Error ? error.message : String(error));
        });
        assertNotAborted(signal);
        const freshByID = makeSessionMap(fresh);
        const candidate = freshByID.get(id);
        if (!candidate) return false;
        const baselineSubtree = subtreeIDs(initialByID, id);
        const freshSubtree = subtreeIDs(freshByID, id);
        // V2 removes a session's entire child tree. Refuse if the tree changed
        // since classification, including a newly added descendant or changed
        // parent link, rather than deleting an unchecked session by cascade.
        if (baselineSubtree.size !== freshSubtree.size) return false;
        for (const descendantID of baselineSubtree) {
          const before = initialByID.get(descendantID);
          const after = freshByID.get(descendantID);
          if (!before || !after || before.parentID !== after.parentID) return false;
        }
        const currentActiveIDs = getActiveIDs(currentActive);
        const liveProtected = protectedClosure(freshByID, protectedIDs, currentActiveIDs);
        const now = Date.now();
        for (const descendantID of freshSubtree) {
          const descendant = freshByID.get(descendantID);
          if (!descendant) return false;
          if (liveProtected.has(descendantID) || !isExpired(descendant, opts, now)) return false;
        }
        if (liveProtected.has(id)) return false;
        // The client has no atomic "check subtree and delete" operation; a session
        // may still change after these snapshots and before OpenCode applies removal.
        // Aborting can stop later requests and signal an in-flight request, but cannot
        // retract a DELETE already accepted by the OpenCode service.
        try {
          assertNotAborted(signal);
          await client.session.remove({ sessionID: id }, { signal });
          return true;
        } catch (error) {
          if (isSessionMissing(error, id)) return true;
          throw error;
        }
      },
    },
  };
  // Protect all active sessions even if the sweep implementation's time-based checks would pass.
  const protectedNow = new Set([...protectedIDs, ...active]);
  return runSweep(wrapped, opts, protectedNow);
}

async function sweepSafely(
  directory: string,
  opts: ReturnType<typeof parseOptions>,
  protectedIDs: Set<string>,
  signal: AbortSignal,
  makeClient: MakeClient,
) {
  return runSweepExclusive(async () => {
    const client = await makeClient(signal);
    return sweepWithClient(client, directory, opts, protectedIDs, signal);
  }, signal);
}

export function formatSweepLogSummary(r: Awaited<ReturnType<typeof sweepWithClient>>): string {
  return `scanned=${r.scanned} archived=${r.archivedScanned} deleted=${r.deleted} protected=${r.protectedCount} errors=${r.errors.length}`;
}

export function formatSweepSummary(r: Awaited<ReturnType<typeof sweepWithClient>>): string {
  const lines = [
    "Sweep complete.",
    `scanned: ${r.scanned}`,
    `archived scanned: ${r.archivedScanned}`,
    `deleted: ${r.deleted}`,
    `protected: ${r.protectedCount}`,
    `recentActive skipped: ${r.recentActiveSkipped}`,
    `main notExpired skipped: ${r.mainNotExpiredSkipped}`,
    `subagent notExpired skipped: ${r.subagentNotExpiredSkipped}`,
    `cascadeBlocked skipped: ${r.cascadeBlockedSkipped}`,
    `dryRun skipped: ${r.dryRunSkipped}`,
    `errors: ${r.errors.length}`,
  ];
  if (r.deletions.length > 0) {
    lines.push("deletions:");
    for (const deletion of r.deletions) {
      const tag = deletion.dryRun ? "DRY-RUN" : "DELETED";
      const archived = deletion.archived === true ? " [archived]" : "";
      const parent = deletion.parentID === undefined ? "" : ` (parent: ${deletion.parentID})`;
      lines.push(`  [${tag}]${archived} ${deletion.id} — ${deletion.title}${parent}`);
    }
  }
  if (r.errors.length > 0) {
    lines.push("errors:");
    for (const error of r.errors) lines.push(`  ${error.id}: ${redactSecrets(error.error)}`);
  }
  return lines.join("\n");
}

export async function setupV2(
  ctx: SetupContext,
  dependencies: SetupV2Options = {},
): Promise<Plugin.Cleanup> {
  const opts = parseOptions(ctx.options);
  const directory = ctx.location.directory;
  const protectedIDs = new Set(opts.protect);
  const lifecycle = new AbortController();
  const makeClient = dependencies.makeClient ?? resolveClient;
  const sweepInvoker = createSweepInvoker(
    (signal) => sweepSafely(directory, opts, protectedIDs, signal, makeClient),
    lifecycle.signal,
  );
  const invoke = (id?: string, invocationSignal?: AbortSignal): Promise<SweepResult> => {
    if (id) protectedIDs.add(id);
    return sweepInvoker.invoke(invocationSignal);
  };

  ctx.tool.transform((editor) => {
    if (editor.get("sweep")) return;
    editor.add({
      name: "sweep",
      description: "Clean up expired opencode sessions and subagents now.",
      input: { type: "object", properties: {}, additionalProperties: false },
      async execute(_args, context) {
        try {
          const result = await invoke(context.sessionID, context.signal);
          return { content: formatSweepSummary(result) };
        } catch (error) {
          return { content: `Sweep failed: ${redactError(error)}` };
        }
      },
    });
  });
  const existingCommands = await ctx.command.list({ location: { directory } });
  if (!existingCommands.data.some((command) => command.name === "sweep")) {
    ctx.command.transform((editor) =>
      editor.add({
        name: "sweep",
        description: "Sweep expired sessions and subagents now.",
        async execute({ sessionID, prompt, delivery }) {
          await ctx.session.prompt({ ...prompt, sessionID, text: COMMAND_TEMPLATE, delivery });
        },
      }),
    );
  }

  const runAutoUpdate = dependencies.runAutoUpdate ?? runV2AutoUpdate;
  const retryDelayMs = dependencies.retryDelayMs ?? 200;
  let autoUpdateTimer: ReturnType<typeof setTimeout> | undefined;
  let autoUpdateTask: Promise<void> | undefined;
  const waitForRetry = () =>
    new Promise<void>((resolve) => {
      if (lifecycle.signal.aborted) return resolve();
      const timer = setTimeout(done, retryDelayMs);
      function done() {
        clearTimeout(timer);
        lifecycle.signal.removeEventListener("abort", done);
        resolve();
      }
      lifecycle.signal.addEventListener("abort", done, { once: true });
    });
  const sourceCheck = async (): Promise<string | false> => {
    if (lifecycle.signal.aborted) return false;
    try {
      const result: unknown | typeof ABORTED_AUTO_UPDATE = await awaitAbortable(
        Promise.resolve().then(() => ctx.plugin.list({ location: { directory } })),
        lifecycle.signal,
      );
      if (result === ABORTED_AUTO_UPDATE || lifecycle.signal.aborted) return false;
      return hasVerifiedPackagePlugin(result, directory);
    } catch {
      return false;
    }
  };
  const checkForAutoUpdate = async () => {
    for (let attempt = 0; attempt < 5 && !lifecycle.signal.aborted; attempt += 1) {
      let result: unknown;
      try {
        const listed: unknown | typeof ABORTED_AUTO_UPDATE = await awaitAbortable(
          Promise.resolve().then(() => ctx.plugin.list({ location: { directory } })),
          lifecycle.signal,
        );
        if (listed === ABORTED_AUTO_UPDATE) return;
        result = listed;
      } catch {
        console.warn("opencode-sweeper V2 auto-update check failed");
        return;
      }
      if (lifecycle.signal.aborted) return;
      if (
        result === null ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        !("location" in result) ||
        !result.location ||
        typeof result.location !== "object" ||
        !("directory" in result.location) ||
        result.location.directory !== directory ||
        !("data" in result) ||
        !Array.isArray(result.data)
      )
        return;
      const hasPackageId = result.data.some(
        (plugin) =>
          plugin !== null &&
          typeof plugin === "object" &&
          "id" in plugin &&
          plugin.id === "opencode-sweeper",
      );
      if (hasPackageId) {
        const target = hasVerifiedPackagePlugin(result, directory);
        if (!target || lifecycle.signal.aborted) return;
        try {
          await runAutoUpdate(directory, {
            sourceCheck,
            signal: lifecycle.signal,
            log: (message) => console.info(message),
          });
        } catch {
          if (!lifecycle.signal.aborted)
            console.warn("opencode-sweeper V2 auto-update check failed");
        }
        return;
      }
      if (attempt < 4) await waitForRetry();
    }
  };
  autoUpdateTimer = setTimeout(() => {
    autoUpdateTimer = undefined;
    autoUpdateTask = checkForAutoUpdate();
  }, 0);
  if (typeof autoUpdateTimer === "object" && "unref" in autoUpdateTimer) autoUpdateTimer.unref();

  let timer: ReturnType<typeof setInterval> | undefined;
  if (opts.intervalMs > 0) {
    timer = setInterval(() => {
      void invoke()
        .then((result) =>
          console.info("opencode-sweeper timer sweep", formatSweepLogSummary(result)),
        )
        .catch((error) => {
          if (!lifecycle.signal.aborted)
            console.error("opencode-sweeper timer error", redactError(error));
        });
    }, opts.intervalMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  }
  console.info("opencode-sweeper V2 loaded", {
    directory,
    sweepQueueID,
    expiryMs: opts.expiryMs,
    subagentExpiryMs: opts.subagentExpiryMs,
    intervalMs: opts.intervalMs,
    dryRun: opts.dryRun,
    protectCount: opts.protect.length,
    recentActivityGraceMs: opts.recentActivityGraceMs,
  });
  return async () => {
    lifecycle.abort(new Error("opencode-sweeper plugin unloaded"));
    if (autoUpdateTimer) clearTimeout(autoUpdateTimer);
    if (timer) clearInterval(timer);
    await autoUpdateTask;
    await sweepInvoker.wait();
  };
}

export default { id: "opencode-sweeper", setup: setupV2 } satisfies Plugin.Plugin;
