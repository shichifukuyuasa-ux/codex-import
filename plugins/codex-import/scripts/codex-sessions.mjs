#!/usr/bin/env node
// Read Codex CLI session files (~/.codex/sessions/**/rollout-*.jsonl) and
// print them in a form Claude Code can read.
//
//   codex-sessions.mjs list [--all] [--archived] [--limit N]
//   codex-sessions.mjs show <latest|N|session-id|path> [--all] [--archived]
//                           [--tools] [--max-chars N]
//
// Arguments may also arrive as one quoted string (as slash commands pass
// "$ARGUMENTS"); it is split on whitespace. Unknown words after the session
// reference are ignored, so "show latest continue the fix" works.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HEAD_BYTES = 1024 * 1024;
const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_CHARS = 60000;
const TOOL_SNIPPET = 400;

// User-role messages Codex injects itself rather than typed by the person.
const INJECTED_PREFIXES = [
  "<environment_context>",
  "<user_instructions>",
  "<permissions instructions>",
  "<user_shell_command>",
  "<turn_aborted>",
  "# AGENTS.md instructions",
];

export function codexHome(env = process.env) {
  return env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), ".codex");
}

export function parseArgs(argv) {
  const words = argv.flatMap((a) => String(a).trim().split(/\s+/)).filter(Boolean);
  const opts = { all: false, archived: false, tools: false, limit: DEFAULT_LIMIT, maxChars: DEFAULT_MAX_CHARS, rest: [] };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "--all") opts.all = true;
    else if (w === "--archived") opts.archived = true;
    else if (w === "--tools") opts.tools = true;
    else if (w === "--limit") opts.limit = Number(words[++i]) || DEFAULT_LIMIT;
    else if (w === "--max-chars") opts.maxChars = Number(words[++i]) || DEFAULT_MAX_CHARS;
    else opts.rest.push(w);
  }
  return opts;
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) out.push(p);
  }
  return out;
}

export function findSessionFiles(home, { archived = false } = {}) {
  const files = walk(path.join(home, "sessions"), []);
  if (archived) walk(path.join(home, "archived_sessions"), files);
  // File names start with the creation time (rollout-YYYY-MM-DDThh-mm-ss-<id>),
  // so sorting by name is newest-first when reversed.
  return files.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));
}

function readLines(file, maxBytes) {
  let text;
  if (maxBytes) {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const n = fs.readSync(fd, buf, 0, maxBytes, 0);
      text = buf.subarray(0, n).toString("utf8");
      if (n === maxBytes) text = text.slice(0, text.lastIndexOf("\n") + 1);
    } finally {
      fs.closeSync(fd);
    }
  } else {
    text = fs.readFileSync(file, "utf8");
  }
  const records = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // Skip a damaged line rather than failing the whole session.
    }
  }
  return records;
}

// Normalise both the current format ({timestamp, type, payload}) and the
// older one (a bare meta object first, then bare response items).
function normalise(records) {
  return records.map((r, i) => {
    if (r && typeof r === "object" && "type" in r && "payload" in r) return r;
    if (i === 0 && r && r.id && !r.type) return { type: "session_meta", payload: r, timestamp: r.timestamp };
    if (r && r.record_type) return { type: "state", payload: r };
    return { type: "response_item", payload: r, timestamp: r?.timestamp };
  });
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      if (!c) return "";
      if (typeof c.text === "string") return c.text;
      if (c.type === "input_image" || c.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function isInjected(text) {
  const t = text.trimStart();
  return INJECTED_PREFIXES.some((p) => t.startsWith(p));
}

function snippet(value, n = TOOL_SNIPPET) {
  let s = typeof value === "string" ? value : JSON.stringify(value);
  if (s === undefined || s === null) return "";
  // Tool outputs are often JSON strings wrapping {output: "..."}.
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed.output === "string") s = parsed.output;
  } catch {}
  s = s.trim();
  return s.length > n ? `${s.slice(0, n)}… (${s.length - n} more chars)` : s;
}

// Turn the records into an ordered list of {role, text} messages.
export function extractMessages(records, { tools = false } = {}) {
  const items = normalise(records);
  const fromItems = [];
  const fromEvents = [];

  for (const { type, payload: p } of items) {
    if (!p) continue;
    if (type === "response_item") {
      if (p.type === "message") {
        if (p.role !== "user" && p.role !== "assistant") continue;
        const text = contentText(p.content).trim();
        if (!text || (p.role === "user" && isInjected(text))) continue;
        fromItems.push({ role: p.role, text });
      } else if (tools && (p.type === "function_call" || p.type === "custom_tool_call")) {
        fromItems.push({ role: "tool", text: `call ${p.name}: ${snippet(p.arguments ?? p.input)}` });
      } else if (tools && p.type === "local_shell_call") {
        const cmd = p.action?.command;
        fromItems.push({ role: "tool", text: `shell: ${Array.isArray(cmd) ? cmd.join(" ") : snippet(cmd)}` });
      } else if (tools && (p.type === "function_call_output" || p.type === "custom_tool_call_output")) {
        fromItems.push({ role: "tool", text: `output: ${snippet(p.output)}` });
      }
    } else if (type === "compacted" && p.message) {
      fromItems.push({ role: "summary", text: String(p.message).trim() });
    } else if (type === "event_msg") {
      if (p.type === "user_message" && p.message && !isInjected(p.message)) {
        fromEvents.push({ role: "user", text: String(p.message).trim() });
      } else if (p.type === "agent_message" && p.message) {
        fromEvents.push({ role: "assistant", text: String(p.message).trim() });
      }
    }
  }
  // Codex writes each turn both as a response item and as an event; prefer
  // the items and fall back to events only when a file has no items.
  const hasItemMessages = fromItems.some((m) => m.role === "user" || m.role === "assistant");
  return hasItemMessages ? fromItems : fromEvents;
}

function metaOf(records) {
  const first = normalise(records.slice(0, 1))[0];
  return first?.type === "session_meta" ? first.payload : {};
}

export function summarise(file, { headBytes = HEAD_BYTES } = {}) {
  const records = readLines(file, headBytes);
  const meta = metaOf(records);
  const firstUser = extractMessages(records).find((m) => m.role === "user");
  const idFromName = path.basename(file).match(/([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i)?.[1];
  return {
    file,
    id: meta.id || idFromName || "",
    timestamp: meta.timestamp || "",
    cwd: meta.cwd || "",
    preview: firstUser ? firstUser.text.replace(/\s+/g, " ").slice(0, 80) : "",
  };
}

function inside(child, parent) {
  if (!child || !parent) return false;
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function listSessions(home, opts, cwd = process.cwd()) {
  const out = [];
  for (const file of findSessionFiles(home, opts)) {
    const s = summarise(file);
    if (!opts.all && !inside(s.cwd, cwd) && !inside(cwd, s.cwd)) continue;
    out.push(s);
  }
  return out;
}

export function resolveSession(home, ref, opts, cwd = process.cwd()) {
  if (!ref || ref === "latest") {
    const s = listSessions(home, opts, cwd)[0];
    if (!s) throw new Error(noSessionsMessage(home, opts));
    return s.file;
  }
  // Short numbers are positions in the list; longer digit runs are ID prefixes.
  if (/^\d{1,4}$/.test(ref)) {
    const list = listSessions(home, opts, cwd);
    const s = list[Number(ref) - 1];
    if (!s) throw new Error(`No session number ${ref}; the list has ${list.length}.`);
    return s.file;
  }
  if (ref.endsWith(".jsonl") && fs.existsSync(ref)) return path.resolve(ref);
  const matches = findSessionFiles(home, { archived: true }).filter((f) =>
    path.basename(f).toLowerCase().includes(ref.toLowerCase()),
  );
  if (matches.length === 0) throw new Error(`No Codex session matches "${ref}".`);
  if (matches.length > 1) throw new Error(`"${ref}" matches ${matches.length} sessions; use more of the ID.`);
  return matches[0];
}

function noSessionsMessage(home, opts) {
  const where = path.join(home, "sessions");
  if (!fs.existsSync(where)) return `No Codex sessions found: ${where} does not exist. Is Codex installed on this machine?`;
  return opts.all
    ? `No Codex sessions found in ${where}.`
    : `No Codex sessions for this directory. Add --all to list sessions from every directory.`;
}

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toISOString().slice(0, 16).replace("T", " ");
}

export function renderList(sessions, opts) {
  if (sessions.length === 0) return "";
  const rows = sessions.slice(0, opts.limit).map((s, i) => {
    const cell = (v) => String(v).replace(/\|/g, "\\|");
    return `| ${i + 1} | ${fmtTime(s.timestamp)} | ${cell(s.cwd)} | ${cell(s.preview)} | ${s.id} |`;
  });
  const more = sessions.length > opts.limit ? `\n\n(${sessions.length - opts.limit} older sessions not shown; use --limit)` : "";
  return ["| # | Started (UTC) | Directory | First message | Session ID |", "|---|---|---|---|---|", ...rows].join("\n") + more;
}

export function renderTranscript(file, opts) {
  const records = readLines(file);
  const meta = metaOf(records);
  let messages = extractMessages(records, opts);

  const label = { user: "User", assistant: "Codex", tool: "Tool", summary: "Earlier history (summarised by Codex)" };
  const block = (m) => `### ${label[m.role]}\n\n${m.text}\n`;

  // Keep within budget: always keep the first user message (the original
  // request), then as many of the most recent messages as fit.
  let omitted = 0;
  const total = messages.reduce((n, m) => n + m.text.length, 0);
  if (total > opts.maxChars && messages.length > 2) {
    const firstIdx = messages.findIndex((m) => m.role === "user");
    const head = firstIdx >= 0 ? [messages[firstIdx]] : [];
    let budget = opts.maxChars - (head[0]?.text.length ?? 0);
    const tail = [];
    for (let i = messages.length - 1; i > firstIdx; i--) {
      const len = messages[i].text.length;
      if (budget - len < 0 && tail.length > 0) break;
      budget -= len;
      tail.unshift(messages[i]);
    }
    omitted = messages.length - head.length - tail.length;
    messages = [...head, ...(omitted ? [{ role: "omitted" }] : []), ...tail];
  }

  const header = [
    `# Codex session ${meta.id || path.basename(file)}`,
    "",
    meta.timestamp ? `- Started: ${fmtTime(meta.timestamp)} UTC` : null,
    meta.cwd ? `- Directory: ${meta.cwd}` : null,
    meta.git?.branch ? `- Git branch: ${meta.git.branch}${meta.git.commit_hash ? ` (${String(meta.git.commit_hash).slice(0, 12)})` : ""}` : null,
    meta.cli_version ? `- Codex version: ${meta.cli_version}` : null,
    `- File: ${file}`,
    "",
  ].filter((l) => l !== null);

  const body = messages.map((m) =>
    m.role === "omitted" ? `_[… ${omitted} messages omitted to fit --max-chars ${opts.maxChars} …]_\n` : block(m),
  );
  if (body.length === 0) body.push("_(No user or assistant messages found in this session.)_");
  return [...header, ...body].join("\n");
}

// The first word is a session reference only if it looks like one; otherwise
// it is the start of the user's instruction and we load the latest session.
export function pickRef(word) {
  if (!word) return undefined;
  if (word === "latest" || /^\d{1,4}$/.test(word) || word.endsWith(".jsonl")) return word;
  if (/^[0-9a-f][0-9a-f-]{5,}$/i.test(word)) return word;
  return undefined;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const opts = parseArgs(rest);
  const home = codexHome();
  if (cmd === "list") {
    const sessions = listSessions(home, opts);
    if (sessions.length === 0) {
      console.log(noSessionsMessage(home, opts));
      return 0;
    }
    console.log(renderList(sessions, opts));
    return 0;
  }
  if (cmd === "show") {
    const file = resolveSession(home, pickRef(opts.rest[0]), opts);
    console.log(renderTranscript(file, opts));
    return 0;
  }
  console.error("Usage: codex-sessions.mjs list|show [options]");
  return 2;
}

if (process.argv[1]?.endsWith("codex-sessions.mjs")) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    // Print to stdout and exit 0 so a slash command shows the message to
    // Claude instead of failing silently.
    console.log(`Error: ${err.message}`);
  }
}
