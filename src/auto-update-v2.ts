import { createRequire } from "node:module";
import { compareVersions, stableVersion } from "./config-file.js";
import { discoverV2UpdateTarget } from "./update-v2-discovery.js";
import { updateV2PluginVersion } from "./update-v2.js";

const PACKAGE_NAME = "opencode-sweeper";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const PACKAGE_VERSION = createRequire(import.meta.url)("../package.json").version as string;
const MAX_BODY_BYTES = 64 * 1024;
const TIMEOUT_MS = 5_000;

type Entry = string | { package: string; options?: Record<string, unknown> };
type UpdateTarget = { path: string; entry: Entry };
type Discover = typeof discoverV2UpdateTarget;
type Update = typeof updateV2PluginVersion;
const ABORTED = Symbol("aborted");

async function awaitAbortable<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T | typeof ABORTED> {
  if (!signal) return promise;
  if (signal.aborted) return ABORTED;
  return new Promise<T | typeof ABORTED>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      resolve(ABORTED);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    // Both handlers stay attached after abort, consuming late rejection safely.
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

export type V2AutoUpdateDependencies = {
  sourceCheck: () => Promise<string | false>;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  home?: string;
  version?: string;
  signal?: AbortSignal;
  log?: (message: string) => void;
  update?: Update;
  discover?: Discover;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sourceSpec(spec: unknown): spec is string {
  if (spec === PACKAGE_NAME || spec === `${PACKAGE_NAME}@latest`) return true;
  const prefix = `${PACKAGE_NAME}@`;
  return (
    typeof spec === "string" &&
    spec.startsWith(prefix) &&
    !!stableVersion(spec.slice(prefix.length))
  );
}

/** Validate plugin.list metadata and return its exact package target. */
export function hasVerifiedPackagePlugin(
  result: unknown,
  locationDirectory: string,
): string | false {
  if (
    !isRecord(result) ||
    !isRecord(result.location) ||
    result.location.directory !== locationDirectory ||
    !Array.isArray(result.data)
  )
    return false;
  const matches = result.data.filter(
    (plugin: unknown) => isRecord(plugin) && plugin.id === PACKAGE_NAME,
  );
  if (matches.length !== 1) return false;
  const plugin = matches[0];
  if (
    !isRecord(plugin) ||
    !isRecord(plugin.state) ||
    plugin.state.status !== "active" ||
    !isRecord(plugin.features) ||
    plugin.features.server !== true ||
    !isRecord(plugin.source) ||
    plugin.source.type !== "package"
  )
    return false;
  return sourceSpec(plugin.source.target) ? plugin.source.target : false;
}

function entrySpec(entry: Entry): string | null {
  const spec = typeof entry === "string" ? entry : entry.package;
  return sourceSpec(spec) ? spec : null;
}

async function readLimitedBody(
  response: Response,
  setReader: (reader: ReadableStreamDefaultReader<Uint8Array>) => void,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES)
    throw new Error("Registry response too large");
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES)
      throw new Error("Registry response too large");
    return text;
  }
  const reader = response.body.getReader();
  setReader(reader as ReadableStreamDefaultReader<Uint8Array>);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new Error("Registry response too large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

/** Update a previously verified V2 package target. This never installs or reloads plugins. */
export async function runV2AutoUpdate(
  locationDirectory: string,
  deps: V2AutoUpdateDependencies,
): Promise<boolean> {
  const {
    sourceCheck,
    env = process.env,
    home,
    fetch: fetchImpl = globalThis.fetch,
    version = PACKAGE_VERSION,
    signal,
    log = console.log,
    update = updateV2PluginVersion,
    discover = discoverV2UpdateTarget,
  } = deps;
  try {
    if (signal?.aborted || typeof sourceCheck !== "function") return false;
    const sourceResult = await awaitAbortable(Promise.resolve().then(sourceCheck), signal);
    if (sourceResult === ABORTED || signal?.aborted) return false;
    const sourceTarget = sourceResult;
    if (typeof sourceTarget !== "string" || !sourceSpec(sourceTarget)) return false;
    const options = { env, ...(home === undefined ? {} : { home }) };
    const target = (await discover(locationDirectory, options)) as UpdateTarget | null;
    if (signal?.aborted || !target) return false;
    const discoveredSpec = entrySpec(target.entry);
    if (!discoveredSpec || discoveredSpec !== sourceTarget) return false;

    const controller = new AbortController();
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timedOut = false;
    let rejectTimeout!: (reason: Error) => void;
    let rejectAbort!: (reason: Error) => void;
    const timeoutPromise = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });
    const abortPromise = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => {
      controller.abort();
      void reader?.cancel().catch(() => {});
      void Promise.resolve(response?.body?.cancel()).catch(() => {});
      rejectAbort(new Error("Registry request canceled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      void reader?.cancel().catch(() => {});
      void Promise.resolve(response?.body?.cancel()).catch(() => {});
      rejectTimeout(new Error("Registry request timed out"));
    }, TIMEOUT_MS);
    try {
      if (signal?.aborted) return false;
      const request = (async () => {
        response = await fetchImpl(REGISTRY_URL, { signal: controller.signal, redirect: "error" });
        if (timedOut || signal?.aborted) {
          void Promise.resolve(response.body?.cancel()).catch(() => {});
          throw new Error("Registry request canceled");
        }
        if (!response.ok) return null;
        return JSON.parse(
          await readLimitedBody(response, (value) => {
            reader = value;
          }),
        ) as unknown;
      })();
      const payload = await Promise.race([request, timeoutPromise, abortPromise]);
      if (
        signal?.aborted ||
        !isRecord(payload) ||
        payload.name !== PACKAGE_NAME ||
        typeof payload.version !== "string" ||
        !stableVersion(payload.version)
      )
        return false;
      const current = entrySpec(target.entry);
      const pinned =
        current === PACKAGE_NAME || current === `${PACKAGE_NAME}@latest`
          ? null
          : current?.slice(`${PACKAGE_NAME}@`.length);
      const runningComparison = compareVersions(payload.version, version);
      const pinnedComparison = pinned ? compareVersions(payload.version, pinned) : null;
      if (
        runningComparison === null ||
        runningComparison <= 0 ||
        (pinned !== null &&
          pinned !== undefined &&
          (pinnedComparison === null || pinnedComparison <= 0))
      )
        return false;

      const latestResult = await awaitAbortable(Promise.resolve().then(sourceCheck), signal);
      if (latestResult === ABORTED) return false;
      const latestSource = latestResult;
      if (signal?.aborted || latestSource !== sourceTarget || latestSource !== discoveredSpec)
        return false;
      const validate = async (): Promise<boolean> => {
        if (signal?.aborted) return false;
        const latestTarget = (await discover(locationDirectory, options)) as UpdateTarget | null;
        if (
          signal?.aborted ||
          !latestTarget ||
          latestTarget.path !== target.path ||
          JSON.stringify(latestTarget.entry) !== JSON.stringify(target.entry) ||
          entrySpec(latestTarget.entry) !== discoveredSpec
        )
          return false;
        const sourceResult = await awaitAbortable(Promise.resolve().then(sourceCheck), signal);
        return sourceResult !== ABORTED && !signal?.aborted && sourceResult === sourceTarget;
      };
      const updated = await update(target.path, target.entry, payload.version, {
        validate,
        signal,
      });
      if (updated) log("[opencode-sweeper] 已更新配置，重启生效。");
      return !!updated;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  } catch {
    return false;
  }
}
