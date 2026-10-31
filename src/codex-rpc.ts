import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { type Interface, createInterface } from "node:readline";
import { promisify } from "node:util";
import { redactSecrets } from "./redact.js";

const execFileAsync = promisify(execFile);
const PACKAGE_VERSION = createRequire(import.meta.url)("../package.json").version as string;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_GRACE_MS = 1_000;
const STDERR_LIMIT = 500;
const ALLOWED_METHODS = new Set([
  "thread/list",
  "thread/loaded/list",
  "thread/read",
  "thread/delete",
]);

export interface CodexRpcClient {
  readonly version: string;
  readonly codexHome: string;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export type CodexClientOptions = {
  /** Per-request timeout. Overridable so focused tests do not wait the production 30s. */
  requestTimeoutMs?: number;
  /** Grace period between stdin close, SIGTERM and SIGKILL. */
  closeGraceMs?: number;
};

/** The server answered with an explicit JSON-RPC error, so the outcome is known. */
export class CodexRequestError extends Error {
  readonly code?: number | string;

  constructor(message: string, code?: number | string) {
    super(message);
    this.name = "CodexRequestError";
    this.code = code;
  }
}

/** Timeout, broken pipe, malformed line or early exit: the outcome is unknown. */
export class CodexTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CodexTransportError";
  }
}

type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForExit(child: ChildProcessWithoutNullStreams, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), ms);
    child.once("exit", onExit);
  });
}

async function readCodexVersion(env: NodeJS.ProcessEnv): Promise<string> {
  let output: string;
  try {
    const result = await execFileAsync("codex", ["--version"], {
      env,
      encoding: "utf8",
      timeout: DEFAULT_REQUEST_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    });
    output = String(result.stdout);
  } catch (error) {
    throw new CodexTransportError(
      redactSecrets(`failed to read codex version: ${errorMessage(error)}`),
      { cause: error },
    );
  }
  const match = /(?:^|\s)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.]+)?)(?=\s|$)/.exec(output.trim());
  const version = match?.[1];
  if (!version) {
    throw new CodexTransportError("could not parse the version reported by codex --version");
  }
  return version;
}

class CodexAppServerClient implements CodexRpcClient {
  readonly version: string;

  private readonly options: Required<CodexClientOptions>;
  private readonly expectedHome: string | undefined;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly reader: Interface;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stderr = "";
  private home = "";
  private failure: Error | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;
  private exitTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(version: string, env: NodeJS.ProcessEnv, options: CodexClientOptions) {
    this.version = version;
    this.expectedHome = env.CODEX_HOME;
    this.options = {
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      closeGraceMs: options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS,
    };
    this.child = spawn("codex", ["app-server"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.reader = createInterface({
      input: this.child.stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    this.reader.on("line", (line) => this.onLine(line));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_LIMIT);
    });
    this.child.stdin.on("error", () => {
      if (!this.closed) this.abort("codex app-server stdin closed unexpectedly");
    });
    this.child.on("error", (error) => {
      this.abort(`failed to run codex app-server: ${error.message}`, error);
    });
    this.child.on("exit", (code, signal) => {
      this.clearExitTimer();
      this.reader.close();
      if (!this.closed) {
        this.abort(
          `codex app-server exited unexpectedly (code ${code ?? "null"}, signal ${signal ?? "null"})`,
        );
      }
    });
  }

  get codexHome(): string {
    return this.home;
  }

  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!ALLOWED_METHODS.has(method)) {
      return Promise.reject(new Error(`codex app-server method is not allowed: ${method}`));
    }
    return this.call(method, params);
  }

  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  async initialize(): Promise<void> {
    const result = await this.call("initialize", {
      clientInfo: { name: "opencode-sweeper", version: PACKAGE_VERSION },
    });
    if (!isRecord(result) || typeof result.codexHome !== "string" || result.codexHome === "") {
      throw new CodexTransportError("codex app-server initialize response is missing codexHome");
    }
    const reported = result.codexHome;
    if (!isAbsolute(reported)) {
      throw new CodexTransportError("codex app-server initialize returned a relative codexHome");
    }
    let canonical: string;
    try {
      canonical = await realpath(reported);
      const info = await stat(canonical);
      if (!info.isDirectory()) {
        throw new Error("codexHome is not a directory");
      }
      await access(canonical, constants.R_OK | constants.X_OK);
    } catch (error) {
      throw new CodexTransportError(
        redactSecrets(
          `codex app-server initialize returned an unreadable codexHome: ${errorMessage(error)}`,
        ),
        { cause: error },
      );
    }
    if (!isAbsolute(canonical)) {
      throw new CodexTransportError(
        "codex app-server initialize did not return an absolute codexHome",
      );
    }
    if (this.expectedHome !== undefined) {
      if (this.expectedHome === "") {
        throw new CodexTransportError("CODEX_HOME is set but empty");
      }
      let expectedCanonical: string;
      try {
        expectedCanonical = await realpath(this.expectedHome);
      } catch (error) {
        throw new CodexTransportError(
          redactSecrets(`CODEX_HOME cannot be resolved: ${errorMessage(error)}`),
          { cause: error },
        );
      }
      if (expectedCanonical !== canonical) {
        throw new CodexTransportError(
          "codex app-server initialize codexHome does not match CODEX_HOME",
        );
      }
    }
    this.home = canonical;
    this.write({ method: "initialized" });
  }

  private call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new CodexTransportError("codex app-server client is closed"));
    }
    if (this.failure) return Promise.reject(this.failure);
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return Promise.reject(new CodexTransportError("codex app-server is not running"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.abort(`codex app-server request timed out: ${method}`),
        this.options.requestTimeoutMs,
      );
      this.pending.set(id, { resolve, reject, timer });
      this.write(params === undefined ? { id, method } : { id, method, params });
    });
  }

  private write(message: unknown): void {
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.abort("failed to write to codex app-server", error);
    }
  }

  private onLine(line: string): void {
    if (this.closed || this.failure) return;
    const text = line.trim();
    if (text === "") return;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      this.abort("codex app-server wrote a line that is not JSON");
      return;
    }
    if (!isRecord(message)) {
      this.abort("codex app-server wrote an invalid JSON-RPC message");
      return;
    }
    if (message.method !== undefined) {
      if (typeof message.method !== "string") {
        this.abort("codex app-server wrote an invalid JSON-RPC method");
        return;
      }
      if (Object.hasOwn(message, "id")) {
        this.abort(`codex app-server sent an unexpected request: ${message.method}`);
      }
      return; // Notifications carry no id and are not ours to answer.
    }
    if (!Object.hasOwn(message, "id") || typeof message.id !== "number") {
      this.abort("codex app-server wrote a response without a usable id");
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.abort(`codex app-server wrote a response with unknown id ${message.id}`);
      return;
    }
    const hasResult = Object.hasOwn(message, "result");
    const hasError = Object.hasOwn(message, "error") && message.error !== null;
    if (hasResult && hasError) {
      // JSON-RPC 2.0 forbids both members in one response; the outcome is ambiguous.
      this.abort("codex app-server wrote a response with both result and error");
      return;
    }
    if (hasResult) {
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message.result);
      return;
    }
    if (hasError) {
      const error = message.error;
      if (
        !isRecord(error) ||
        typeof error.message !== "string" ||
        (error.code !== undefined &&
          typeof error.code !== "number" &&
          typeof error.code !== "string")
      ) {
        this.abort("codex app-server wrote an invalid JSON-RPC error");
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.reject(
        new CodexRequestError(
          redactSecrets(error.message),
          error.code as number | string | undefined,
        ),
      );
      return;
    }
    this.abort("codex app-server wrote a response with neither result nor error");
  }

  private abort(message: string, cause?: unknown): void {
    if (this.failure) return;
    const detail = this.stderr.trim();
    const error = new CodexTransportError(
      redactSecrets(detail ? `${message}: ${detail}` : message),
      {
        cause,
      },
    );
    this.failure = error;
    this.rejectPending(error);
    this.kill("SIGTERM");
    if (
      this.exitTimer === undefined &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    ) {
      this.exitTimer = setTimeout(() => this.kill("SIGKILL"), this.options.closeGraceMs);
    }
  }

  private rejectPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private kill(signal: "SIGTERM" | "SIGKILL"): void {
    try {
      this.child.kill(signal);
    } catch {
      // The child is already gone; nothing to clean up.
    }
  }

  private clearExitTimer(): void {
    if (this.exitTimer !== undefined) {
      clearTimeout(this.exitTimer);
      this.exitTimer = undefined;
    }
  }

  private async shutdown(): Promise<void> {
    this.clearExitTimer();
    this.closed = true;
    this.rejectPending(new CodexTransportError("codex app-server client is closed"));
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      this.reader.close();
      return;
    }
    this.child.stdin.end();
    if (await waitForExit(this.child, this.options.closeGraceMs)) {
      this.reader.close();
      return;
    }
    this.kill("SIGTERM");
    if (await waitForExit(this.child, this.options.closeGraceMs)) {
      this.reader.close();
      return;
    }
    this.kill("SIGKILL");
    await waitForExit(this.child, this.options.closeGraceMs);
    this.reader.close();
  }
}

export async function createCodexClient(
  env: NodeJS.ProcessEnv = process.env,
  options: CodexClientOptions = {},
): Promise<CodexRpcClient> {
  const version = await readCodexVersion(env);
  const client = new CodexAppServerClient(version, env, options);
  try {
    await client.initialize();
  } catch (error) {
    await client.close();
    throw error;
  }
  return client;
}
