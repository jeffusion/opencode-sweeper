import { OpenCode, isSessionNotFoundError } from "@opencode/client";
import type { SessionInfo } from "@opencode/client";
import { Service } from "@opencode/client/service";
import type { Plugin } from "@opencode/plugin";
import { parseOptions } from "./options.js";
import { type SessionLike, type SweepResult, type SweeperClient, runSweep } from "./sweep.js";

type SetupContext = Plugin.Context;

const COMMAND_TEMPLATE =
  "Run the `sweep` tool now and report its result back to the user verbatim. Do not summarize or omit counts.";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    time: { created: info.time.created, updated: info.time.updated },
  };
}

/** List every page before returning any results, so a paging failure never permits partial deletion. */
export async function listAll(
  client: ReturnType<typeof OpenCode.make>,
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
        ...(cursor ? { cursor } : {}),
      },
      signal ? { signal } : undefined,
    );
    sessions.push(...page.data);
    const next = page.cursor.next ?? undefined;
    if (page.data.length === 0 || next === undefined) break;
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

async function makeClient(signal: AbortSignal): Promise<ReturnType<typeof OpenCode.make>> {
  assertNotAborted(signal);
  const endpoint = await Service.discover();
  assertNotAborted(signal);
  if (!endpoint)
    throw new Error("Cannot verify the current OpenCode service; refusing to sweep sessions.");
  const client = OpenCode.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
  });
  const info = await client.server.info({ signal });
  assertNotAborted(signal);
  if (info.pid !== process.pid) {
    throw new Error(
      `OpenCode service PID ${info.pid} does not match plugin PID ${process.pid}; refusing to sweep sessions.`,
    );
  }
  return client;
}

export async function sweepWithClient(
  client: ReturnType<typeof OpenCode.make>,
  directory: string,
  opts: ReturnType<typeof parseOptions>,
  protectedIDs: Set<string>,
  signal: AbortSignal = new AbortController().signal,
) {
  const sessions = await listAll(client, signal);
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
          listAll(client, signal),
          client.session.active({ signal }),
        ]);
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
) {
  return sweepWithClient(await makeClient(signal), directory, opts, protectedIDs, signal);
}

function formatSweepSummary(r: Awaited<ReturnType<typeof sweepWithClient>>): string {
  const lines = [
    "Sweep complete.",
    `scanned: ${r.scanned}`,
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
      const parent = deletion.parentID === undefined ? "" : ` (parent: ${deletion.parentID})`;
      lines.push(`  [${tag}] ${deletion.id} — ${deletion.title}${parent}`);
    }
  }
  if (r.errors.length > 0) {
    lines.push("errors:");
    for (const error of r.errors) lines.push(`  ${error.id}: ${error.error}`);
  }
  return lines.join("\n");
}

export async function setupV2(ctx: SetupContext): Promise<Plugin.Cleanup> {
  const opts = parseOptions(ctx.options);
  const directory = ctx.location.directory;
  const protectedIDs = new Set(opts.protect);
  const lifecycle = new AbortController();
  const sweepInvoker = createSweepInvoker(
    (signal) => sweepSafely(directory, opts, protectedIDs, signal),
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
          return { content: `Sweep failed: ${errorMessage(error)}` };
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

  let timer: ReturnType<typeof setInterval> | undefined;
  if (opts.intervalMs > 0) {
    timer = setInterval(() => {
      void invoke()
        .then((result) => console.info("opencode-sweeper timer sweep", formatSweepSummary(result)))
        .catch((error) => {
          if (!lifecycle.signal.aborted) console.error("opencode-sweeper timer error", error);
        });
    }, opts.intervalMs);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
  }
  console.info("opencode-sweeper V2 loaded", { ...opts, dbPath: undefined });
  return async () => {
    lifecycle.abort(new Error("opencode-sweeper plugin unloaded"));
    if (timer) clearInterval(timer);
    await sweepInvoker.wait();
  };
}

export default { id: "opencode-sweeper", setup: setupV2 } satisfies Plugin.Plugin;
