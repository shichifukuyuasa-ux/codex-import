---
description: List your recent Codex CLI sessions for this directory (or all with --all)
argument-hint: "[--all] [--archived] [--limit N]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-sessions.mjs" list "$ARGUMENTS"`

Show the output above to the user as it is: the table of Codex sessions, or the message if there are none.
Then, in the user's language, tell them they can load one with `/codex-import:load <#>` (the number in the first column) or `/codex-import:load <session-id>`, optionally followed by what they want done with it.
Do not read or summarise any session yet.
