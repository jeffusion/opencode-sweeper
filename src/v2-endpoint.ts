import { isIP } from "node:net";
import { OpenCode } from "@opencode/client";
import { Service } from "@opencode/client/service";
import type { Endpoint as ServiceEndpoint } from "@opencode/client/service";

type Client = ReturnType<typeof OpenCode.make>;

const DEFAULT_SERVER_USERNAME = "opencode";
const HOSTNAME_FLAG = "--hostname";
const PORT_FLAG = "--port";

export type ResolverLog = (
  level: "info" | "warn",
  message: string,
  extra?: Record<string, unknown>,
) => void;

export type EndpointCandidate = {
  readonly url: string;
  readonly headers?: RequestInit["headers"];
  readonly source: "argv" | "discovery";
};

export type ResolveClientOptions = {
  readonly signal?: AbortSignal;
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly pid?: number;
  readonly discover?: typeof Service.discover;
  readonly make?: typeof OpenCode.make;
  readonly log?: ResolverLog;
};

function defaultLog(
  level: "info" | "warn",
  message: string,
  extra?: Record<string, unknown>,
): void {
  if (level === "info") {
    if (extra === undefined) console.info(message);
    else console.info(message, extra);
  } else {
    if (extra === undefined) console.warn(message);
    else console.warn(message, extra);
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("sweep aborted");
}

function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

/** Build Basic auth from the serve process environment; never fall back to a discovered credential. */
function authHeaders(env: NodeJS.ProcessEnv): RequestInit["headers"] | undefined {
  const password = env.OPENCODE_SERVER_PASSWORD;
  if (!password) return undefined;
  const username = env.OPENCODE_SERVER_USERNAME || DEFAULT_SERVER_USERNAME;
  // RFC 7617 forbids a colon in the user-id; an ambiguous credential cannot be verified.
  if (username.includes(":")) return undefined;
  return { authorization: basicAuthorization(username, password) };
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9][0-9]*$/.test(value)) return undefined;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : undefined;
}

function normalizeHostname(value: string): string | undefined {
  let host = value;
  if (host.startsWith("[") || host.endsWith("]")) {
    if (!(host.startsWith("[") && host.endsWith("]"))) return undefined;
    host = host.slice(1, -1);
  }
  if (host === "") return undefined;
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "[::1]";

  const family = isIP(host);
  if (family === 4) return host;
  if (family === 6) return `[${host}]`;
  if (family !== 0) return undefined;
  // Reject IPv4-looking text that is not a valid address, and anything that would need
  // URL escaping. Only plain hostnames reach the URL below.
  if (/^[0-9.]+$/.test(host)) return undefined;
  if (host.length > 253) return undefined;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(host)) return undefined;
  return host;
}

/**
 * Return the arguments after a standard `opencode serve` command. argv[1] may be a
 * script path; any other command (for example `run`) is rejected so a prompt or flag
 * value named "serve" is never mistaken for the serve subcommand.
 */
function serveArguments(argv: readonly string[]): readonly string[] | undefined {
  const rest = argv.slice(1);
  const first = rest[0];
  if (first === undefined || first.startsWith("-")) return undefined;

  let commandIndex = 0;
  if (first !== "serve") {
    const looksLikeScript = /[\\/]/.test(first) || /\.(?:[cm]?[jt]s)$/i.test(first);
    if (!looksLikeScript) return undefined;
    commandIndex = 1;
  }
  if (rest[commandIndex] !== "serve") return undefined;
  return rest.slice(commandIndex + 1);
}

/** Resolve the address advertised by the current process's own `serve --hostname/--port`. */
export function resolveArgvEndpoint(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): EndpointCandidate | undefined {
  const args = serveArguments(argv);
  if (!args) return undefined;

  let hostname: string | undefined;
  let port: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined || arg === "--") break;

    if (arg === HOSTNAME_FLAG || arg.startsWith(`${HOSTNAME_FLAG}=`)) {
      const value = arg === HOSTNAME_FLAG ? args[index + 1] : arg.slice(HOSTNAME_FLAG.length + 1);
      if (arg === HOSTNAME_FLAG) index += 1;
      if (value === undefined || value === "" || value.startsWith("-")) return undefined;
      hostname = value;
      continue;
    }

    if (arg === PORT_FLAG || arg.startsWith(`${PORT_FLAG}=`)) {
      const value = arg === PORT_FLAG ? args[index + 1] : arg.slice(PORT_FLAG.length + 1);
      if (arg === PORT_FLAG) index += 1;
      const parsed = parsePort(value);
      if (parsed === undefined) return undefined;
      port = parsed;
    }
  }

  if (hostname === undefined || port === undefined) return undefined;
  const host = normalizeHostname(hostname);
  if (host === undefined) return undefined;

  const headers = authHeaders(env);
  return {
    url: `http://${host}:${port}`,
    ...(headers === undefined ? {} : { headers }),
    source: "argv",
  };
}

type ResolverContext = {
  readonly signal: AbortSignal;
  readonly pid: number;
  readonly make: typeof OpenCode.make;
  readonly discover: typeof Service.discover;
  readonly log: ResolverLog;
};

async function verifyCandidate(
  candidate: EndpointCandidate,
  context: ResolverContext,
): Promise<Client | undefined> {
  assertNotAborted(context.signal);

  let client: Client;
  try {
    client = context.make({ baseUrl: candidate.url, headers: candidate.headers });
  } catch {
    assertNotAborted(context.signal);
    context.log("warn", "opencode-sweeper V2 endpoint candidate failed", {
      source: candidate.source,
      reason: "client-error",
    });
    return undefined;
  }

  assertNotAborted(context.signal);
  let info: Awaited<ReturnType<Client["server"]["info"]>>;
  try {
    info = await client.server.info({ signal: context.signal });
  } catch {
    // If the signal aborted during the request, propagate the caller's cancellation
    // instead of moving on to another candidate.
    assertNotAborted(context.signal);
    context.log("warn", "opencode-sweeper V2 endpoint candidate failed", {
      source: candidate.source,
      reason: "verification-error",
    });
    return undefined;
  }

  assertNotAborted(context.signal);
  if (info.pid !== context.pid) {
    context.log("warn", "opencode-sweeper V2 endpoint candidate rejected", {
      source: candidate.source,
      reason: "pid-mismatch",
      expectedPid: context.pid,
      actualPid: info.pid,
    });
    return undefined;
  }

  context.log("info", "opencode-sweeper V2 service verified", {
    source: candidate.source,
    pid: context.pid,
  });
  return client;
}

async function discoveryCandidate(
  context: ResolverContext,
): Promise<EndpointCandidate | undefined> {
  assertNotAborted(context.signal);

  let endpoint: ServiceEndpoint | undefined;
  try {
    endpoint = await context.discover();
  } catch {
    assertNotAborted(context.signal);
    context.log("warn", "opencode-sweeper V2 service discovery failed", {
      reason: "discovery-error",
    });
    return undefined;
  }

  assertNotAborted(context.signal);
  if (endpoint === undefined) {
    context.log("warn", "opencode-sweeper V2 service discovery found no endpoint");
    return undefined;
  }
  return { url: endpoint.url, headers: Service.headers(endpoint), source: "discovery" };
}

/**
 * Return one client for this sweep, verified against the current process PID. The
 * process's own serve address is preferred; the shared service registry is a fallback
 * only, so a broken or foreign registry can never hide a live private serve.
 */
export async function resolveCurrentProcessClient(
  options: ResolveClientOptions = {},
): Promise<Client> {
  const signal = options.signal ?? new AbortController().signal;
  const context: ResolverContext = {
    signal,
    pid: options.pid ?? process.pid,
    make: options.make ?? OpenCode.make,
    discover: options.discover ?? Service.discover,
    log: options.log ?? defaultLog,
  };

  assertNotAborted(signal);
  const argvCandidate = resolveArgvEndpoint(
    options.argv ?? process.argv,
    options.env ?? process.env,
  );
  if (argvCandidate !== undefined) {
    const client = await verifyCandidate(argvCandidate, context);
    if (client !== undefined) return client;
  }

  assertNotAborted(signal);
  const discovered = await discoveryCandidate(context);
  if (discovered !== undefined) {
    const client = await verifyCandidate(discovered, context);
    if (client !== undefined) return client;
  }

  assertNotAborted(signal);
  throw new Error("Cannot verify the current OpenCode service; refusing to sweep sessions.");
}
