#!/usr/bin/env node
// Subprocess boundary stub for codex-rpc.test.ts, never the real Codex.
import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

if (process.argv.includes("--version")) {
  console.log("codex-cli 0.163.0");
  process.exit(0);
}

const root = dirname(fileURLToPath(import.meta.url));
const mode = process.env.FAKE_CODEX_MODE;
const send = (message) => console.log(JSON.stringify(message));
writeFileSync(join(root, "pid"), String(process.pid));
if (mode === "ignore-sigterm") process.on("SIGTERM", () => {});

const reader = createInterface({ input: process.stdin });
reader.on("line", (line) => {
  const message = JSON.parse(line);
  appendFileSync(join(root, "messages.log"), `${line}\n`);
  const { id, method } = message;
  if (method === "initialized") return;
  if (method === "initialize") {
    send({ id, result: { codexHome: process.env.FAKE_CODEX_HOME ?? process.env.CODEX_HOME } });
    return;
  }
  if (mode === "hang") return;
  if (mode === "ambiguous") {
    send({ id, result: {}, error: { code: -32603, message: "ambiguous" } });
    return;
  }
  if (mode === "rpc-error" && method === "thread/delete") {
    send({ id, error: { code: -32602, message: "bad params token=fixture-secret" } });
    return;
  }
  send({ method: "thread/started", params: { threadId: "notification" } });
  const result =
    method === "thread/read"
      ? { thread: { id: message.params.threadId, turns: [] } }
      : method === "thread/delete"
        ? {}
        : { data: [], nextCursor: null };
  send({ id, result });
});

reader.on("close", () => {
  if (mode === "ignore-sigterm") setInterval(() => {}, 1000);
  else process.exit(0);
});
