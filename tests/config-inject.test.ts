import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import type { Config, Session } from "@opencode-ai/sdk";
import plugin from "../src/index";

type CommandMap = NonNullable<Config["command"]>;
type CommandEntry = CommandMap[string];

// Harness: invoke the optional `config` hook. Throws if the plugin did not
// register a config hook (which would itself be a regression).
async function callConfigHook(hooks: Hooks, config: Config): Promise<void> {
  if (hooks.config === undefined) {
    throw new Error("plugin did not register a `config` hook");
  }
  await hooks.config(config);
}

// Harness: extract injected `sweep` command entry, asserting presence first so
// downstream assertions don't need non-null assertions.
function getSweepCommand(config: Config): CommandEntry {
  const map = config.command;
  if (map === undefined) {
    throw new Error("config.command was not injected");
  }
  const entry = map.sweep;
  if (entry === undefined) {
    throw new Error("config.command.sweep was not injected");
  }
  return entry;
}

// Building a minimal PluginInput mock: only `client.app.log` and
// `client.session.list/delete` are exercised by the config hook.
function makeMockInput(opts: { sessions?: Session[] } = {}): PluginInput {
  const sessions = opts.sessions ?? [];
  const appLog = mock(async () => ({ data: undefined, error: undefined }));
  const sessionList = mock(async () => ({ data: sessions, error: undefined }));
  const sessionDelete = mock(async () => ({ data: true, error: undefined }));
  return {
    client: {
      app: { log: appLog },
      session: { list: sessionList, delete: sessionDelete },
    },
  } as unknown as PluginInput;
}

async function loadHooks(input: PluginInput, options?: Record<string, unknown>): Promise<Hooks> {
  const result = await plugin(input, options);
  return result as Hooks;
}

describe("Config.command injection for TUI slash palette", () => {
  let input: PluginInput;
  let hooks: Hooks;

  beforeEach(async () => {
    input = makeMockInput();
    hooks = await loadHooks(input, {});
  });

  test("injects `sweep` command into empty config.command", async () => {
    const config: Config = {};
    await callConfigHook(hooks, config);
    expect(config.command).toBeDefined();
    const sweep = getSweepCommand(config);
    expect(typeof sweep.template).toBe("string");
    expect(sweep.template.length).toBeGreaterThan(0);
    expect(typeof sweep.description).toBe("string");
    expect(sweep.description?.length).toBeGreaterThan(0);
  });

  test("does not overwrite user-declared `sweep` command in opencode.json", async () => {
    const userTemplate = "User custom sweep template — preserved.";
    const userDescription = "User custom description.";
    const config: Config = {
      command: {
        sweep: {
          template: userTemplate,
          description: userDescription,
          agent: "explore",
          model: "provider/custom-model",
          subtask: true,
        },
      },
    };
    await callConfigHook(hooks, config);
    const sweep = getSweepCommand(config);
    expect(sweep.template).toBe(userTemplate);
    expect(sweep.description).toBe(userDescription);
    expect(sweep.agent).toBe("explore");
    expect(sweep.model).toBe("provider/custom-model");
    expect(sweep.subtask).toBe(true);
  });

  test("preserves other commands in config.command while injecting sweep", async () => {
    const config: Config = {
      command: {
        "other-cmd": { template: "do other thing", description: "other" },
      },
    };
    await callConfigHook(hooks, config);
    const map = config.command;
    expect(map).toBeDefined();
    expect(map?.["other-cmd"]).toBeDefined();
    expect(map?.["other-cmd"]?.template).toBe("do other thing");
    expect(map?.sweep).toBeDefined();
  });

  test("fills only template+description when user omitted optional fields", async () => {
    const config: Config = {
      command: {
        sweep: { template: "user-only-template" },
      },
    };
    await callConfigHook(hooks, config);
    const sweep = getSweepCommand(config);
    expect(sweep.template).toBe("user-only-template");
    expect(typeof sweep.description).toBe("string");
    expect(sweep.description?.length).toBeGreaterThan(0);
    expect(sweep.agent).toBeUndefined();
    expect(sweep.model).toBeUndefined();
    expect(sweep.subtask).toBeUndefined();
  });
});
