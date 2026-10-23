import { expect, mock, test } from "bun:test";
import { Service } from "@opencode/client/service";
import { parseOptions } from "../src/options.js";
import { resolveArgvEndpoint, resolveCurrentProcessClient } from "../src/v2-endpoint.js";
import { sweepWithClient } from "../src/v2.js";

type ResolverOptions = Parameters<typeof resolveCurrentProcessClient>[0];
type Make = NonNullable<ResolverOptions["make"]>;
type Discover = NonNullable<ResolverOptions["discover"]>;
type FakeClient = {
  server: { info: (options?: { signal?: AbortSignal }) => Promise<{ pid: number }> };
};

const quiet = () => undefined;
const noEnv: NodeJS.ProcessEnv = {};

function argvFor(...args: string[]): string[] {
  return ["/usr/bin/opencode", "serve", ...args];
}

function makeClient(pid: number | (() => number | Promise<number>)): FakeClient {
  return {
    server: {
      info: async () => ({ pid: typeof pid === "function" ? await pid() : pid }),
    },
  };
}

test("V2 resolves serve flags in value and equals forms", () => {
  expect(resolveArgvEndpoint(argvFor("--hostname", "127.0.0.1", "--port", "4096"), noEnv)).toEqual({
    url: "http://127.0.0.1:4096",
    source: "argv",
  });
  expect(resolveArgvEndpoint(argvFor("--port=8080", "--hostname=0.0.0.0"), noEnv)).toEqual({
    url: "http://127.0.0.1:8080",
    source: "argv",
  });
  expect(resolveArgvEndpoint(argvFor("--hostname=localhost", "--port=65535"), noEnv)?.url).toBe(
    "http://localhost:65535",
  );
});

test("V2 resolves the deployed private serve argv with a password-only environment", () => {
  const candidate = resolveArgvEndpoint(
    ["/home/runner/.opencode/bin/opencode", "serve", "--hostname", "127.0.0.1", "--port", "41651"],
    { OPENCODE_SERVER_PASSWORD: "deployment-secret" },
  );

  expect(candidate?.url).toBe("http://127.0.0.1:41651");
  expect(candidate?.headers).toEqual({
    authorization: `Basic ${Buffer.from("opencode:deployment-secret", "utf8").toString("base64")}`,
  });
});

test("V2 resolves a script-wrapped serve command", () => {
  const argv = ["/usr/bin/bun", "/repo/opencode.ts", "serve", "--hostname=::1", "--port=4096"];
  expect(resolveArgvEndpoint(argv, noEnv)?.url).toBe("http://[::1]:4096");
});

test("V2 maps wildcard and IPv6 listen addresses to reachable loopback URLs", () => {
  for (const hostname of ["::", "::1", "[::1]"]) {
    const candidate = resolveArgvEndpoint(argvFor("--hostname", hostname, "--port", "4096"), noEnv);
    expect(candidate?.url).toBe("http://[::1]:4096");
    expect(new URL(candidate?.url ?? "").hostname).toBe("[::1]");
  }
  expect(resolveArgvEndpoint(argvFor("--hostname", "0.0.0.0", "--port", "4096"), noEnv)?.url).toBe(
    "http://127.0.0.1:4096",
  );
});

test("V2 rejects missing, zero, out-of-range, and ambiguous serve arguments", () => {
  const invalid = [
    argvFor("--hostname", "127.0.0.1"),
    argvFor("--port", "4096"),
    argvFor("--hostname", "127.0.0.1", "--port", "0"),
    argvFor("--hostname", "127.0.0.1", "--port", "65536"),
    argvFor("--hostname", "127.0.0.1", "--port", "-1"),
    argvFor("--hostname", "127.0.0.1", "--port", "abc"),
    argvFor("--hostname", "127.0.0.1", "--port"),
    argvFor("--hostname", "127.0.0.1", "--port="),
    argvFor("--hostname=", "--port", "4096"),
    argvFor("--hostname", "bad/host", "--port", "4096"),
    argvFor("--hostname", "127.0.0.1", "--", "--port", "4096"),
  ];
  for (const argv of invalid) expect(resolveArgvEndpoint(argv, noEnv)).toBeUndefined();
});

test("V2 never parses serve flags from another command", () => {
  const nonServe = [
    ["/usr/bin/opencode", "run", "--hostname", "127.0.0.1", "--port", "4096"],
    ["/usr/bin/opencode", "run", "serve", "--hostname", "127.0.0.1", "--port", "4096"],
    ["/usr/bin/opencode", "serve-helper", "--hostname", "127.0.0.1", "--port", "4096"],
    ["/usr/bin/opencode", "--hostname", "127.0.0.1", "--port", "4096"],
  ];
  for (const argv of nonServe) expect(resolveArgvEndpoint(argv, noEnv)).toBeUndefined();
});

test("V2 builds Basic auth from the serve process environment", () => {
  const defaultAuth = resolveArgvEndpoint(argvFor("--hostname", "127.0.0.1", "--port", "4096"), {
    OPENCODE_SERVER_PASSWORD: "pä ss",
  });
  const defaultHeader = `Basic ${Buffer.from("opencode:pä ss", "utf8").toString("base64")}`;
  expect(defaultAuth?.headers).toEqual({ authorization: defaultHeader });
  expect(Buffer.from(defaultHeader.slice("Basic ".length), "base64").toString("utf8")).toBe(
    "opencode:pä ss",
  );

  expect(
    resolveArgvEndpoint(argvFor("--hostname", "127.0.0.1", "--port", "4096"), {
      OPENCODE_SERVER_PASSWORD: "secret",
      OPENCODE_SERVER_USERNAME: "alice",
    })?.headers,
  ).toEqual({
    authorization: `Basic ${Buffer.from("alice:secret", "utf8").toString("base64")}`,
  });

  expect(
    resolveArgvEndpoint(argvFor("--hostname", "127.0.0.1", "--port", "4096"), noEnv)?.headers,
  ).toBeUndefined();
  expect(
    resolveArgvEndpoint(argvFor("--hostname", "127.0.0.1", "--port", "4096"), {
      OPENCODE_SERVER_PASSWORD: "secret",
      OPENCODE_SERVER_USERNAME: "bad:user",
    })?.headers,
  ).toBeUndefined();
});

test("V2 verifies the private serve address before touching a broken global registry", async () => {
  const client = makeClient(4242);
  const make = mock((_options: Parameters<Make>[0]) => client);
  const discover = mock(async () => {
    throw new Error("broken registry");
  });

  const resolved = await resolveCurrentProcessClient({
    argv: argvFor("--hostname", "127.0.0.1", "--port", "4096"),
    env: { OPENCODE_SERVER_PASSWORD: "secret" },
    pid: 4242,
    make: make as unknown as Make,
    discover: discover as unknown as Discover,
    log: quiet,
  });

  expect(resolved).toBe(client);
  expect(discover).not.toHaveBeenCalled();
  expect(make).toHaveBeenCalledTimes(1);
  expect(make.mock.calls[0]?.[0]).toEqual({
    baseUrl: "http://127.0.0.1:4096",
    headers: {
      authorization: `Basic ${Buffer.from("opencode:secret", "utf8").toString("base64")}`,
    },
  });
});

test("V2 falls back to a same-PID registered service with its own headers", async () => {
  const endpoint = {
    url: "http://127.0.0.1:7777",
    auth: { type: "basic" as const, username: "alice", password: "secret" },
  };
  const client = makeClient(4242);
  const make = mock((_options: Parameters<Make>[0]) => client);
  const discover = mock(async () => endpoint);

  const resolved = await resolveCurrentProcessClient({
    argv: ["/usr/bin/opencode", "run", "--hostname", "127.0.0.1", "--port", "4096"],
    env: noEnv,
    pid: 4242,
    make: make as unknown as Make,
    discover: discover as unknown as Discover,
    log: quiet,
  });

  expect(resolved).toBe(client);
  expect(discover).toHaveBeenCalledTimes(1);
  expect(make.mock.calls[0]?.[0]).toEqual({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
  });
  expect(make.mock.calls[0]?.[0].headers).toEqual({
    authorization: `Basic ${Buffer.from("alice:secret", "utf8").toString("base64")}`,
  });
});

test("V2 uses a verified registered service when argv cannot supply a usable address", async () => {
  const endpoint = { url: "http://127.0.0.1:7777" };
  const client = makeClient(4242);
  const make = mock((_options: Parameters<Make>[0]) => client);
  const discover = mock(async () => endpoint);

  await expect(
    resolveCurrentProcessClient({
      argv: argvFor("--hostname", "127.0.0.1", "--port", "0"),
      env: noEnv,
      pid: 4242,
      make: make as unknown as Make,
      discover: discover as unknown as Discover,
      log: quiet,
    }),
  ).resolves.toBe(client);
  expect(discover).toHaveBeenCalledTimes(1);
});

test("V2 refuses to sweep when every candidate has a different PID", async () => {
  const make = mock((options: Parameters<Make>[0]) =>
    makeClient(options.baseUrl.endsWith(":4096") ? 1 : 2),
  );
  const discover = mock(async () => ({ url: "http://127.0.0.1:7777" }));

  await expect(
    resolveCurrentProcessClient({
      argv: argvFor("--hostname", "127.0.0.1", "--port", "4096"),
      env: noEnv,
      pid: 4242,
      make: make as unknown as Make,
      discover: discover as unknown as Discover,
      log: quiet,
    }),
  ).rejects.toThrow("Cannot verify the current OpenCode service; refusing to sweep sessions.");
  expect(make).toHaveBeenCalledTimes(2);
});

test("V2 refuses to sweep when arguments are invalid and discovery fails", async () => {
  const make = mock((_options: Parameters<Make>[0]) => makeClient(4242));
  const discover = mock(async () => {
    throw new Error("registry unavailable");
  });

  await expect(
    resolveCurrentProcessClient({
      argv: argvFor("--hostname", "127.0.0.1"),
      env: noEnv,
      pid: 4242,
      make: make as unknown as Make,
      discover: discover as unknown as Discover,
      log: quiet,
    }),
  ).rejects.toThrow("Cannot verify the current OpenCode service; refusing to sweep sessions.");
  expect(make).not.toHaveBeenCalled();
  expect(discover).toHaveBeenCalledTimes(1);
});

test("V2 abort before resolution prevents every service call", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const make = mock((_options: Parameters<Make>[0]) => makeClient(4242));
  const discover = mock(async () => ({ url: "http://127.0.0.1:7777" }));

  await expect(
    resolveCurrentProcessClient({
      signal: controller.signal,
      argv: argvFor("--hostname", "127.0.0.1", "--port", "4096"),
      env: noEnv,
      pid: 4242,
      make: make as unknown as Make,
      discover: discover as unknown as Discover,
      log: quiet,
    }),
  ).rejects.toThrow("cancelled");
  expect(make).not.toHaveBeenCalled();
  expect(discover).not.toHaveBeenCalled();
});

test("V2 abort during verification does not continue to another candidate", async () => {
  const controller = new AbortController();
  const make = mock((_options: Parameters<Make>[0]) => ({
    server: {
      info: async () => {
        controller.abort(new Error("cancelled"));
        return { pid: 1 };
      },
    },
  }));
  const discover = mock(async () => ({ url: "http://127.0.0.1:7777" }));

  await expect(
    resolveCurrentProcessClient({
      signal: controller.signal,
      argv: argvFor("--hostname", "127.0.0.1", "--port", "4096"),
      env: noEnv,
      pid: 4242,
      make: make as unknown as Make,
      discover: discover as unknown as Discover,
      log: quiet,
    }),
  ).rejects.toThrow("cancelled");
  expect(discover).not.toHaveBeenCalled();
});

test("V2 abort during an in-flight server.info rejects without fallback", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const infoStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const make = mock((_options: Parameters<Make>[0]) => ({
    server: {
      info: (options?: { signal?: AbortSignal }) =>
        new Promise<{ pid: number }>((_resolve, reject) => {
          started();
          options?.signal?.addEventListener("abort", () => reject(new Error("request aborted")), {
            once: true,
          });
        }),
    },
  }));
  const discover = mock(async () => ({ url: "http://127.0.0.1:7777" }));

  const pending = resolveCurrentProcessClient({
    signal: controller.signal,
    argv: argvFor("--hostname", "127.0.0.1", "--port", "4096"),
    env: noEnv,
    pid: 4242,
    make: make as unknown as Make,
    discover: discover as unknown as Discover,
    log: quiet,
  });
  await infoStarted;
  controller.abort(new Error("cancelled"));
  await expect(pending).rejects.toThrow("cancelled");
  expect(discover).not.toHaveBeenCalled();
});

test("V2 resolver logs never contain credentials", async () => {
  const logs: string[] = [];
  const make = mock((_options: Parameters<Make>[0]) => makeClient(1));
  const discover = mock(async () => undefined);
  const password = "top-secret";
  const username = "alice";

  await expect(
    resolveCurrentProcessClient({
      argv: argvFor("--hostname", "127.0.0.1", "--port", "4096"),
      env: { OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: username },
      pid: 4242,
      make: make as unknown as Make,
      discover: discover as unknown as Discover,
      log: (level, message, extra) => logs.push(JSON.stringify([level, message, extra])),
    }),
  ).rejects.toThrow("Cannot verify the current OpenCode service");

  const output = logs.join("\n");
  expect(output).not.toContain(password);
  expect(output).not.toContain(username);
  expect(output).not.toContain(Buffer.from(`${username}:${password}`).toString("base64"));
});

test("V2 keeps the verified client for list, active, and remove", async () => {
  const old = Date.now() - 10 * 24 * 60 * 60 * 1000;
  const session = { id: "old", title: "old", time: { created: old, updated: old } };
  const calls: string[] = [];
  const argvClient = {
    server: { info: async () => ({ pid: 4242 }) },
    session: {
      list: async () => {
        calls.push("argv.list");
        return { data: [session], cursor: {} };
      },
      active: async () => {
        calls.push("argv.active");
        return {};
      },
      remove: async () => {
        calls.push("argv.remove");
      },
    },
  };
  const fallbackClient = {
    session: {
      list: async () => {
        calls.push("fallback.list");
        return { data: [session], cursor: {} };
      },
      active: async () => {
        calls.push("fallback.active");
        return {};
      },
      remove: async () => {
        calls.push("fallback.remove");
      },
    },
  };
  const make = mock((options: Parameters<Make>[0]) =>
    options.baseUrl.endsWith(":4096") ? argvClient : fallbackClient,
  );
  const discover = mock(async () => ({ url: "http://127.0.0.1:7777" }));

  const client = await resolveCurrentProcessClient({
    argv: argvFor("--hostname", "127.0.0.1", "--port", "4096"),
    env: noEnv,
    pid: 4242,
    make: make as unknown as Make,
    discover: discover as unknown as Discover,
    log: quiet,
  });
  const result = await sweepWithClient(
    client as unknown as Parameters<typeof sweepWithClient>[0],
    "/project",
    parseOptions({ expiryMs: 1, recentActivityGraceMs: 60 * 60 * 1000, dryRun: false }),
    new Set(),
  );

  expect(result.deleted).toBe(1);
  expect(calls).toEqual(["argv.list", "argv.active", "argv.list", "argv.active", "argv.remove"]);
  expect(make).toHaveBeenCalledTimes(1);
  expect(discover).not.toHaveBeenCalled();
});
