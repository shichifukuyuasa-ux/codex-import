import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildPrompt,
  codexTurn,
  codexTurns,
  initDebate,
  parseArgs,
  slugify,
} from "../plugins/codex-debate/scripts/debate.mjs";

const SCRIPT = fileURLToPath(new URL("../plugins/codex-debate/scripts/debate.mjs", import.meta.url));

// A stand-in for the Codex CLI: records its arguments and stdin, and writes a
// reply to the --output-last-message file. FAKE_CODEX_MODE changes behaviour.
function makeFakeCodex(dir) {
  const bin = path.join(dir, "fake-codex.mjs");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const out = args[args.indexOf("--output-last-message") + 1];
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  fs.writeFileSync(process.env.FAKE_CODEX_RECORD, JSON.stringify({ args, input }));
  const mode = process.env.FAKE_CODEX_MODE || "reply";
  if (mode === "fail") { console.error("Not logged in. Run codex login."); process.exit(1); }
  if (mode === "agree") fs.writeFileSync(out, "AGREE: 異論はありません。");
  else fs.writeFileSync(out, "反論します。\\nCurrent position: 条件付きで賛成。");
});
`,
  );
  fs.chmodSync(bin, 0o755);
  return bin;
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "debate-test-"));
}

test("parseArgs reads options and keeps the topic words", () => {
  const o = parseArgs(["--rounds", "5", "--model", "gpt-x", "--", "宿曜", "--rounds", "は"]);
  assert.equal(o.rounds, 5);
  assert.equal(o.model, "gpt-x");
  assert.deepEqual(o.rest, ["宿曜", "--rounds", "は"]);
  assert.equal(parseArgs(["--rounds", "99"]).rounds, 10);
  assert.equal(parseArgs([]).rounds, 3);
});

test("slugify keeps Japanese and removes characters Windows forbids", () => {
  assert.equal(slugify("宿曜の運勢: 2027年は? <吉>"), "宿曜の運勢-2027年は-吉");
  assert.equal(slugify("???"), "debate");
});

test("init creates a log under codex-debates with a header", () => {
  const cwd = tmp();
  const file = initDebate("宿曜で来年の運勢をどう読むか", parseArgs(["--rounds", "2"]), cwd);
  assert.equal(path.dirname(file), path.join(cwd, "codex-debates"));
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /^# Debate: 宿曜で来年の運勢をどう読むか/);
  assert.match(text, /Planned rounds: 2/);
  const second = initDebate("宿曜で来年の運勢をどう読むか", parseArgs([]), cwd);
  assert.notEqual(second, file);
  assert.throws(() => initDebate("  ", parseArgs([]), cwd), /Give a topic/);
});

test("the prompt carries the whole log and the debate rules", () => {
  const p = buildPrompt("# Debate: X\n\n## Round 1 — Claude\n\n主張A");
  assert.match(p, /主張A/);
  assert.match(p, /Current position:/);
  assert.match(p, /AGREE:/);
  assert.match(p, /Do not run commands/);
});

test("codexTurn appends numbered Codex sections and detects agreement", async () => {
  const cwd = tmp();
  const file = initDebate("topic", parseArgs([]), cwd);
  fs.appendFileSync(file, "\n## Round 1 — Claude\n\nopening\n");
  const r1 = await codexTurn(file, parseArgs([]), async () => "rebuttal");
  assert.deepEqual(r1, { round: 1, reply: "rebuttal", agreed: false });
  fs.appendFileSync(file, "\n## Round 2 — Claude\n\nreply\n");
  const r2 = await codexTurn(file, parseArgs([]), async () => "AGREE: fine");
  assert.equal(r2.round, 2);
  assert.equal(r2.agreed, true);
  const log = fs.readFileSync(file, "utf8");
  assert.equal(codexTurns(log), 2);
  assert.match(log, /## Round 1 — Codex\n\nrebuttal\n/);
});

test("CLI runs codex exec read-only with the prompt on stdin", () => {
  const cwd = tmp();
  const bin = makeFakeCodex(cwd);
  const record = path.join(cwd, "record.json");
  const env = { ...process.env, CODEX_BIN: bin, FAKE_CODEX_RECORD: record };
  const run = (...args) => execFileSync(process.execPath, [SCRIPT, ...args], { cwd, env, encoding: "utf8" });

  const file = run("init", "--rounds", "2", "--", "宿曜の運勢").trim();
  fs.appendFileSync(file, "\n## Round 1 — Claude\n\n来年は吉。\n");
  const out = run("codex", file, "--model", "gpt-x");
  assert.match(out, /^\[Round 1 — Codex\]/);
  assert.match(out, /Current position: 条件付きで賛成/);

  const { args, input } = JSON.parse(fs.readFileSync(record, "utf8"));
  assert.deepEqual(args.slice(0, 4), ["exec", "--sandbox", "read-only", "--skip-git-repo-check"]);
  assert.ok(args.includes("--ephemeral"));
  assert.deepEqual(args.slice(-3), ["--model", "gpt-x", "-"]);
  assert.match(input, /来年は吉。/);
  assert.match(fs.readFileSync(file, "utf8"), /## Round 1 — Codex\n\n反論します。/);

  const agreed = execFileSync(process.execPath, [SCRIPT, "codex", file], {
    cwd,
    env: { ...env, FAKE_CODEX_MODE: "agree" },
    encoding: "utf8",
  });
  assert.match(agreed, /^\[Round 2 — Codex — agreed\]/);
});

test("CLI reports a Codex failure and a missing codex command", () => {
  const cwd = tmp();
  const bin = makeFakeCodex(cwd);
  const env = { ...process.env, CODEX_BIN: bin, FAKE_CODEX_RECORD: path.join(cwd, "r.json") };
  const file = execFileSync(process.execPath, [SCRIPT, "init", "x"], { cwd, env, encoding: "utf8" }).trim();
  const before = fs.readFileSync(file, "utf8");

  const run = (extraEnv) => {
    try {
      execFileSync(process.execPath, [SCRIPT, "codex", file], { cwd, env: { ...env, ...extraEnv }, encoding: "utf8" });
      return "";
    } catch (e) {
      return e.stdout;
    }
  };
  assert.match(run({ FAKE_CODEX_MODE: "fail" }), /^Error: Codex exited with code 1 and no reply\.\nNot logged in/);
  assert.match(run({ CODEX_BIN: path.join(cwd, "no-such-codex") }), /`codex` command was not found/);
  assert.equal(fs.readFileSync(file, "utf8"), before, "a failed turn must not change the log");
});
