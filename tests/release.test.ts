import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  checkRegistry,
  compareVersions,
  stableVersion,
  validatePackFiles,
  validateReleaseMetadata,
} from "../scripts/check-release.mjs";

const metadata = {
  packageJson: {
    name: "opencode-sweeper",
    version: "0.2.1",
    repository: { url: "git+https://github.com/jeffusion/opencode-sweeper.git" },
  },
  manifest: { ".": "0.2.1" },
  tag: "v0.2.1",
  repository: "jeffusion/opencode-sweeper",
  headCommit: "abc123",
  tagCommit: "abc123",
};

test("validates stable versions and ordering", () => {
  expect(stableVersion("0.2.1")).toBe(true);
  expect(stableVersion("0.2.1-rc.1")).toBe(false);
  expect(stableVersion("999999999999999999999.2.1")).toBe(false);
  expect(compareVersions("1.0.0", "0.99.9")).toBe(1);
  expect(compareVersions("0.2.1", "0.2.1")).toBe(0);
});

test("requires package, manifest, repository, tag, and checked-out commit to match", () => {
  expect(validateReleaseMetadata(metadata)).toBe("0.2.1");
  expect(() => validateReleaseMetadata({ ...metadata, tag: "v0.2.0" })).toThrow();
  expect(() => validateReleaseMetadata({ ...metadata, manifest: { ".": "0.2.0" } })).toThrow();
  expect(() => validateReleaseMetadata({ ...metadata, repository: "someone/else" })).toThrow();
  expect(() => validateReleaseMetadata({ ...metadata, tagCommit: "different" })).toThrow();
});

function registryMetadata(versions: Record<string, unknown> = { "0.2.0": {} }, latest = "0.2.0") {
  return JSON.stringify({
    name: "opencode-sweeper",
    versions,
    "dist-tags": { latest },
  });
}

const latestBody = registryMetadata();

function response(status: number, body = "") {
  return new Response(body, { status });
}

test("registry accepts one complete metadata response with a strictly newer absent version", async () => {
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const fetchMock = async (input: string | URL | Request, options?: RequestInit) => {
    const url = String(input);
    calls.push({ url, options: options ?? {} });
    return response(200, latestBody);
  };
  expect(await checkRegistry({ version: "0.2.1", fetchImpl: fetchMock as typeof fetch })).toEqual({
    publish: true,
    latest: "0.2.0",
    highest: "0.2.0",
  });
  expect(calls.map(({ url }) => url)).toEqual(["https://registry.npmjs.org/opencode-sweeper"]);
  for (const { options } of calls) {
    expect(options.redirect).toBe("error");
    expect(options.signal).toBeInstanceOf(AbortSignal);
  }
});

test("registry rejects root 404, unexpected statuses, invalid metadata, timeout, and redirects", async () => {
  for (const status of [404, 401, 429, 500]) {
    await expect(
      checkRegistry({
        version: "0.2.1",
        fetchImpl: (async () => response(status)) as typeof fetch,
      }),
    ).rejects.toThrow("package metadata endpoint returned unexpected status");
  }
  for (const invalidBody of [
    "not-json",
    JSON.stringify({ name: "wrong", versions: { "0.2.0": {} }, "dist-tags": { latest: "0.2.0" } }),
    JSON.stringify({ name: "opencode-sweeper", versions: [], "dist-tags": { latest: "0.2.0" } }),
    JSON.stringify({ name: "opencode-sweeper", versions: { "0.2.0": {} }, "dist-tags": {} }),
  ]) {
    await expect(
      checkRegistry({
        version: "0.2.1",
        fetchImpl: (async () => response(200, invalidBody)) as typeof fetch,
      }),
    ).rejects.toThrow();
  }
  await expect(
    checkRegistry({
      version: "0.2.1",
      fetchImpl: (async () => {
        throw new DOMException("The operation timed out", "TimeoutError");
      }) as typeof fetch,
    }),
  ).rejects.toThrow("timed out");
  await expect(
    checkRegistry({
      version: "0.2.1",
      fetchImpl: (async () => {
        throw new TypeError("redirect mode error");
      }) as typeof fetch,
    }),
  ).rejects.toThrow("redirect mode error");
  const redirectedResponse = response(200, latestBody);
  Object.defineProperty(redirectedResponse, "redirected", { value: true });
  await expect(
    checkRegistry({
      version: "0.2.1",
      fetchImpl: (async () => redirectedResponse) as typeof fetch,
    }),
  ).rejects.toThrow("redirected the request");
});

test("registry bounds metadata and rejects stale or already-published target versions", async () => {
  const oversized = new Response(latestBody, {
    status: 200,
    headers: { "content-length": String(4 * 1024 * 1024 + 1) },
  });
  await expect(
    checkRegistry({ version: "0.2.1", fetchImpl: (async () => oversized) as typeof fetch }),
  ).rejects.toThrow("exceeds 4 MiB");

  let canceled = false;
  const oversizedStream = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
      },
      cancel() {
        canceled = true;
      },
    }),
    { status: 200 },
  );
  await expect(
    checkRegistry({ version: "0.2.1", fetchImpl: (async () => oversizedStream) as typeof fetch }),
  ).rejects.toThrow("exceeds 4 MiB");
  expect(canceled).toBe(true);

  await expect(
    checkRegistry({
      version: "0.1.9",
      fetchImpl: (async () => response(200, latestBody)) as typeof fetch,
    }),
  ).rejects.toThrow("not newer");

  await expect(
    checkRegistry({
      version: "0.3.0",
      fetchImpl: (async () =>
        response(200, registryMetadata({ "0.2.0": {}, "0.4.0": {} }))) as typeof fetch,
    }),
  ).rejects.toThrow("not newer than highest published version 0.4.0");

  await expect(
    checkRegistry({
      version: "0.2.1",
      fetchImpl: (async () =>
        response(200, registryMetadata({ "0.2.0": {}, "0.2.1": {} }))) as typeof fetch,
    }),
  ).rejects.toThrow("already published");
});

test("pack CLI reads piped stdin and exits successfully or unsuccessfully", () => {
  const validOutput = JSON.stringify([
    {
      files: ["dist/index.js", "dist/v2.js", "dist/cli.js", "server.js"].map((path) => ({ path })),
    },
  ]);
  const script = resolve("scripts/check-release.mjs");
  const success = spawnSync(process.execPath, [script, "pack"], {
    input: validOutput,
    encoding: "utf8",
  });
  expect(success.status).toBe(0);
  expect(success.stdout).toContain("all required release files");

  const failure = spawnSync(process.execPath, [script, "pack"], {
    input: JSON.stringify([{ files: [{ path: "dist/index.js" }] }]),
    encoding: "utf8",
  });
  expect(failure.status).not.toBe(0);
  expect(failure.stderr).toContain("dist/v2.js");

  const oversizedInput = spawnSync(process.execPath, [script, "pack"], {
    input: Buffer.alloc(1024 * 1024 + 1),
    encoding: "utf8",
  });
  expect(oversizedInput.status).not.toBe(0);
  expect(oversizedInput.stderr).toContain("exceeds 1 MiB");
});

test("requires expected files in npm pack dry-run output", () => {
  const files = ["dist/index.js", "dist/v2.js", "dist/cli.js", "server.js"];
  expect(validatePackFiles(JSON.stringify([{ files: files.map((path) => ({ path })) }]))).toBe(
    true,
  );
  expect(() => validatePackFiles(JSON.stringify([{ files: [{ path: "dist/index.js" }] }]))).toThrow(
    "dist/v2.js",
  );
});
