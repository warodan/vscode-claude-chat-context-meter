#!/bin/sh
# Run the patcher with whatever Node-capable runtime this machine has.
#
# There is no install step: if `node` is missing, VS Code's own Electron binary
# is used as Node (ELECTRON_RUN_AS_NODE=1). Anyone patching the Claude Code
# extension necessarily has that editor installed.
#
# Search order: $CCM_NODE -> node on PATH -> cached hint -> remote-server
# Node -> known editor binaries. The winner is cached so the next run is instant.
#
# Usage: sh run.sh --verify   |   sh run.sh   |   sh run.sh --status ...
set -eu

DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SCRIPT="$DIR/patch_claude_code_ui.mjs"
STATE_DIR=${CCM_STATE_DIR:-"$HOME/.claude"}
HINT="$STATE_DIR/vscode-claude-chat-context-meter.runtime"

[ -f "$SCRIPT" ] || { echo "patch_claude_code_ui.mjs not found next to run.sh" >&2; exit 1; }

# A candidate qualifies only if it actually behaves like Node: in Node mode both
# `node` and Electron answer `--version` with `vX.Y.Z`, while a plain editor
# binary prints its own version without the leading `v`.
try_runtime() {
  [ -n "${1:-}" ] || return 1
  out=$(ELECTRON_RUN_AS_NODE=1 "$1" --version 2>/dev/null) || return 1
  case "$out" in
    v[0-9]*) RUNTIME=$1; return 0 ;;
    *) return 1 ;;
  esac
}

RUNTIME=""

# 1. Explicit override, then PATH, then what worked last time.
if [ -n "${CCM_NODE:-}" ] && try_runtime "$CCM_NODE"; then :
elif command -v node >/dev/null 2>&1 && try_runtime "$(command -v node)"; then :
elif [ -f "$HINT" ] && try_runtime "$(head -n 1 "$HINT")"; then :
else
  # 2. Remote/WSL server installs ship a real Node binary.
  for cand in \
    "$HOME"/.vscode-server/bin/*/node \
    "$HOME"/.vscode-server-insiders/bin/*/node \
    "$HOME"/.cursor-server/bin/*/node \
    "$HOME"/.windsurf-server/bin/*/node
  do
    try_runtime "$cand" && break
  done

  # 3. Desktop editors, per platform (Electron in Node mode).
  if [ -z "$RUNTIME" ]; then
    case "$(uname -s 2>/dev/null || echo unknown)" in
      Darwin)
        for cand in \
          "/Applications/Visual Studio Code.app/Contents/MacOS/Electron" \
          "$HOME/Applications/Visual Studio Code.app/Contents/MacOS/Electron" \
          "/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Electron" \
          "/Applications/VSCodium.app/Contents/MacOS/Electron" \
          "/Applications/Cursor.app/Contents/MacOS/Cursor" \
          "/Applications/Cursor.app/Contents/MacOS/Electron" \
          "$HOME/Applications/Cursor.app/Contents/MacOS/Cursor" \
          "/Applications/Windsurf.app/Contents/MacOS/Electron"
        do
          try_runtime "$cand" && break
        done
        ;;
      MINGW*|MSYS*|CYGWIN*)
        for cand in \
          "${LOCALAPPDATA:-$HOME/AppData/Local}/Programs/Microsoft VS Code/Code.exe" \
          "${LOCALAPPDATA:-$HOME/AppData/Local}/Programs/Microsoft VS Code Insiders/Code - Insiders.exe" \
          "${LOCALAPPDATA:-$HOME/AppData/Local}/Programs/cursor/Cursor.exe" \
          "${LOCALAPPDATA:-$HOME/AppData/Local}/Programs/Windsurf/Windsurf.exe" \
          "${LOCALAPPDATA:-$HOME/AppData/Local}/Programs/VSCodium/VSCodium.exe" \
          "/c/Program Files/Microsoft VS Code/Code.exe" \
          "/c/Program Files/Microsoft VS Code Insiders/Code - Insiders.exe" \
          "/c/Program Files (x86)/Microsoft VS Code/Code.exe"
        do
          try_runtime "$cand" && break
        done
        ;;
      *)
        for cand in \
          /usr/share/code/code \
          /usr/share/code-insiders/code-insiders \
          /opt/visual-studio-code/code \
          /snap/code/current/usr/share/code/code \
          /usr/share/codium/codium \
          /usr/share/vscodium/vscodium \
          /opt/cursor/cursor \
          /opt/Cursor/cursor
        do
          try_runtime "$cand" && break
        done
        # Installed somewhere unusual: resolve the `code` launcher script.
        if [ -z "$RUNTIME" ] && command -v code >/dev/null 2>&1; then
          launcher=$(command -v code)
          real=$(readlink -f "$launcher" 2>/dev/null || echo "$launcher")
          base=$(dirname -- "$(dirname -- "$real")")
          for cand in "$base"/code "$base"/codium "$base"/cursor "$base"/*.bin; do
            try_runtime "$cand" && break
          done
        fi
        ;;
    esac
  fi
fi

if [ -z "$RUNTIME" ]; then
  cat >&2 <<'EOF'
No Node-capable runtime found.

Tried: $CCM_NODE, `node` on PATH, the cached runtime, remote-server Node,
and the usual VS Code / VSCodium / Cursor / Windsurf install paths.

Fix: point the script at your editor binary, e.g.
  CCM_NODE="/path/to/Code.exe" sh run.sh --verify
(any Electron-based editor works: it is started with ELECTRON_RUN_AS_NODE=1),
or install Node.js.
EOF
  exit 1
fi

mkdir -p "$STATE_DIR" 2>/dev/null || true
printf '%s\n' "$RUNTIME" > "$HINT" 2>/dev/null || true

export ELECTRON_RUN_AS_NODE=1
exec "$RUNTIME" "$SCRIPT" "$@"
