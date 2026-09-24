import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LOCK_NAME } from "../src/config-file.js";
import { updateV2PluginVersion } from "../src/update-v2.js";

const PACKAGE = "opencode-sweeper";
const FROM = `${PACKAGE}@0.1.0`;
const TO = "99.0.0";

async function inTemp(callback: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "sweeper-update-v2-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("updates a unique v2 string entry and preserves JSONC comments, CRLF, and other fields", async () => {
  await inTemp(async (directory) => {
    const path = join(directory, "opencode.jsonc");
    const original =
      // biome-ignore lint/style/useTemplate: Construct exact CRLF bytes under test.
      [
        "{",
        "  // keep comment",
        `  "plugins": ["${PACKAGE}", "other-plugin@1.2.3"],`,
        '  "other": { "keep": true },',
        "}",
      ].join("\r\n") + "\r\n";
    await writeFile(path, original);
    await chmod(path, 0o640);
    assert.equal(await updateV2PluginVersion(path, PACKAGE, TO), true);
    assert.equal(
      await readFile(path, "utf8"),
      original.replace(`"${PACKAGE}"`, `"${PACKAGE}@${TO}"`),
    );
    assert.equal((await lstat(path)).mode & 0o777, 0o640);
  });
});

test("object JSONC update changes only package bytes and preserves CRLF, comments, trailing comma, and mode", async () => {
  await inTemp(async (directory) => {
    const path = join(directory, "config.json");
    const entry = { package: FROM, options: { dryRun: true, interval: 0, protect: ["keep"] } };
    const original =
      // biome-ignore lint/style/useTemplate: Construct exact CRLF bytes under test.
      [
        "{",
        "  // preserve object configuration",
        '  "plugins": [',
        `    { "package": "${FROM}", "options": { "dryRun": true, "interval": 0, "protect": ["keep"] }, },`,
        '    "other",',
        "  ],",
        '  "other": true,',
        "}",
      ].join("\r\n") + "\r\n";
    await writeFile(path, original);
    await chmod(path, 0o640);
    assert.equal(await updateV2PluginVersion(path, entry, TO), true);
    assert.equal(await readFile(path, "utf8"), original.replace(`"${FROM}"`, `"${PACKAGE}@${TO}"`));
    assert.equal((await lstat(path)).mode & 0o777, 0o640);
  });
});

test("rejects invalid/unsupported options, disabled aliases, ranges, unstable and foreign entries", async () => {
  await inTemp(async (directory) => {
    const cases: Array<{
      entry: unknown;
      expected?: string | { package: string; options?: Record<string, unknown> };
    }> = [
      { entry: { package: FROM, options: [] } },
      { entry: { package: FROM, options: { mystery: true } } },
      { entry: { package: FROM, options: { enabled: false } } },
      { entry: { package: FROM, options: { disabled: true } } },
      { entry: `${PACKAGE}@^0.1.0`, expected: `${PACKAGE}@^0.1.0` },
      { entry: `${PACKAGE}@1.0.0-beta.1`, expected: `${PACKAGE}@1.0.0-beta.1` },
      { entry: "@opencode/plugin@2.0.15", expected: "@opencode/plugin@2.0.15" },
    ];
    for (const [index, item] of cases.entries()) {
      const path = join(directory, `invalid-${index}.json`);
      const original = JSON.stringify({ plugins: [item.entry] });
      await writeFile(path, original);
      const expected =
        item.expected ?? (item.entry as { package: string; options?: Record<string, unknown> });
      assert.equal(await updateV2PluginVersion(path, expected, TO), false);
      assert.equal(await readFile(path, "utf8"), original);
    }
  });
});

test("rejects dual fields, duplicate targets, tuples, malformed JSONC, and symlinks", async () => {
  await inTemp(async (directory) => {
    const contents = [
      JSON.stringify({ plugin: [PACKAGE], plugins: [PACKAGE] }),
      JSON.stringify({ plugins: [PACKAGE, PACKAGE] }),
      JSON.stringify({ plugins: [[PACKAGE, {}]] }),
      `{"plugins":["${PACKAGE}"`,
    ];
    for (const [index, content] of contents.entries()) {
      const path = join(directory, `rejected-${index}.json`);
      await writeFile(path, content);
      assert.equal(await updateV2PluginVersion(path, PACKAGE, TO), false);
      assert.equal(await readFile(path, "utf8"), content);
    }
    const target = join(directory, "target.json");
    const link = join(directory, "link.json");
    await writeFile(target, JSON.stringify({ plugins: [PACKAGE] }));
    await symlink(target, link);
    assert.equal(await updateV2PluginVersion(link, PACKAGE, TO), false);
  });
});

test("rejects downgrade, read-only files, and lock contention", async () => {
  await inTemp(async (directory) => {
    const path = join(directory, "config.json");
    const original = JSON.stringify({ plugins: [PACKAGE] });
    await writeFile(path, original);
    assert.equal(await updateV2PluginVersion(path, PACKAGE, "0.1.0"), false);

    const lock = join(directory, LOCK_NAME);
    await mkdir(lock);
    assert.equal(await updateV2PluginVersion(path, PACKAGE, TO), false);
    await rm(lock, { recursive: true, force: true });

    const readOnly = join(directory, "readonly.json");
    await writeFile(readOnly, original, { mode: 0o444 });
    assert.equal(await updateV2PluginVersion(readOnly, PACKAGE, TO), false);
  });
});

test("validates inside the lock and preserves candidate changes made during validation", async () => {
  await inTemp(async (directory) => {
    const path = join(directory, "config.json");
    const original = JSON.stringify({ plugins: [PACKAGE] });
    const userChanges = [
      JSON.stringify({ plugins: [`${PACKAGE}@1.0.0`] }),
      JSON.stringify({
        plugins: [{ package: PACKAGE, options: { dryRun: true, protect: ["user"] } }],
      }),
    ];
    for (const changed of userChanges) {
      await writeFile(path, original);
      let validations = 0;
      assert.equal(
        await updateV2PluginVersion(path, PACKAGE, TO, {
          validate: async () => {
            validations += 1;
            await lstat(join(dirname(path), LOCK_NAME));
            await writeFile(path, changed);
            return true;
          },
        }),
        false,
      );
      assert.equal(validations, 1);
      assert.equal(await readFile(path, "utf8"), changed);
    }
  });
});

test("rejects multiple registrations even when the other registration has a different pin or options", async () => {
  await inTemp(async (directory) => {
    const path = join(directory, "duplicates.json");
    const cases: Array<{ plugins: unknown[] }> = [
      { plugins: [PACKAGE, `${PACKAGE}@1.0.0`] },
      {
        plugins: [
          { package: PACKAGE, options: { dryRun: true } },
          { package: PACKAGE, options: { protect: ["other"] } },
        ],
      },
    ];
    for (const config of cases) {
      const original = JSON.stringify(config);
      await writeFile(path, original);
      const entry = config.plugins[0] as
        | string
        | { package: string; options?: Record<string, unknown> };
      assert.equal(await updateV2PluginVersion(path, entry, TO), false);
      assert.equal(await readFile(path, "utf8"), original);
    }
  });
});

test("aborting after validation prevents the locked update and removes its lock", async () => {
  await inTemp(async (directory) => {
    const path = join(directory, "config.json");
    const original = JSON.stringify({ plugins: [PACKAGE] });
    await writeFile(path, original);
    const controller = new AbortController();

    const result = await updateV2PluginVersion(path, PACKAGE, TO, {
      signal: controller.signal,
      validate: () =>
        Promise.resolve(true).then((valid) => {
          queueMicrotask(() => controller.abort());
          return valid;
        }),
    });

    assert.equal(result, false);
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal(
      (await readdir(directory)).some((name) => name.endsWith(".tmp")),
      false,
    );
    await assert.rejects(lstat(join(directory, LOCK_NAME)));
  });
});

test("rejects a symlinked ancestor directory", async () => {
  await inTemp(async (directory) => {
    const actualDirectory = join(directory, "actual");
    const linkedDirectory = join(directory, "linked");
    await mkdir(actualDirectory);
    await symlink(actualDirectory, linkedDirectory);
    const path = join(actualDirectory, "config.json");
    const original = JSON.stringify({ plugins: [PACKAGE] });
    await writeFile(path, original);
    assert.equal(
      await updateV2PluginVersion(join(linkedDirectory, "config.json"), PACKAGE, TO),
      false,
    );
    assert.equal(await readFile(path, "utf8"), original);
  });
});
