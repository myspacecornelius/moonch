#!/bin/zsh
# User-invoked launcher. Starts the local companion (backend/server.cjs) and opens it in the browser.
# It never starts a model run: agent runs begin only from the Agents page, after you approve a round there.
set -e
cd -- "${0:A:h}"

# Node: Homebrew, the installer location, whatever is on PATH, then the runtime inside the archived
# DeepSeek Harness app as the last candidate.
studio_node=''
path_node="$(command -v node 2>/dev/null || true)"
for candidate in /opt/homebrew/bin/node /usr/local/bin/node "$path_node" '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node'; do
  if [[ -n "$candidate" && -f "$candidate" && -x "$candidate" ]]; then
    studio_node="$candidate"
    break
  fi
done

if [[ -z "$studio_node" ]]; then
  printf '%s\n' 'No local Node runtime was found. The local agents edition needs Node 22 or newer.'
  printf '%s\n' 'Open Finance_Task_Studio.html directly for the offline edition; it requires no installation.'
  read -r 'reply?Press Return to close.'
  exit 1
fi

studio_node_version="$("$studio_node" --version 2>/dev/null || true)"
studio_node_major="$("$studio_node" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
printf 'Node:   %s (%s)\n' "$studio_node" "${studio_node_version:-version unknown}"
case "$studio_node_major" in
  ''|*[!0-9]*) ;;
  *)
    if [ "$studio_node_major" -lt 22 ]; then
      printf '%s\n' 'Warning: Node 22 or newer is required. Continuing; if the companion does not start, update Node.'
    fi
    ;;
esac

# Runtime check, in the order the Agents page uses: CLAUDE_BIN, claude on PATH, then known locations.
# This only asks for the version. No prompt is sent and no model starts.
if [[ -n "${CLAUDE_BIN:-}" ]] && ! [[ -f "$CLAUDE_BIN" && -x "$CLAUDE_BIN" ]]; then
  printf '%s\n' 'Note:   CLAUDE_BIN is set but is not an executable file; it is ignored.'
fi
studio_claude=''
path_claude="$(command -v claude 2>/dev/null || true)"
for candidate in "${CLAUDE_BIN:-}" "$path_claude" /opt/homebrew/bin/claude /usr/local/bin/claude "$HOME/.claude/local/claude" "$HOME/.local/bin/claude"; do
  if [[ -n "$candidate" && -f "$candidate" && -x "$candidate" ]]; then
    studio_claude="$candidate"
    break
  fi
done
if [[ -n "$studio_claude" ]]; then
  studio_claude_version="$("$studio_claude" --version </dev/null 2>/dev/null | head -n 1 || true)"
  if [[ -n "$studio_claude_version" ]]; then
    printf 'Claude: found at %s (%s). Local agents are available from the Agents page.\n' "$studio_claude" "$studio_claude_version"
  else
    printf 'Claude: found at %s, but claude --version printed nothing. Run it in a terminal to check it is installed and signed in.\n' "$studio_claude"
  fi
else
  printf '%s\n' 'Claude: not found. The Agents page will report this too. To use local agents, install the claude CLI'
  printf '%s\n' '        and sign in (run claude once in a terminal), or set CLAUDE_BIN to its path. Everything else works without it.'
fi
printf '%s\n' 'Starting the companion on 127.0.0.1. Nothing runs a model until you approve a round on the Agents page.'

exec "$studio_node" backend/server.cjs --open
