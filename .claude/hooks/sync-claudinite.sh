#!/bin/bash
# Sync Claudinite into .claudinite/ over plain HTTPS (codeload is allowlisted;
# a submodule clone 403s on cloud). Pulls latest main. On a failed sync it keeps
# any prior copy silently; only when there is NO copy at all (the harness would be
# absent) does it inject a directive telling the assistant to halt and ask.
# Set CLAUDINITE_REF to a tag/SHA to pin instead of tracking main.
set -euo pipefail
REF="${CLAUDINITE_REF:-main}"
URL="https://codeload.github.com/missingbulb/Claudinite/tar.gz/refs/heads/${REF}"
dest="${CLAUDE_PROJECT_DIR:-.}/.claudinite"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
if curl -fsSL --retry 2 --max-time 30 "$URL" -o "$tmp/c.tgz" 2>/dev/null \
   && tar -tzf "$tmp/c.tgz" >/dev/null 2>&1; then
  rm -rf "$dest.new"; mkdir -p "$dest.new"
  tar -xzf "$tmp/c.tgz" -C "$dest.new" --strip-components=1
  [ -f "$dest/.gitkeep" ] && cp "$dest/.gitkeep" "$dest.new/.gitkeep"  # keep the committed signal marker
  rm -rf "$dest"; mv "$dest.new" "$dest"; exit 0
fi
[ -f "$dest/README.md" ] && exit 0   # offline: prior copy present, harness still loads
# No prior copy: the harness is absent and the session would run vanilla. A SessionStart
# hook can't block or prompt on its own, so inject a directive telling the assistant to
# halt and confirm with the user before doing any work. stdout is added to the session
# context; the message is plain text (no double quotes or backslashes) so it embeds in
# the JSON string directly.
printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' \
  "CLAUDINITE NOT LOADED: the sync failed and no local .claudinite/ copy exists, so @.claudinite/CLAUDE.md is unresolved and none of the Claudinite harness (packs, skills, preferences) is active this session. STOP: before running any other tool, answering, or starting the requested task, use the AskUserQuestion tool to ask the user whether to proceed without the harness or pause and retry the sync; do not proceed until they answer."
exit 0
