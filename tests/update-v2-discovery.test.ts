import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverV2UpdateTarget } from "../src/update-v2-discovery.js";

const roots: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "opencode-sweeper-v2-"));
  roots.push(root);
  const location = join(root, "workspace", "project");
  const home = join(root, "home");
  const env = { XDG_CONFIG_HOME: join(root, "xdg") };
  await mkdir(location, { recursive: true });
  await mkdir(home, { recursive: true });
  return { root, location, home, env };
}

async function config(path: string, contents: unknown = { plugins: ["opencode-sweeper@1.2.3"] }) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(contents, null, 2)}\n`);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("discovers one legal V2 string or object registration", async () => {
  for (const entry of [
    "opencode-sweeper@1.2.3",
    { package: "opencode-sweeper", options: { enabled: true } },
  ]) {
    const f = await fixture();
    const path = join(f.location, "opencode.jsonc");
    await config(path, { plugins: [entry] });
    expect(await discoverV2UpdateTarget(f.location, { env: f.env, home: f.home })).toEqual({
      path,
      entry,
    });
  }
});

test("rejects project/global conflicts and duplicate registrations", async () => {
  const f = await fixture();
  await config(join(f.location, "opencode.json"));
  await config(join(f.env.XDG_CONFIG_HOME, "opencode", "opencode.jsonc"));
  expect(await discoverV2UpdateTarget(f.location, { env: f.env, home: f.home })).toBeNull();

  const g = await fixture();
  await config(join(g.location, "opencode.json"));
  await config(join(g.location, ".opencode", "opencode.jsonc"));
  expect(await discoverV2UpdateTarget(g.location, { env: g.env, home: g.home })).toBeNull();
});

test("ancestor registration makes the result ambiguous even though ancestors are not writable targets", async () => {
  const f = await fixture();
  const local = join(f.location, "opencode.json");
  await config(local);
  await config(join(f.root, "workspace", "opencode.jsonc"));
  expect(await discoverV2UpdateTarget(f.location, { env: f.env, home: f.home })).toBeNull();
});

test("scans both supported config extensions in direct and hidden project locations", async () => {
  for (const [name, hidden] of [
    ["opencode.json", false],
    ["opencode.jsonc", true],
  ] as const) {
    const f = await fixture();
    const path = join(f.location, ...(hidden ? [".opencode"] : []), name);
    await config(path);
    expect((await discoverV2UpdateTarget(f.location, { env: f.env, home: f.home }))?.path).toBe(
      path,
    );
  }
});

test("rejects symlinks, malformed/duplicate-key config, and malformed tuple entries", async () => {
  const f = await fixture();
  const outside = join(f.root, "outside.json");
  await config(outside);
  await symlink(outside, join(f.location, "opencode.json"));
  expect(await discoverV2UpdateTarget(f.location, { env: f.env, home: f.home })).toBeNull();

  for (const contents of [
    '{"plugins":["opencode-sweeper"],"plugins":[]}',
    '{"plugins":[,]}',
    JSON.stringify({ plugins: [["opencode-sweeper", {}]] }),
  ]) {
    const g = await fixture();
    await writeFile(join(g.location, "opencode.jsonc"), contents);
    expect(await discoverV2UpdateTarget(g.location, { env: g.env, home: g.home })).toBeNull();
  }
});

test("rejects a symlink in an intermediate location ancestor", async () => {
  const f = await fixture();
  const actualProject = join(f.root, "actual", "project");
  await mkdir(actualProject, { recursive: true });
  await config(join(actualProject, "opencode.json"));
  await rm(join(f.root, "workspace"), { recursive: true, force: true });
  await symlink(join(f.root, "actual"), join(f.root, "workspace"));

  expect(await discoverV2UpdateTarget(f.location, { env: f.env, home: f.home })).toBeNull();
});

test("rejects a symlink used as the .opencode directory", async () => {
  const f = await fixture();
  const externalConfig = join(f.root, "external", "opencode.json");
  await config(externalConfig);
  await symlink(join(f.root, "external"), join(f.location, ".opencode"));

  expect(await discoverV2UpdateTarget(f.location, { env: f.env, home: f.home })).toBeNull();
});

test("rejects a symlinked XDG_CONFIG_HOME ancestor even without a global/opencode directory", async () => {
  const f = await fixture();
  await config(join(f.location, "opencode.json"));
  const xdgAncestor = join(f.root, "xdg-link");
  await mkdir(join(f.root, "real-xdg"), { recursive: true });
  await symlink(join(f.root, "real-xdg"), xdgAncestor);
  const env = { XDG_CONFIG_HOME: join(xdgAncestor, "config") };

  expect(await discoverV2UpdateTarget(f.location, { env, home: f.home })).toBeNull();
});

test("rejects opaque and local file plugin specs, but does not reject other removals", async () => {
  for (const entry of [
    { package: "file:///tmp/plugin" },
    { package: "another@npm:opencode-sweeper" },
    { package: "npm:opencode-sweeper" },
    "file:../plugin",
  ]) {
    const f = await fixture();
    await config(join(f.location, "opencode.json"), { plugins: [entry, "opencode-sweeper"] });
    expect(await discoverV2UpdateTarget(f.location, { env: f.env, home: f.home })).toBeNull();
  }

  const f = await fixture();
  const path = join(f.location, "opencode.json");
  await config(path, { plugins: ["-another-plugin", "opencode-sweeper"] });
  expect((await discoverV2UpdateTarget(f.location, { env: f.env, home: f.home }))?.path).toBe(path);
  for (const selector of ["-opencode-sweeper", "-opencode-sweeper@1.0.0", "-*"]) {
    const g = await fixture();
    await config(join(g.location, "opencode.json"), { plugins: [selector, "opencode-sweeper"] });
    expect(await discoverV2UpdateTarget(g.location, { env: g.env, home: g.home })).toBeNull();
  }
});

test("rejects V1 registrations, config overrides including empty values, and relative XDG paths", async () => {
  const f = await fixture();
  await config(join(f.location, "opencode.json"), { plugin: ["opencode-sweeper"], plugins: [] });
  expect(await discoverV2UpdateTarget(f.location, { env: f.env, home: f.home })).toBeNull();

  const g = await fixture();
  await config(join(g.location, "opencode.json"));
  for (const env of [
    { ...g.env, OPENCODE_CONFIG: "custom.json" },
    { ...g.env, OPENCODE_CONFIG: "" },
    { ...g.env, OPENCODE_CONFIG_DIR: "" },
    { XDG_CONFIG_HOME: "relative" },
  ]) {
    expect(await discoverV2UpdateTarget(g.location, { env, home: g.home })).toBeNull();
  }
});
