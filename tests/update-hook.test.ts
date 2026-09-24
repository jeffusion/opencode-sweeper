import { expect, mock, test } from "bun:test";
import type { Hooks, PluginInput } from "@opencode-ai/plugin";
import type { Config } from "@opencode-ai/sdk";
import { createServer } from "../src/index.js";

type UpdateFn = Parameters<typeof createServer>[0];

async function loadHooks(
  log: PluginInput["client"]["app"]["log"],
  updatePluginVersion: UpdateFn,
): Promise<Hooks> {
  const input = { client: { app: { log } } } as unknown as PluginInput;
  return (await createServer(updatePluginVersion)(input, {})) as Hooks;
}

async function callConfig(hooks: Hooks, config: Config): Promise<void> {
  if (!hooks.config) throw new Error("V1 plugin did not register config hook");
  await hooks.config(config);
}

test("config hook injects the command and does not await updater without origins", async () => {
  const updatePluginVersion = mock(async (_config: unknown) => {
    return new Promise<boolean>(() => {});
  });
  const log = mock(async () => ({ data: undefined, error: undefined }));
  const hooks = await loadHooks(
    log as unknown as PluginInput["client"]["app"]["log"],
    updatePluginVersion,
  );
  const config: Config = {};

  await callConfig(hooks, config);
  expect(config.command?.sweep).toBeDefined();
  expect(updatePluginVersion).toHaveBeenCalledWith(config, expect.any(Object));
});

test("update notification and error logging failures do not reject the config hook", async () => {
  const originalError = console.error;
  const errors: unknown[][] = [];
  const updatePluginVersion = mock(
    async (_config: unknown, callbacks?: { onSuccess?: (version: string) => void }) => {
      callbacks?.onSuccess?.("0.2.0");
      return true;
    },
  );
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    const log = mock(async ({ body }: { body: { message: string } }) => {
      if (body.message.includes("updated config pin")) throw new Error("notification log failed");
      return { data: undefined, error: undefined };
    });
    const hooks = await loadHooks(
      log as unknown as PluginInput["client"]["app"]["log"],
      updatePluginVersion,
    );
    await callConfig(hooks, {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors.length).toBeGreaterThan(0);

    updatePluginVersion.mockImplementation(async () => {
      throw new Error("registry/update failed");
    });
    const failingLog = mock(async ({ body }: { body: { message: string } }) => {
      if (body.message.includes("update check failed")) throw new Error("error log failed");
      return { data: undefined, error: undefined };
    });
    const failingHooks = await loadHooks(
      failingLog as unknown as PluginInput["client"]["app"]["log"],
      updatePluginVersion,
    );
    await expect(callConfig(failingHooks, {})).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors.length).toBeGreaterThan(1);
  } finally {
    console.error = originalError;
  }
});
