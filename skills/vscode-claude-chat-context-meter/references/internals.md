# How the patch works (internals)

Read this when you need to change the patcher, not to run it: the protocol, the
commands and the limits live in `SKILL.md`. Recovery from a rewritten toolbar is
in `layout-recovery.md` next to this file.

## What the button shows

The **context** button sits third in the composer, immediately right of `/`:
`+` → `/` → **context**. Clicking it **runs `/context` straight away** (the context
panel opens) — nothing is typed into the input, no Enter needed, no command menu
pops up.

**It carries the live context reading: `◔ 184k`** (mode `usage`, the default) — the
native ring plus how many tokens are in play:

```
＋   /   ◔ 184k        …   Opus 5   ▶
```

Both halves are live and move **while Claude is still working**: the CLI updates
the session's usage signal on every assistant message of the main loop
(`updateUsage`, subagents excluded), not only at the end of a turn. Hovering gives
everything else: `184k of context used (18% of 1M) — click to run /context`.

**The ring is ours, drawn as a proper 0–100 sweep** (`stroke-dasharray`), in
Anthropic's own accent colour. Reusing their ring component was tried first and is
a trap — it looks like a progress ring but is not one:

```js
function L8t(e){ if(e<62.5) return 50; if(e<87) return 75; return 99 }
```

Three states, all of them "past half", because the stock counter never appears
below 50 % anyway. Fed a real percentage it sits at a permanent half-full arc with
no visible track — exactly what the first attempt here shipped. The stock counter
itself is switched off (see the edits below) so the two cannot double up; it is
also why this looked missing before, since it **hides while more than half the
window is free**.

Clicking runs `/context`. Note this **replaces the stock click, which compacted
immediately** — a hair away from the input box. `/compact` is still one `/` menu
away when you actually want it.

This is deliberately **not** a new subscription, a timer or a poll. The toolbar
already reads `session.usageData.value` to feed that counter, so it re-renders on
every change anyway; our label is one division inside that render.

**The denominator is the model's whole window** — `contextWindow` as the CLI
reports it, e.g. `1M` — deliberately **not** the stock counter's usable remainder
(window − max output − the ~13k auto-compact reserve, e.g. `923k`). A round number
is what makes the reading recognisable at a glance, and it is the same figure
`/context` itself prints. The consequence, which is fine but worth knowing: our
percentage is a few points **lower** than the stock counter's would have been on
the same tokens. The reserve is still parsed out of the bundle — matching that
expression is how the usage signal is recognised — it is just not applied.

Why two figures rather than one: the **ring** needs the window size, which the CLI
only sends with a completed turn, while the **token count** is there from the first
assistant message. So a brand-new session reads `◔ 12k` with an empty ring instead
of nothing, and the ring fills in as soon as the window is known — and on a
*reloaded* session it is filled immediately, from the memo — or, failing that,
from the window the model id implies (see below). Before any
reply at all it reads `◔ 0` — an empty ring and a zero, never a bare word. It used
to fall back to the label `context` there, which looked like a leftover of an older
patch precisely where the gauge matters least (a chat not started yet).
Counts are whole thousands (`184k`, then `1.4M`) — `184.3k` would change width on
every message and jitter the toolbar. The button has **no `minWidth`** and **no
left padding**: a box wider than its contents centres them, and the ring's own box
carries ~5 px of slack, so both leave dead space to the left of the ring — visible
the moment the hover background is. Nothing but the flex spacer sits to its right,
so a width that follows the count moves nothing.

On a build where the usage signal cannot be located, the button silently degrades
to a plain `run` button, and if only the ring is missing, to text alone. `--verify`
says which of the three you are getting.

**Startup race (already handled — do not reintroduce).** Slash commands only enter
the registry once the CLI sends `claudeConfig.commands`; for the first fraction of
a second after the chat opens the registry is empty. The first version of the
button fell back to "type the text" in that window, which put a literal `/context`
into the input. Now a `run` button is **disabled (dimmed) until the command is
registered** — `disabled:!__ccCan("/context")`, with the tooltip switching to
"commands still loading". The input component subscribes to the registry through
useSyncExternalStore (`k_(…subscribe…, …version…)`) and the toolbar renders in the
same function body, so the button comes alive on its own, without a window reload.
The text-insertion fallback remains only in case the prop threading did not apply
at all.

## Built-in safeguards

None of this needs doing by hand — but know it is there, and do not work around it:

| Safeguard | What it catches |
|---|---|
| Every name is derived from the bundle; only the anchor is hardcoded | a rebuild with different minified names |
| The anchor must occur exactly once | a renamed or duplicated toolbar |
| The `/` button element is measured by a **string-aware** bracket scan | misplaced insertion: the anchor text contains brackets (`(/)`), naive counting breaks the bundle |
| The anchor must lie inside the button element found | binding to the wrong element |
| The spacer must be within 4000 chars of the anchor | a "similar" toolbar belonging to another component |
| Exactly one call site of the toolbar component | a second UI instance the patch would miss |
| `findCommandByLabel` / `executeCommand` must exist | the command registry being gone (`run` mode impossible) |
| The trial patch is parsed **before** writing (V8 compile, no execution) | any syntax damage |
| After writing: the file is re-read and markers, length and parse are re-checked | a truncated or garbled write — on mismatch the bundle is restored from backup |
| The backup is checked for the absence of markers | an "original" that is in fact already patched |
| A patched bundle with **no** backup is refused, never backed up | freezing the patch in as the "original" and losing `--revert` for good (deleted `.orig`) |
| Marker comments `/*CC-BTN:id*/`, `/*CC-RUN*/` | a repeated run (idempotency) |
| A `run` button is disabled until its command is registered | the startup race — "text typed instead of executed" |
| The path cache never decides **which** bundle to patch | patching a stale extension version after an update |
| `--verify` rehearses through **one** `applyEdits` pass, exactly as the patch does | a rehearsal that is not the real thing: splicing the button in first shifts every later offset (the toolbar's call site is ~38 KB further down), so the plumbing lands somewhere else. A rehearsal that splices the button in separately can pass on a build that would not patch |
| The live reading degrades — ring → text-only → plain button — as pieces go missing | losing the whole button over an optional nicety |
| The stock counter is silenced by an inserted `return null`, never by rewriting its hide-test | a botched rewrite of an expression we do not own; and `--revert` stays exact |
| `--ensure` holds a lock file while writing | two editor windows starting at once and rewriting one bundle |
| `--ensure` never exits non-zero | a session start that reports a failure every time something is off |

Verified against negative cases: renamed anchor, duplicated anchor, missing spacer,
missing insertion callback, stripped registry, two toolbar call sites — all refuse
without writing.

## Where things live

- **Extension:** `<editor-home>/extensions/anthropic.claude-code-<version>-<platform>/`.
  Searched across every editor home (`.vscode`, `.vscode-insiders`, `.vscode-oss`,
  `.vscode-server`, `.cursor`, `.windsurf`, …), plus a scan of the remaining
  `~/.*/extensions` (forks and unusual installs), portable installs
  (`VSCODE_PORTABLE`) and flatpak homes. Custom location: `--ext-dir` /
  `CCM_EXT_DIR`. If the bundle moved inside the extension, the largest
  `index.js` within three levels is used.
- **Backup of the original:** `webview/index.js.orig`, next to the bundle.
- **Ledger of verified versions:** `verified-versions.json` in the skill folder —
  version, date, the minified names found, the buttons the bundle actually carries
  (not just the ones the last run asked for), sha1 of the pristine bundle. The
  shipped file is **read-only** to the patcher: the skill folder may be a git clone,
  where a write of ours would make the user's next `git pull` refuse. Builds this
  machine works out go to `~/.claude/vscode-claude-chat-context-meter.ledger.json`
  and are read on top of the shipped ones. The ledger is machine-independent by
  nature: for a given extension version the bundle is byte-identical everywhere, so
  an entry that travels with the skill is a genuine "this build was already worked
  out" — which is why it is worth sending a new entry upstream.
- **This machine's cache:** `~/.claude/vscode-claude-chat-context-meter.local.json` (plus
  `.runtime`, the Node path for the runners). It sits outside the skill folder for
  the same reason, and because it holds absolute user paths.
  The cache speeds up startup and powers `--where`, but it **never** decides which
  bundle to patch — otherwise a stale version would be patched after an extension
  update. Clear it with `--forget`.

## How it works (needed when something breaks)

- The extension's `package.json` → `contributes` has only `commands`, `keybindings`,
  `views`, `menus: editor/title`. **There is no chat-UI extension point** — neither
  from Anthropic nor from VS Code.
- The chat is entirely a webview. The whole UI is one minified bundle
  `webview/index.js` (~4.8 MB, esbuild, Preact-like helpers `b(type, props)` / `E(...)`).
  Minified but not obfuscated — the code is readable.
- The toolbar under the input is the component with `className:${X}.inputFooter`;
  its `children:[…]` array is: `+` button → `/` button → token counter → **spacer**
  → model/mode picker → submit. Everything before the spacer is the left group,
  everything after it the right one.
- One bundle serves **all** Claude Code chats (sidebar, editor tab, separate
  window) → a single patch covers them all.
- Edits are applied back-to-front so earlier offsets stay valid, and the file is
  written as-is — line endings and encoding are left alone.

### Key fact: slash commands here are not messages

`/context` in this UI is **not sent to the CLI** — it is an entry in the webview's
own command registry. Registration (function `kZe`): id = `slash-command-<name>`,
label = `/<name>`; the action for `context` opens the context panel locally, for
`usage` it calls `executeCommand("account-usage")`, and for the rest it posts
`/<name>` as a message. So "pressing Enter" is correctly emulated not with a key
event (the command popup would swallow it) but through the registry:

```js
let a = ctx.commandRegistry.findCommandByLabel("/context");   // → {id:"slash-command-context", …}
if (a) ctx.commandRegistry.executeCommand(a.id);              // → run it
```

The registry lives in the **input** component's context object and the toolbar does
not receive it, so the patch threads one extra prop down. Hence three edits.

### The edits and their anchors

The only hardcoded constant is the anchor `title:"Show command menu (/)"` (one
occurrence). The minified names (`MXe`, `Ld`, `d`, `n`) differ in every build, so
the script derives them from the anchor with regexes instead of hardcoding them.
Edits 1–3 are always applied; edit 4 only for a `usage` button, and only when the
ring was found. **All of them are insertions** — nothing in the bundle is ever
rewritten or deleted, which is what makes `--revert` exact:

| # | What | Where | How it is found |
|---|------|-------|-----------------|
| 1 | `,onRunSlash:__ccRun,onCanRunSlash:__ccCan` | into the toolbar component signature | `function X({…})` — the nearest `function` before the anchor; inserted before `}){` |
| 2 | the `onRunSlash` (find and execute) and `onCanRunSlash` (is the command registered) handlers | into the single toolbar call site | `\w+\(<toolbar name>,\{`; the context name comes from the nearest `(\w+)\.commandRegistry` before the call |
| 3 | the button itself | after the `/` button element (`slash`), or at the start of `children:[` (`left`), or after the spacer (`right`) | the `/` element = the last `\w+\("button",\{` before the anchor; its end via a string-aware bracket scan |
| 4 | `/*CC-PIE*/return null;` — silences the stock usage counter | first thing in the counter component's body | the counter = `\w+\((\w+),\{usedTokens:` in the toolbar; its body starts at the `}){` of its signature (rejected if further than 400 chars, i.e. not that signature) |

The JSX helper comes from `children:[(\w+)\(`, the CSS-module object from
`className:(\w+)\.menuButton`, the text-insertion callback from `onInsertAtMention:(\w+)`.

### Where the live reading comes from (`usage` mode)

`Layout.readUsage` / `readPie` read the toolbar's own counter — the one edit point
that is **optional**: not finding it costs the reading, not the button, so it never
throws.

```js
// in the toolbar's JSX, feeding the built-in pie:
b(Pie, { usedTokens: <session>.usageData.value.totalTokens,
         contextWindow: <session>.usageData.value.contextWindow
                        - <session>.usageData.value.maxOutputTokens - 13000, … })
```

- `<session>` = the name bound to `session:` in the toolbar's signature.
- We take `totalTokens` and `contextWindow` from it and **skip the subtraction** —
  the button divides by the whole window (see above). The reserve (`13000`) is
  still **parsed out of that expression**, not hardcoded, because matching it is
  what identifies the expression; `--verify` prints the number it found.
- Writes to the signal: `updateUsage()` on every `type:"assistant"` message without
  `parent_tool_use_id` (so mid-turn, main loop only — subagent traffic is excluded),
  and `type:"result"` at the end of a turn, which is what carries `contextWindow`
  and `maxOutputTokens`. `compact_boundary` resets `totalTokens` to 0.
- Reading it from our button inside the same render adds no subscription: the
  toolbar is already reactive to it (`Pn()` at the top of the component).

The counter is silenced by inserting `/*CC-PIE*/return null;` at the **start of its
body**: an insertion, not a rewrite of its hide-test, so it reverts cleanly and
cannot corrupt the expression. Bailing before any hook runs is consistent across
renders, which is all the renderer needs.

Our ring is two `<circle>` elements: a faint track (`currentColor`, 22 % opacity)
and an arc with `stroke-dasharray = 31.42` (= 2π·5, the circumference) and
`stroke-dashoffset = 31.42 · (1 − p/100)`, rotated −90° to start at twelve o'clock.
At 0 % the arc element is dropped — a round cap on a zero-length dash paints a
stray dot. Array children mean this button is built with the **jsxs** helper (the
one that opens the toolbar element) rather than the single-child `jsx`.

**Geometry is copied from the stock counter and should stay that way**: 20×20
viewBox, `r=5`, `stroke-width=1.5`. A first attempt at `r=7` / `2.5` made a visibly
fatter, larger ring than the one it replaced, which read as broken next to `＋`
and `/`.

⚠ **The viewBox is the scale, not the box.** The stylesheet sizes this element —
`.inputFooterV2 .menuButton svg{flex-shrink:0;width:26px;height:26px}` — and a
stylesheet beats width/height attributes, so the SVG is 26 px whatever the
attributes say. 20 units in 26 px draws the ring at 1.3×, exactly like the stock
counter. Cropping the viewBox to the ring (`4 4 12 12`) to kill the slack around
it therefore does not tighten anything: it blows the same circle up to 2.17× —
fat and oversized, the very thing the `r=7` attempt was reverted for. That slack
is a **padding** problem, and it is solved in `USAGE_BUTTON_STYLE`: the ring's box
carries ~5 px around the circle, so the button's left padding is dropped to `0`
and the ring's visible edge lands where the count's edge does on the right.

**Colour** is advice, not a fill level: the orange means "this session has gone on
long enough", not "the window is about to end". Answers drift well before a big
window runs out, so the threshold sits where a handoff starts to beat carrying on —
which on a 1M model is only a quarter of the way in. Keep that in mind before
retuning either number.

**Colour** is `#6b9a5f` (muted sage) below 256k tokens **and** below 60 % of the
window — either rule alone is wrong: the token rule assumes a big window (on a
200k model 256k is never reached, so the ring would rest green with the context
full), and a share rule alone would go orange early on small windows. Above
either, the native `var(--app-claude-clay-button-orange)` — a resting state and a
warning state, the green deliberately less saturated than the orange. The orange is
declared on `html`, so it is in scope anywhere and follows the theme; the extension
ships no green of its own worth borrowing (`--app-success-foreground` inherits
VS Code's git colour, which is far brighter).

**The window comes from three places, in this order: the CLI, the memo, the model
id.** Only the first is exact; the other two exist because a chat you open but
never write in never gets a `contextWindow` at all, and an arc that only appears
after you have spoken is not a gauge.

1. `usageData.contextWindow` — exact, but only ever sent with a completed turn.
2. **Memoised** — in `localStorage` (`ccBtnContextWindowFull`) and in a global
   (`globalThis.__ccBtnWindow`).
3. **Guessed from the model id** (`currentMainLoopModel`, else `lastServedModel`):
   ids ending in `[1m]` are million-token variants, everything else is treated as 200k.
   The id is replayed with the messages, so it is there when the window is not.
   A guess is flagged as `~1M` in the tooltip and never memoised; the first
   completed turn replaces it with the real figure. A build with neither signal
   emits no guess at all — a missing arc beats an invented one.

The memo's key is versioned on purpose: the previous one, `ccBtnContextWindow`,
held the *reduced* window, and reading that number under the new meaning would
silently shrink every percentage. A stale one is dropped on the next write rather
than reused. Both reads are wrapped in `try/catch` — a webview with storage
disabled must not lose its toolbar over a nicety. The global covers what storage
cannot, and costs one assignment.

Where the memo actually lands is worth knowing before you go hunting: the chat
webview writes to the **workbench origin**, `vscode-file://vscode-app`, not to a
`vscode-webview://<id>` one. Verified by reading VS Code's own store
(`%APPDATA%/Code/Local Storage/leveldb`, the key sits next to Claude's own
`claude-vscode-permission-destination`). So it is shared by every window and every
chat view, and survives restarts — but it is only written **after a completed
turn**, which is what step 3 above is for. Webview origins themselves are stable:
VS Code persists them in an application-scoped memento (`memento/webviewViews.origins`).

