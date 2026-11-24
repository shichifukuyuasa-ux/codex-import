---
description: Debate a question with Codex over several rounds, then write a conclusion
argument-hint: "[--rounds N] [--model M] <topic or question>"
disable-model-invocation: true
allowed-tools: Bash(node:*), Read, Edit, Write
---

Run a written debate between you (Claude) and Codex on the user's topic, then reach a conclusion.

User's request: `$ARGUMENTS`

`--rounds N` (default 3, at most 10) and `--model M` (a Codex model) are options; the rest is the topic. Use the language the user wrote the topic in for everything you write.

## Steps

1. **Start the log.** Run:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/debate.mjs" init --rounds <N> -- <topic>`
   It prints the path of a new Markdown file under `codex-debates/` in the current directory. If it prints `Error:`, tell the user and stop.

2. **For each round k = 1 … N:**
   a. Append your section to the log with Edit or Write, headed exactly `## Round k — Claude`.
      - Round 1: frame the question (what exactly is being decided, and how you will judge it), then give your opening position with reasons.
      - Later rounds: answer Codex's latest points one by one. Concede where Codex is right; push back with reasons where it is not. Then state your current position.
      - Keep each section under about 500 words. Argue honestly: you are trying to reach the best answer, not to win.
   b. Run, with a Bash timeout of 600000 ms:
      `node "${CLAUDE_PLUGIN_ROOT}/scripts/debate.mjs" codex "<log path>"` (add `--model M` if given)
      The script sends the whole log to Codex in a read-only sandbox, appends Codex's reply as `## Round k — Codex`, and prints it.
   c. Show the user a two- or three-line summary of the round (your point, Codex's answer). Do not paste the whole text.
   d. If the output says `agreed`, or both sides now hold the same position, stop early.
   If the script prints `Error:` (Codex not installed, not logged in, timed out), tell the user what it said and how to fix it (`npm install -g @openai/codex`, `codex login`), and stop. Do not invent Codex's side.

3. **Conclude.** Append a section headed `## Conclusion` to the log, containing:
   - The conclusion, in one or two sentences.
   - Points both sides agreed on.
   - Points still disputed, and why.
   - What changed during the debate (who moved, and on what).
   - How confident the conclusion is, and what would change it.
   If the topic is a belief system or tradition such as astrology or fortune-telling, give the conclusion within that tradition's own framework, and say briefly what kind of claim it is.

4. **Report** the conclusion to the user, followed by the log file's path.
