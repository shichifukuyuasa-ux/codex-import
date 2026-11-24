#!/usr/bin/env node
// Run a written debate between Claude and Codex.
//
//   debate.mjs init [--rounds N] [--dir DIR] <topic...>
//       Create a debate log (Markdown) and print its path.
//   debate.mjs codex <log-file> [--model M] [--timeout-sec S]
//       Send the whole log to Codex (`codex exec`, read-only sandbox), append
//       Codex's reply to the log as the next section, and print the reply.
//
// Claude writes its own turns and the conclusion into the log directly.
// Set CODEX_BIN to use a different Codex executable.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_ROUNDS = 3;
const DEFAULT_TIMEOUT_SEC = 540;

export function parseArgs(argv) {
  const opts = { rounds: DEFAULT_ROUNDS, dir: "codex-debates", model: null, timeoutSec: DEFAULT_TIMEOUT_SEC, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rounds") opts.rounds = Math.max(1, Math.min(10, Number(argv[++i]) || DEFAULT_ROUNDS));
    else if (a === "--dir") opts.dir = argv[++i];
    else if (a === "--model") opts.model = argv[++i];
    else if (a === "--timeout-sec") opts.timeoutSec = Number(argv[++i]) || DEFAULT_TIMEOUT_SEC;
    else if (a === "--") opts.rest.push(...argv.slice(i + 1)), (i = argv.length);
    else opts.rest.push(a);
  }
  return opts;
}

export function slugify(topic) {
  const s = topic
    .replace(/[\\/:*?"<>|\s]+/g, "-") // characters Windows forbids, and spaces
    .replace(/[^\p{L}\p{N}-]+/gu, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return s.slice(0, 40) || "debate";
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function initDebate(topic, opts, cwd = process.cwd()) {
  if (!topic.trim()) throw new Error("Give a topic, e.g. init 宿曜で来年の運勢をどう読むか");
  const dir = path.resolve(cwd, opts.dir);
  fs.mkdirSync(dir, { recursive: true });
  let file = path.join(dir, `${stamp()}-${slugify(topic)}.md`);
  for (let n = 2; fs.existsSync(file); n++) file = file.replace(/(-\d+)?\.md$/, `-${n}.md`);
  const body = [
    `# Debate: ${topic.trim()}`,
    "",
    `- Participants: Claude (Anthropic), Codex (OpenAI)`,
    `- Planned rounds: ${opts.rounds}`,
    `- Started: ${new Date().toISOString()}`,
    "",
  ].join("\n");
  fs.writeFileSync(file, body + "\n");
  return file;
}

// Count "## Round N — Codex" sections already in the log.
export function codexTurns(log) {
  return (log.match(/^## Round \d+ — Codex\s*$/gm) || []).length;
}

export function buildPrompt(log) {
  return [
    "You are Codex, taking part in a written debate with Claude (another AI assistant).",
    "The full debate log so far is below. Your job in this turn:",
    "",
    "1. Respond directly to Claude's most recent section: say what you agree with, and challenge weak reasoning, missing perspectives or unsupported claims.",
    "2. Add your own arguments or evidence that move the discussion forward. Do not just repeat earlier points.",
    "3. End with a line starting `Current position:` that states your view in one or two sentences.",
    "",
    "Rules:",
    "- Write in the same language as the debate topic and Claude's sections.",
    "- Keep it under about 500 words.",
    "- If you now fully agree with Claude and have nothing to add, begin your reply with `AGREE:`.",
    "- This is a discussion only. Do not run commands, read files or change anything.",
    "- If the topic is a belief system or tradition (for example astrology or fortune-telling), argue about how it is interpreted within that tradition, and be honest about what it can and cannot claim.",
    "",
    "----- DEBATE LOG -----",
    log.trim(),
    "----- END OF LOG -----",
  ].join("\n");
}

function quoteForCmd(a) {
  return /[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a;
}

export function runCodex(prompt, opts) {
  const bin = process.env.CODEX_BIN || "codex";
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codex-debate-")), "reply.md");
  const args = ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "--ephemeral", "--color", "never", "--output-last-message", outFile];
  if (opts.model) args.push("--model", opts.model);
  args.push("-");

  // npm installs codex as codex.cmd on Windows, which needs a shell to run.
  const win = process.platform === "win32";
  const child = spawn(win ? quoteForCmd(bin) : bin, win ? args.map(quoteForCmd) : args, {
    shell: win,
    stdio: ["pipe", "pipe", "pipe"],
  });

  return new Promise((resolve, reject) => {
    let stderr = "";
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Codex did not answer within ${opts.timeoutSec} seconds.`));
    }, opts.timeoutSec * 1000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        err.code === "ENOENT"
          ? new Error("The `codex` command was not found. Install it with `npm install -g @openai/codex`, then run `codex login`.")
          : err,
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let reply = "";
      try {
        reply = fs.readFileSync(outFile, "utf8").trim();
      } catch {}
      if (code !== 0 || !reply) {
        const detail = (stderr || stdout).trim().split("\n").slice(-15).join("\n");
        reject(new Error(`Codex exited with code ${code} and no reply.${detail ? `\n${detail}` : ""}`));
        return;
      }
      resolve(reply);
    });
    child.stdin.end(prompt);
  });
}

export async function codexTurn(file, opts, run = runCodex) {
  const log = fs.readFileSync(file, "utf8");
  const round = codexTurns(log) + 1;
  const reply = await run(buildPrompt(log), opts);
  fs.appendFileSync(file, `\n## Round ${round} — Codex\n\n${reply}\n`);
  return { round, reply, agreed: /^\s*AGREE:/i.test(reply) };
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const opts = parseArgs(rest);
  if (cmd === "init") {
    console.log(initDebate(opts.rest.join(" "), opts));
    return;
  }
  if (cmd === "codex") {
    const file = opts.rest[0];
    if (!file || !fs.existsSync(file)) throw new Error(`Debate log not found: ${file ?? "(none given)"}`);
    const { round, reply, agreed } = await codexTurn(file, opts);
    console.log(`[Round ${round} — Codex${agreed ? " — agreed" : ""}]\n\n${reply}`);
    return;
  }
  console.log("Usage: debate.mjs init [--rounds N] <topic> | debate.mjs codex <log-file>");
}

if (process.argv[1]?.endsWith("debate.mjs")) {
  main(process.argv.slice(2)).catch((err) => {
    console.log(`Error: ${err.message}`);
    process.exitCode = 1;
  });
}
