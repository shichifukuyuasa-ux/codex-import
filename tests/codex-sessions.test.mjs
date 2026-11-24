import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractMessages,
  listSessions,
  parseArgs,
  pickRef,
  renderTranscript,
  resolveSession,
} from "../plugins/codex-import/scripts/codex-sessions.mjs";

const SCRIPT = fileURLToPath(new URL("../plugins/codex-import/scripts/codex-sessions.mjs", import.meta.url));

function line(type, payload, timestamp = "2026-11-20T10:00:00.000Z") {
  return JSON.stringify({ timestamp, type, payload });
}

function userItem(text) {
  return line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] });
}

function assistantItem(text) {
  return line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }] });
}

function writeSession(home, { ts, id, cwd, lines, dir = "sessions" }) {
  const [y, m, d] = [ts.slice(0, 4), ts.slice(5, 7), ts.slice(8, 10)];
  const folder = path.join(home, dir, y, m, d);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `rollout-${ts}-${id}.jsonl`);
  const meta = line("session_meta", {
    id,
    session_id: id,
    timestamp: `${ts.slice(0, 10)}T10:00:00.000Z`,
    cwd,
    originator: "codex_cli_rs",
    cli_version: "0.99.0",
    base_instructions: { text: "x".repeat(5000) },
    git: { branch: "main", commit_hash: "abcdef1234567890" },
  });
  fs.writeFileSync(file, [meta, ...lines].join("\n") + "\n");
  return file;
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  const repo = path.join(home, "work", "repo");
  const other = path.join(home, "work", "other");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(other, { recursive: true });
  const a = writeSession(home, {
    ts: "2026-11-19T09-00-00",
    id: "11111111-1111-4111-8111-111111111111",
    cwd: repo,
    lines: [
      userItem("<environment_context>\n  <cwd>/x</cwd>\n</environment_context>"),
      line("response_item", { type: "message", role: "developer", content: [{ type: "input_text", text: "dev note" }] }),
      userItem("Fix the login bug"),
      line("event_msg", { type: "user_message", message: "Fix the login bug" }),
      line("response_item", { type: "reasoning", summary: [], encrypted_content: "zzz" }),
      line("response_item", { type: "function_call", name: "shell", arguments: '{"command":["rg","login"]}', call_id: "c1" }),
      line("response_item", { type: "function_call_output", call_id: "c1", output: '{"output":"src/login.ts:3"}' }),
      assistantItem("The bug is in src/login.ts; I changed the token check."),
      line("event_msg", { type: "agent_message", message: "The bug is in src/login.ts; I changed the token check." }),
    ],
  });
  const b = writeSession(home, {
    ts: "2026-11-20T09-00-00",
    id: "22222222-2222-4222-8222-222222222222",
    cwd: other,
    lines: [userItem("Write a README"), assistantItem("Done.")],
  });
  return { home, repo, other, a, b };
}

test("parseArgs splits a single quoted argument string", () => {
  const o = parseArgs(["latest --all --tools --max-chars 500 continue the fix"]);
  assert.equal(o.all, true);
  assert.equal(o.tools, true);
  assert.equal(o.maxChars, 500);
  assert.deepEqual(o.rest, ["latest", "continue", "the", "fix"]);
});

test("pickRef only treats session-like words as a reference", () => {
  assert.equal(pickRef("latest"), "latest");
  assert.equal(pickRef("3"), "3");
  assert.equal(pickRef("11111111"), "11111111");
  assert.equal(pickRef("この続きをやって"), undefined);
  assert.equal(pickRef("continue"), undefined);
  assert.equal(pickRef(undefined), undefined);
});

test("messages skip injected context, developer text, reasoning and duplicate events", () => {
  const { a } = makeHome();
  const records = fs.readFileSync(a, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(extractMessages(records), [
    { role: "user", text: "Fix the login bug" },
    { role: "assistant", text: "The bug is in src/login.ts; I changed the token check." },
  ]);
  const withTools = extractMessages(records, { tools: true });
  assert.equal(withTools.length, 4);
  assert.match(withTools[1].text, /^call shell: .*rg/);
  assert.equal(withTools[2].text, "output: src/login.ts:3");
});

test("event messages are used when a file has no response items", () => {
  const records = [
    { type: "session_meta", payload: { id: "x" } },
    { type: "event_msg", payload: { type: "user_message", message: "hello" } },
    { type: "event_msg", payload: { type: "agent_message", message: "hi" } },
  ];
  assert.deepEqual(extractMessages(records), [
    { role: "user", text: "hello" },
    { role: "assistant", text: "hi" },
  ]);
});

test("the older bare-record format is read", () => {
  const records = [
    { id: "old-id", timestamp: "2025-05-01T00:00:00Z", instructions: null },
    { record_type: "state" },
    { type: "message", role: "user", content: [{ type: "input_text", text: "old question" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "old answer" }] },
  ];
  assert.deepEqual(extractMessages(records), [
    { role: "user", text: "old question" },
    { role: "assistant", text: "old answer" },
  ]);
});

test("list filters by directory unless --all, newest first", () => {
  const { home, repo } = makeHome();
  const here = listSessions(home, parseArgs([]), path.join(repo, "src"));
  assert.equal(here.length, 1);
  assert.equal(here[0].preview, "Fix the login bug");
  const all = listSessions(home, parseArgs(["--all"]), repo);
  assert.deepEqual(all.map((s) => s.preview), ["Write a README", "Fix the login bug"]);
});

test("archived sessions are listed only with --archived", () => {
  const { home, repo } = makeHome();
  writeSession(home, {
    dir: "archived_sessions",
    ts: "2026-11-21T09-00-00",
    id: "33333333-3333-4333-8333-333333333333",
    cwd: repo,
    lines: [userItem("Archived work")],
  });
  assert.equal(listSessions(home, parseArgs([]), repo).length, 1);
  assert.equal(listSessions(home, parseArgs(["--archived"]), repo)[0].preview, "Archived work");
});

test("resolveSession accepts latest, a number, an ID prefix and a path", () => {
  const { home, repo, a, b } = makeHome();
  const all = parseArgs(["--all"]);
  assert.equal(resolveSession(home, "latest", all, repo), b);
  assert.equal(resolveSession(home, undefined, parseArgs([]), repo), a);
  assert.equal(resolveSession(home, "2", all, repo), a);
  assert.equal(resolveSession(home, "22222222", all, repo), b);
  assert.equal(resolveSession(home, a, all, repo), a);
  assert.throws(() => resolveSession(home, "9", all, repo), /No session number 9/);
  assert.throws(() => resolveSession(home, "deadbeef", all, repo), /No Codex session matches/);
});

test("transcript has a header and keeps the first request and the latest messages when trimmed", () => {
  const { home, repo } = makeHome();
  const lines = [userItem("ORIGINAL REQUEST")];
  for (let i = 0; i < 50; i++) lines.push(assistantItem(`step ${i} ${"y".repeat(200)}`));
  const file = writeSession(home, { ts: "2026-11-22T09-00-00", id: "44444444-4444-4444-8444-444444444444", cwd: repo, lines });
  const out = renderTranscript(file, parseArgs(["--max-chars", "2000"]));
  assert.match(out, /# Codex session 44444444/);
  assert.match(out, /- Git branch: main \(abcdef123456\)/);
  assert.match(out, /ORIGINAL REQUEST/);
  assert.match(out, /step 49 /);
  assert.doesNotMatch(out, /step 0 /);
  assert.match(out, /messages omitted/);
});

test("CLI end to end, with errors printed to stdout", () => {
  const { home, repo } = makeHome();
  const run = (...args) =>
    execFileSync(process.execPath, [SCRIPT, ...args], { cwd: repo, env: { ...process.env, CODEX_HOME: home }, encoding: "utf8" });
  assert.match(run("list", ""), /\| 1 \| 2026-11-19 10:00 \|.*Fix the login bug/);
  assert.match(run("show", "この続きをやって"), /### User\n\nFix the login bug/);
  assert.match(run("show", "latest --all"), /Write a README/);
  assert.match(run("show", "7"), /^Error: No session number 7/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "codex-empty-"));
  const out = execFileSync(process.execPath, [SCRIPT, "list"], { env: { ...process.env, CODEX_HOME: empty }, encoding: "utf8" });
  assert.match(out, /does not exist\. Is Codex installed/);
});
