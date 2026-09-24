import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const PACKAGE_NAME = "opencode-sweeper";
const REPOSITORY_URL = "git+https://github.com/jeffusion/opencode-sweeper.git";
const REQUIRED_FILES = ["dist/index.js", "dist/v2.js", "dist/cli.js", "server.js"];
const MAX_REGISTRY_BODY_BYTES = 4 * 1024 * 1024;
const MAX_PACK_INPUT_BYTES = 1024 * 1024;
const REGISTRY_TIMEOUT_MS = 10_000;
const REGISTRY_PACKAGE_URL = `https://registry.npmjs.org/${PACKAGE_NAME}`;

export function stableVersion(value) {
  if (typeof value !== "string") return false;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  return match?.slice(1).every((part) => Number.isSafeInteger(Number(part))) ?? false;
}

export function compareVersions(left, right) {
  if (!stableVersion(left) || !stableVersion(right))
    throw new Error("Expected stable semver versions");
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export function validateReleaseMetadata({
  packageJson,
  manifest,
  tag,
  repository,
  headCommit,
  tagCommit,
}) {
  if (repository !== "jeffusion/opencode-sweeper")
    throw new Error(`Unexpected repository: ${repository}`);
  if (packageJson.name !== PACKAGE_NAME)
    throw new Error(`Unexpected package name: ${packageJson.name}`);
  if (packageJson.repository?.url !== REPOSITORY_URL)
    throw new Error("package.json repository URL mismatch");
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)) {
    throw new Error(`Release tag is not stable semver: ${tag}`);
  }
  const version = tag.slice(1);
  if (!stableVersion(packageJson.version) || packageJson.version !== version) {
    throw new Error(`Tag ${tag} does not match package version ${packageJson.version}`);
  }
  if (manifest?.["."] !== version)
    throw new Error(`Tag ${tag} does not match manifest version ${manifest?.["."]}`);
  if (!headCommit || !tagCommit || headCommit !== tagCommit) {
    throw new Error("Checked-out commit does not match the release tag commit");
  }
  return version;
}

async function cancelBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The body may already have been canceled by the runtime.
  }
}

async function readLimitedBody(response) {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      await cancelBody(response);
      throw new Error("npm registry returned an invalid content length");
    }
    if (declaredLength > MAX_REGISTRY_BODY_BYTES) {
      await cancelBody(response);
      throw new Error("npm registry response exceeds 4 MiB");
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REGISTRY_BODY_BYTES) {
        await reader.cancel();
        throw new Error("npm registry response exceeds 4 MiB");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

async function getRegistryResponse(url, fetchImpl) {
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    redirect: "error",
  });
  if (response.redirected) {
    await cancelBody(response);
    throw new Error("npm registry redirected the request");
  }
  return response;
}

export async function checkRegistry({ version, fetchImpl = globalThis.fetch }) {
  if (!stableVersion(version)) throw new Error(`Release version is not stable semver: ${version}`);
  if (typeof fetchImpl !== "function") throw new Error("Fetch is unavailable");

  const response = await getRegistryResponse(REGISTRY_PACKAGE_URL, fetchImpl);
  if (response.status !== 200) {
    await cancelBody(response);
    throw new Error(`npm package metadata endpoint returned unexpected status ${response.status}`);
  }

  let packageData;
  try {
    packageData = JSON.parse(await readLimitedBody(response));
  } catch (error) {
    throw new Error(`npm package metadata endpoint returned invalid data: ${error.message}`);
  }
  if (
    packageData?.name !== PACKAGE_NAME ||
    packageData?.versions === null ||
    typeof packageData?.versions !== "object" ||
    Array.isArray(packageData.versions)
  ) {
    throw new Error("npm package metadata endpoint returned invalid package metadata");
  }
  if (Object.hasOwn(packageData.versions, version)) {
    throw new Error(`Version ${version} is already published`);
  }

  const latest = packageData?.["dist-tags"]?.latest;
  if (!stableVersion(latest) || !Object.hasOwn(packageData.versions, latest)) {
    throw new Error("npm package metadata endpoint returned an invalid latest dist-tag");
  }
  const publishedStableVersions = Object.keys(packageData.versions).filter(stableVersion);
  if (publishedStableVersions.length === 0) {
    throw new Error("npm package metadata contains no stable published versions");
  }
  const highest = publishedStableVersions.reduce((highestVersion, publishedVersion) =>
    compareVersions(publishedVersion, highestVersion) > 0 ? publishedVersion : highestVersion,
  );
  if (compareVersions(version, highest) <= 0) {
    throw new Error(`Release ${version} is not newer than highest published version ${highest}`);
  }
  if (compareVersions(version, latest) <= 0) {
    throw new Error(`Release ${version} is not newer than npm latest ${latest}`);
  }
  return { publish: true, latest, highest };
}

export function validatePackFiles(packResult) {
  const parsed = typeof packResult === "string" ? JSON.parse(packResult) : packResult;
  const files = new Set(parsed?.[0]?.files?.map((file) => file.path));
  const missing = REQUIRED_FILES.filter((file) => !files.has(file));
  if (missing.length) throw new Error(`npm pack is missing required files: ${missing.join(", ")}`);
  return true;
}

async function metadata() {
  const [packageJson, manifest] = await Promise.all([
    readFile("package.json", "utf8").then(JSON.parse),
    readFile(".release-please-manifest.json", "utf8").then(JSON.parse),
  ]);
  const tag = process.env.RELEASE_TAG;
  const repository = process.env.GITHUB_REPOSITORY;
  const headCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const tagCommit = execFileSync("git", ["rev-parse", `refs/tags/${tag}^{commit}`], {
    encoding: "utf8",
  }).trim();
  return validateReleaseMetadata({ packageJson, manifest, tag, repository, headCommit, tagCommit });
}

async function main() {
  const [command] = process.argv.slice(2);
  if (command === "metadata") {
    const version = await metadata();
    console.log(`Release metadata verified for ${PACKAGE_NAME}@${version}`);
  } else if (command === "registry") {
    const version = await metadata();
    const result = await checkRegistry({ version });
    console.log(`Registry permits publishing ${PACKAGE_NAME}@${version} (latest ${result.latest})`);
  } else if (command === "pack") {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > MAX_PACK_INPUT_BYTES) throw new Error("npm pack output exceeds 1 MiB");
      chunks.push(chunk);
    }
    validatePackFiles(Buffer.concat(chunks, size).toString("utf8"));
    console.log("npm pack contains all required release files");
  } else {
    throw new Error("Usage: check-release.mjs <metadata|registry|pack>");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`Release check failed: ${error.message}`);
    process.exitCode = 1;
  });
}
