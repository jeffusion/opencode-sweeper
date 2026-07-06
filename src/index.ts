import type { Hooks, Plugin, PluginInput, PluginModule, PluginOptions } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { type SessionRow, listSessions, resolveOpencodeDbPath, rowToSessionLike } from "./db.js";
import { type SweeperOptions, parseOptions } from "./options.js";
import { type SessionLike, type SweepResult, type SweeperClient, runSweep } from "./sweep.js";

const SERVICE_NAME = "opencode-sweeper";
const TOOL_NAME = "sweep";
const COMMAND_NAME = "sweep";
const COMMAND_TEMPLATE =
  "Run the `sweep` tool now and report its result back to the user verbatim. Do not summarize or omit counts.";
const COMMAND_DESCRIPTION = "Sweep expired sessions and subagents now (runs the sweep tool).";

function formatSweepSummary(r: SweepResult): string {
  const lines = [
    "Sweep complete.",
    `scanned: ${r.scanned}`,
    `deleted: ${r.deleted}`,
    `protected: ${r.protectedCount}`,
    `recentActive skipped: ${r.recentActiveSkipped}`,
    `main notExpired skipped: ${r.mainNotExpiredSkipped}`,
    `subagent notExpired skipped: ${r.subagentNotExpiredSkipped}`,
    `dryRun skipped: ${r.dryRunSkipped}`,
    `errors: ${r.errors.length}`,
  ];
  if (r.deletions.length > 0) {
    lines.push("deletions:");
    for (const d of r.deletions) {
      const tag = d.dryRun ? "DRY-RUN" : "DELETED";
      const parent = d.parentID === undefined ? "" : ` (parent: ${d.parentID})`;
      lines.push(`  [${tag}] ${d.id} — ${d.title}${parent}`);
    }
  }
  if (r.errors.length > 0) {
    lines.push("errors:");
    for (const e of r.errors) {
      lines.push(`  ${e.id}: ${e.error}`);
    }
  }
  return lines.join("\n");
}

function isNotFoundError(error: unknown): boolean {
  if (error === null || typeof error !== "object") {
    return false;
  }
  return (error as { name?: unknown }).name === "NotFoundError";
}

/**
 * Build a `SweeperClient` that reads all sessions from the opencode SQLite DB
 * directly (bypassing the SDK's project-scoped, limit-100 `session.list()`)
 * and deletes through the SDK's `session.delete()` so opencode's reverse-FK
 * cascade (`Session.remove` → `children()` recursion + 404 silent in our
 * adapter) still applies. Mixed read/write paths avoid both the SDK scan
 * blind spot and a direct-sqlite DELETE that would bypass opencode app-layer
 * invariants (e.g. children link cleanup).
 */
function buildSweeperClient(input: PluginInput, opts: SweeperOptions): SweeperClient {
  const dbPath = resolveOpencodeDbPath(opts.dbPath);
  return {
    session: {
      async list(): Promise<SessionLike[]> {
        const rows: SessionRow[] = await listSessions(dbPath);
        return rows.map(rowToSessionLike);
      },
      async delete(args: { path: { id: string } }): Promise<boolean> {
        const res = await input.client.session.delete({ path: { id: args.path.id } });
        if (res.error !== undefined) {
          if (isNotFoundError(res.error)) {
            return true;
          }
          throw new Error(`session.delete(${args.path.id}) failed: ${String(res.error)}`);
        }
        return res.data === true;
      },
    },
  };
}

async function logInfo(
  input: PluginInput,
  message: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  await input.client.app.log({ body: { service: SERVICE_NAME, level: "info", message, extra } });
}

function makeSweepTool(
  client: SweeperClient,
  opts: SweeperOptions,
  protectedSessions: Set<string>,
  input: PluginInput,
) {
  return tool({
    description:
      "Clean up expired opencode sessions and subagents now. Run only when the user explicitly asks to sweep or clean up sessions.",
    args: {},
    async execute(_args, context) {
      protectedSessions.add(context.sessionID);
      const result = await runSweep(client, opts, protectedSessions);
      await logInfo(input, `manual sweep: ${formatSweepSummary(result)}`);
      return formatSweepSummary(result);
    },
  });
}

const server: Plugin = async (input: PluginInput, options?: PluginOptions) => {
  const opts = parseOptions(options);
  const protectedSessions = new Set<string>(opts.protect);
  const client = buildSweeperClient(input, opts);

  let timer: ReturnType<typeof setInterval> | undefined;
  if (opts.intervalMs > 0) {
    const tick = async () => {
      try {
        const result = await runSweep(client, opts, protectedSessions);
        await logInfo(input, `timer sweep: ${formatSweepSummary(result)}`);
      } catch (error) {
        await logInfo(
          input,
          `timer sweep error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    };
    timer = setInterval(() => {
      void tick();
    }, opts.intervalMs);
    // unref is required for `opencode run` one-shots to exit between ticks;
    // matches @cortexkit/opencode-magic-context dream-timer.ts pattern.
    if (typeof timer === "object" && "unref" in timer) {
      timer.unref();
    }
  }

  const hooks: Hooks = {
    config: async (config) => {
      // Inject `sweep` into Config.command so opencode surfaces it in the TUI
      // slash palette. Mechanism: opencode's ACP flows config.command through
      // `available_commands_update` into TUI's `sync().data.command`, which
      // prompt-input.tsx renders as the `/` popover (opencode@68f225a).
      // User-declared `sweep` in opencode.json takes precedence over our default.
      const existing = config.command?.[COMMAND_NAME];
      config.command = {
        ...(config.command ?? {}),
        [COMMAND_NAME]: {
          template: existing?.template ?? COMMAND_TEMPLATE,
          description: existing?.description ?? COMMAND_DESCRIPTION,
          ...(existing?.agent !== undefined ? { agent: existing.agent } : {}),
          ...(existing?.model !== undefined ? { model: existing.model } : {}),
          ...(existing?.subtask !== undefined ? { subtask: existing.subtask } : {}),
        },
      };
      await logInfo(
        input,
        `loaded: expiryMs=${opts.expiryMs} subagentExpiryMs=${opts.subagentExpiryMs} intervalMs=${opts.intervalMs} dryRun=${opts.dryRun} protect=${opts.protect.length} recentActivityGraceMs=${opts.recentActivityGraceMs} dbPath=${resolveOpencodeDbPath(opts.dbPath)}`,
      );
    },
    tool: {
      [TOOL_NAME]: makeSweepTool(client, opts, protectedSessions, input),
    },
    dispose: async () => {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };

  return hooks;
};

// Default export MUST be the `PluginModule` shape `{ id, server }` rather than a bare
// `Plugin` function. opencode's `applyPlugin` → `readV1Plugin(mode="detect")` only
// routes through the v1 path that propagates `Hooks.tool` into `ToolRegistry` (and
// thus into the LLM agent functions list) when `mod.default` is a record containing
// `server`/`tui`/`id` (sst/opencode src/plugin/shared.ts readV1Plugin, SHA 68f225a).
// A bare async function falls into `getLegacyPlugins`, which in opencode@1.17.13 does
// not surface plugin tools to the LLM tool registry even though the `config` hook still
// fires — that was the v0.1.1 regression where `/sweep` appeared in the TUI palette
// but the LLM could not actually invoke the `sweep` tool.
export default { id: "opencode-sweeper", server } satisfies PluginModule;
