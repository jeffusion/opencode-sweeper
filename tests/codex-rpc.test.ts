import { afterEach, beforeEach, expect, it } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CodexClientOptions,
  CodexRequestError,
  type CodexRpcClient,
  CodexTransportError,
  createCodexClient,
} from "../src/codex-rpc.js";

const PACKAGE_VERSION = createRequire(import.meta.url)("../package.json").version;
let root: string;
let env: NodeJS.ProcessEnv;
let client: CodexRpcClient | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "codex-rpc-"));
  await mkdir(join(root, "home"));
  await copyFile(new URL("./fixtures/fake-codex.mjs", import.meta.url), join(root, "codex"));
  await chmod(join(root, "codex"), 0o755);
  env = {
    ...process.env,
    PATH: `${root}:${process.env.PATH ?? ""}`,
    CODEX_HOME: join(root, "home"),
  };
});

afterEach(async () => {
  await client?.close();
  client = undefined;
  await rm(root, { recursive: true, force: true });
});

async function connect(mode = "normal", options?: CodexClientOptions) {
  env.FAKE_CODEX_MODE = mode;
  client = await createCodexClient(env, options);
  return client;
}

async function messages(): Promise<Array<Record<string, unknown>>> {
  return (await readFile(join(root, "messages.log"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

async function expectChildGone() {
  const pid = Number(await readFile(join(root, "pid"), "utf8"));
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(20);
  }
  throw new Error(`fixture child ${pid} did not exit`);
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("expected rejection");
}

it("handshakes in order, accepts notifications and exposes version and home", async () => {
  const rpc = await connect();
  expect(rpc.version).toBe("0.163.0");
  expect(rpc.codexHome).toBe(await realpath(env.CODEX_HOME as string));
  expect(await rpc.request("thread/list", { archived: true })).toEqual({
    data: [],
    nextCursor: null,
  });
  expect(await messages()).toEqual([
    {
      id: expect.any(Number),
      method: "initialize",
      params: { clientInfo: { name: "opencode-sweeper", version: PACKAGE_VERSION } },
    },
    { method: "initialized" },
    { id: expect.any(Number), method: "thread/list", params: { archived: true } },
  ]);
});

it("sends only whitelisted methods and preserves includeTurns: false", async () => {
  const rpc = await connect();
  expect(await rpc.request("thread/read", { threadId: "thread-1", includeTurns: false })).toEqual({
    thread: { id: "thread-1", turns: [] },
  });
  await rpc.request("thread/loaded/list");
  await rpc.request("thread/delete", { threadId: "thread-1" });
  for (const method of ["thread/start", "thread/resume", "thread/archive"]) {
    expect((await rejection(rpc.request(method))).message).toContain("not allowed");
  }
  const sent = await messages();
  expect(sent.map(({ method }) => method)).toEqual([
    "initialize",
    "initialized",
    "thread/read",
    "thread/loaded/list",
    "thread/delete",
  ]);
  expect(sent[2]).toMatchObject({ params: { threadId: "thread-1", includeTurns: false } });
});

it.each(["", "relative-home", "{root}"])(
  "rejects invalid or mismatched home %j and stops its child",
  async (home) => {
    env.FAKE_CODEX_HOME = home.replace("{root}", root);
    expect(await rejection(connect())).toBeInstanceOf(CodexTransportError);
    await expectChildGone();
  },
);

it("distinguishes a redacted business rejection and keeps the connection usable", async () => {
  const rpc = await connect("rpc-error");
  const error = await rejection(rpc.request("thread/delete", { threadId: "thread-1" }));
  expect(error).toBeInstanceOf(CodexRequestError);
  expect(error).not.toBeInstanceOf(CodexTransportError);
  expect((error as CodexRequestError).code).toBe(-32602);
  expect(error.message).toContain("[redacted]");
  expect(error.message).not.toContain("fixture-secret");
  expect(await rpc.request("thread/list")).toEqual({ data: [], nextCursor: null });
});

it("fails closed on an ambiguous result plus error and terminates its child", async () => {
  const rpc = await connect("ambiguous");
  const error = await rejection(rpc.request("thread/list"));
  expect(error).toBeInstanceOf(CodexTransportError);
  expect(error).not.toBeInstanceOf(CodexRequestError);
  await expectChildGone();
  expect(await rejection(rpc.request("thread/list"))).toBeInstanceOf(CodexTransportError);
});

it("times out and terminates its own child", async () => {
  const rpc = await connect("hang", { requestTimeoutMs: 150 });
  const error = await rejection(rpc.request("thread/list"));
  expect(error).toBeInstanceOf(CodexTransportError);
  expect(error.message).toContain("timed out");
  await expectChildGone();
});

it("escalates close to SIGKILL when its child ignores SIGTERM", async () => {
  const rpc = await connect("ignore-sigterm", { closeGraceMs: 100 });
  await rpc.close();
  await expectChildGone();
  await rpc.close();
  expect(await rejection(rpc.request("thread/list"))).toBeInstanceOf(CodexTransportError);
});
