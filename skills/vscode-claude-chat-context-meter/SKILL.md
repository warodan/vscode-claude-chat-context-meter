---
name: vscode-claude-chat-context-meter
description: >-
  Live context meter and custom buttons in the Claude Code chat composer in VS
  Code and its forks: "how much context is left", "show the token count in the
  chat", "the context ring is gone after the update", "bring the button back",
  "add a button to the composer", "add a button that runs /usage", "move the
  button to the right", "make the button survive extension updates", "check
  whether the patch is still safe on this version", "undo the patch". Russian:
  «сколько контекста осталось», «верни кнопку контекста», «индикатор контекста
  пропал после обновления», «добавь кнопку в чат», «кнопку для /usage», «перенеси
  кнопку правее», «чтобы кнопка не пропадала после обновлений», «проверь,
  безопасно ли патчить эту версию», «откати патч». The extension has no chat-UI
  extension point, so the button is injected into its webview bundle; every
  extension update wipes the patch and one command puts it back.
compatibility: >-
  The Claude Code extension in VS Code or a fork (Insiders, Cursor, Windsurf,
  VSCodium, remote/WSL). Nothing to install: Node from PATH if present,
  otherwise the editor's own runtime.
---

# Context meter button in the Claude Code chat composer (VS Code)

**Scope: the Claude Code extension in VS Code.** This skill patches that
extension's webview bundle. Outside VS Code (or a fork of it) there is nothing to
patch and the skill does nothing useful — it is not a general agent tool.

**Nothing to install.** The patcher is a single dependency-free JavaScript file
(`patch_claude_code_ui.mjs`). It finds Node on its own: `node` from PATH, and if
that is missing, the Node runtime built into VS Code itself
(`ELECTRON_RUN_AS_NODE=1`). Anyone patching a VS Code extension has that editor
by definition, so the fallback always exists. `run.sh` / `run.ps1` do the lookup.

Details of the patch itself — the edits, the safeguards, the ring, where the
reading comes from — are in `references/internals.md`. Read that when you have to
change the patcher, not to run it.

## Protocol (mandatory, do not reorder)

You are patching **someone's installed extension** that they use every day.
Breaking it breaks their daily driver, so the steps are exactly these:

**1. Preflight — always first, writes nothing but a path cache:**

```bash
for d in "${CLAUDE_SKILL_DIR}" ~/.claude/skills/vscode-claude-chat-context-meter \
         ~/.agents/skills/vscode-claude-chat-context-meter \
         ./.claude/skills/vscode-claude-chat-context-meter \
         ./.agents/skills/vscode-claude-chat-context-meter; do
  [ -n "$d" ] && [ -f "$d/run.sh" ] && { sh "$d/run.sh" --verify; break; }
done
```

No `sh` on the machine (Windows without Git Bash)? Same step, PowerShell form.
`run.ps1` sits next to `run.sh`, so the folder is one of the same five candidates
listed above — take the one that exists and keep the quotes, paths have spaces:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.claude\skills\vscode-claude-chat-context-meter\run.ps1" --verify
```

Every later step works the same way: swap `sh …/run.sh` for this line and keep
the flags as they are.

It checks the extension version (and whether it was patched before — see the
`verified-versions.json` ledger), that the backup is clean, that the whole
toolbar structure is where it should be, and it **builds a trial patch and
parses it**. The answer is either `SAFE TO PATCH` or `UNSAFE: <what did not match>`.

**2. `SAFE TO PATCH` → apply:** the same command without `--verify`.

**3. `UNSAFE` / `ABORTED` → do NOT patch blindly and do NOT hand-edit the bundle.**
In that order:

1. **Tell the user in one line** that the toolbar was rewritten in the new
   extension build and that you are working it out — do not go silent until you
   have a result, and do not ask for permission first.
2. **Work it out yourself** using `references/layout-recovery.md`: find the new
   anchor, the new insertion points, and confirm the command registry is still there.
3. **Fix the skill's own files** (the anchor and regexes in the `Layout` class,
   the edit table in `references/internals.md`) so the patch works again, and
   **say what you changed**. Treat that edit as local and temporary: the skill
   folder may be a git clone or managed by an installer, so the next update can
   overwrite it. Offer to send the fix upstream as an issue or a pull request —
   a re-taught anchor is exactly what every other user needs too.
4. Go back to step 1, apply, and report what changed in the extension and in the skill.

Only escalate to the user if the structure fundamentally rules out the old
behaviour (the command registry is gone, there is nowhere to put a button) — then
explain what is possible instead. Never leave a broken bundle behind: while it is
broken, **the Claude Code chat does not open at all**.

**4. Tell the user:** Ctrl+Shift+P → **Developer: Reload Window**, and ask them to
confirm the button is there and works (you cannot click it for them).

If anything goes wrong at any step, `--revert` restores the original from the
backup. Last resort with no backup: reinstall the extension in VS Code
(Extensions → Claude Code → Uninstall → Install); settings and sessions survive that.

## How to run it

The commands below assume the skill folder. `CLAUDE_SKILL_DIR` is not an environment
variable — Claude Code substitutes the real skill directory into this file as it loads
it, so the first candidate points at wherever the skill was actually installed. An agent
that does not substitute it leaves it empty, `[ -n "$d" ]` skips that candidate, and the
standard install locations are tried instead: `~/.claude/skills/…` and `~/.agents/skills/…`
for a global install, the same two under `./` for a project-level one.

| Environment | Command |
|---|---|
| Git Bash / macOS / Linux (recommended) | `sh run.sh --verify` from the skill folder |
| PowerShell (Windows without Git Bash) | `powershell -NoProfile -ExecutionPolicy Bypass -File run.ps1 --verify` |
| When `node` is definitely on PATH | `node patch_claude_code_ui.mjs --verify` |

Both runners look for Node in this order: `$CCM_NODE` → `node` on PATH → the path
cached from the last run → the editor binary (VS Code, Insiders, VSCodium, Cursor,
Windsurf — standard Windows / macOS / Linux locations, including snap and the `code`
launcher script). `run.sh` also checks the Node shipped with remote/WSL servers
(`~/.vscode-server/bin/*/node`), which `run.ps1` has no reason to.
A candidate is accepted only if it really answers as Node. If nothing is found,
the error tells you to set `CCM_NODE=/path/to/Code.exe`. On macOS/Linux, when
running by hand: `chmod +x run.sh` (or just `sh run.sh`).

## What the patch does

The **context** button sits third in the composer (`+` → `/` → **context**), reads
`◔ 184k`, and clicking it runs `/context` straight away. Both halves are live and
move while Claude is still working; the stock counter is switched off so the two
cannot double up, which also means clicking no longer compacts.

The colour is a prompt to the user, never an action: green while there is room,
the clay orange once the session is long enough that compacting or handing over to
a fresh chat is the better move (256k tokens, or 60 % of the window). Nothing in
this skill compacts, clears or restarts anything on its own — if you are asked to
"do something about the context", that is a separate decision to raise with the
user, not something the button did.

If the usage signal cannot be located in a build, the button degrades — ring →
text-only → plain `run` button — rather than failing. `--verify` says which of the
three you are getting.

Everything else about the reading — the denominator, the colours, the ring
geometry, how the window size is recovered on a fresh session, the startup race —
is in `references/internals.md`. Read it before changing any of that; the answers
there are the result of attempts that failed first.

## Commands

After `run.sh` / `run.ps1` / the script name:

```bash
… --status                          # what is installed, what is patched, is the anchor intact
… --where                           # which Node was used, where extensions and bundles were found
… --ensure                          # quiet self-heal; what the SessionStart hook runs
… --install-hook                    # wire that hook up (see "Surviving updates")
… --uninstall-hook                  # take it out again
… --revert                          # restore the original
… --reapply                         # revert, then patch again from the clean original
                                    #   (also how you CHANGE an existing button's mode)
… --dry-run                         # build and validate, write nothing (also neuters --revert/--reapply
                                    #   and the hook commands; with --reapply it rehearses the patch
                                    #   against the pristine original)
… --side right                      # a different slot (see below)
… --button context:/context --button usage:/usage      # custom set (replaces the default)
… --button ctx:/context:insert      # insert mode: only type the text, do not run
… --ext-dir <path>                  # extra extensions directory (or env CCM_EXT_DIR)
… --forget                          # drop this machine's cached paths
```

`--side` slots: `slash` (default — third, right after the `/` button), `left`
(before `+`), `right` (in the right-hand group after the spacer, next to the model picker).

`ID:/text[:mode]` — `ID` becomes both the button label and the idempotency marker.
Modes: `usage` (run + ring + live count — the default for the built-in context
button), `run` (execute the command; the default for a hand-written `--button`)
and `insert` (only type the text). `usage` reports the **context window**, so it
only makes sense on a `/context` button — that is why it is not the parse default.
A button that already exists is left alone by id, so **changing its mode needs
`--reapply`**, not a second run.

**Every Claude Code install found gets the same treatment** — the run is per bundle,
not per editor. `--ext-dir` *adds* a directory to the search, it does not replace
the defaults, so a run aimed at some copy elsewhere also patches the ordinary
install. Pair it with `--dry-run` when experimenting.

## Surviving extension updates (`--install-hook`)

Every Claude Code update installs into a fresh directory and takes the patch with
it — and updates land every day or two. `--install-hook` writes a **SessionStart
hook** into `~/.claude/settings.json` that runs `--ensure` in the background, so
the button comes back on its own.

**Install it only when the user asks for it** — it is a write into their
`settings.json`. Mention that `--uninstall-hook` removes exactly our entry, and
that the file is copied to `settings.json.ccm.bak` before the first write.

`--ensure` is built to cost nothing on the boring path: a fingerprint cache makes
"nothing changed" a couple of `stat` calls (~80 ms, all of it Node startup, and it
prints nothing); only a bundle whose fingerprint moved is reopened and re-patched;
a lock file keeps two editor windows starting at once from writing one bundle; and
it never exits non-zero, because a hook that fails loudly every morning would be
worse than the problem it solves.

**What it cannot do:** the webview is already loaded by the time a session starts,
so a freshly restored button appears **at the next window reload**. In practice the
update itself asks for a reload, and the hook usually gets there first.

## Where things live

`--where` prints the lot: the runtime in use, the extension roots searched and every
bundle found. The patched file is `webview/index.js` inside the extension, its backup
is `index.js.orig` beside it, and everything this machine keeps (path cache, its own
ledger entries, the lock) lives in `~/.claude/` — never in the skill folder, which may
be a git clone. `--forget` drops the cache; it never decides *which* bundle to patch,
so a stale entry cannot survive an extension update. Details in
`references/internals.md`.

## Limits

- The button lives inside the webview: it can only reach what the bundle already
  has (registry commands, text insertion, mode switching). **It cannot invoke an
  arbitrary VS Code command** — that would require patching `extension.js` (the
  webview↔host bridge) as well, which is far more brittle and is not supported here.
- The patch does not survive an extension update (a fresh version directory is
  created) — that is normal. Claude Code updates every day or two, which is what
  `--install-hook` is for; without it, just run the protocol again.
- The live reading is only as good as what the CLI has sent: no exact window before
  the first completed turn, and it counts the **main loop** — a subagent burning
  tokens does not move it.
- Clicking the ring no longer compacts (it runs `/context`). That is intentional;
  `/compact` lives in the `/` menu.
- Do not pile patches for **other** extensions in here — give them their own skill.
