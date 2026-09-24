#!/usr/bin/env node
/**
 * Add custom buttons to the Claude Code VS Code chat composer toolbar.
 *
 * The chat UI is a minified React/Preact bundle (`webview/index.js`) inside the
 * installed extension. There is no extension API for adding buttons to the
 * composer, so we patch the bundle in place.
 *
 * Three button behaviours:
 *
 *   usage   (default) - `run`, plus a live context reading: a ring and a short
 *                       token count, e.g. "(o) 184k". Both come off the session's
 *                       usage signal - the very one feeding the built-in counter,
 *                       which this switches off - so they cost nothing: the toolbar
 *                       already re-renders on every change (the CLI updates it on
 *                       each assistant message, i.e. mid-turn too). Degrades to
 *                       the count alone, then to a plain `run` button, as pieces
 *                       of that wiring go missing from a build.
 *   run               - click runs the slash command immediately, the same way
 *                       typing it and pressing Enter would. Slash commands in this
 *                       UI are entries of the webview's own command registry
 *                       (`/context` opens the context panel locally, it is NOT a
 *                       message sent to the CLI), so the button looks the command
 *                       up by label and executes it. Falls back to `insert` when
 *                       the command is not registered.
 *   insert            - click only types the text into the input, no Enter.
 *
 * Run mode needs the command registry, which the toolbar component does not
 * receive, so the patch threads one extra prop from the input component (which
 * has the registry in scope) down into the toolbar. That, the button and the
 * counter cut-off are four edits - all insertions, all anchored on strings
 * derived from the bundle - see references/internals.md.
 *
 * Safety: every edit point is re-derived from the current bundle, never hardcoded;
 * `--verify` reports whether this exact extension build still matches the expected
 * layout (and whether it was verified before); the original bundle is backed up
 * before the first write and the backup is validated as clean; the patched source
 * is parsed before AND after writing. Anything unexpected aborts without touching
 * the file.
 *
 * An editor extension update replaces the whole directory and the patch with it;
 * `--ensure`, wired to a SessionStart hook by `--install-hook`, puts it back.
 *
 * Runtime: Node.js only, no packages. If `node` is not on PATH, use the runner
 * (`run.sh` / `run.ps1`) - it borrows the Node runtime bundled inside VS Code.
 *
 * Usage:
 *   node patch_claude_code_ui.mjs --verify              # preflight, writes no bundle
 *   node patch_claude_code_ui.mjs                       # default: context button, slash slot
 *   node patch_claude_code_ui.mjs --ensure              # quiet self-heal, for a SessionStart hook
 *   node patch_claude_code_ui.mjs --status
 *   node patch_claude_code_ui.mjs --where               # where everything was found
 *   node patch_claude_code_ui.mjs --revert
 *   node patch_claude_code_ui.mjs --reapply             # revert + patch (clean re-do)
 *   node patch_claude_code_ui.mjs --side right          # slot: slash (default) | left | right
 *   node patch_claude_code_ui.mjs --button ctx:/context:insert
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Stable anchor: tooltip of the built-in slash-command button, present once.
// If an update renames it, see references/layout-recovery.md.
const ANCHOR = 'title:"Show command menu (/)"';
const BACKUP_SUFFIX = ".orig";
const btnMarker = (id) => `/*CC-BTN:${id}*/`;
const RUN_MARKER = "/*CC-RUN*/";
const PIE_MARKER = "/*CC-PIE*/";
const RUN_PROP = "__ccRun";
const CAN_PROP = "__ccCan";
const ANY_MARKER = /\/\*CC-(?:BTN:\w+|RUN|PIE)\*\//;
const MODES = ["usage", "run", "insert"];

// What a `usage` button shows, worst to best: a plain label (the usage signal
// was not found), the count alone (no place to switch the stock counter off),
// or the ring plus the count. The order is what lets a degraded button be
// swapped for a better one once the skill can read the build again.
const LEVELS = ["plain", "count", "ring"];
const LEVEL_TEXT = { plain: "plain label", count: "count only", ring: "ring + count" };

// Ring colour: a muted sage below this many tokens in play, the native clay
// orange above it. Deliberately less saturated than the orange - it is a resting
// state, not an alert.
const GREEN_BELOW_TOKENS = 256000;
const RING_GREEN = "#6b9a5f";
// ...and above this share of the window, whatever the token count. The token
// rule alone assumes a big window: on a 200k model 256k is never reached, so the
// ring would still be resting-green with the context all but full.
const ORANGE_ABOVE_PERCENT = 60;

// The window size only ever arrives with a completed turn (`result`), so a
// reloaded window knows the token count long before it knows what to divide it
// by. Remember the last one under this key and the ring survives the reload.
// Versioned: `ccBtnContextWindow` (no suffix) held the counter's usable
// remainder, this one holds the whole window. Reading the old number as the new
// one would quietly shrink every percentage, so the name changed with the
// meaning and the stale key is removed on the next write.
const WINDOW_MEMO_KEY = "ccBtnContextWindowFull";
const WINDOW_MEMO_LEGACY_KEY = "ccBtnContextWindow";
// Same memo, one page life only: survives a session switch (which resets the
// usage signal) and works where localStorage is unavailable.
const WINDOW_MEMO_GLOBAL = "__ccBtnWindow";

// Last resort, so a chat that was opened but never written in still gets an arc
// instead of a bare track: the model id. The CLI only reports the real window
// when a turn completes, but the id is there from the replayed messages, and it
// carries the one hint the webview has - the `[1m]` suffix Claude Code appends
// to the million-token variants; everything else is 200k today. A guessed window
// is marked with `~` in the tooltip and replaced the moment a turn completes.
const BIG_WINDOW_SUFFIX = "[1m]";
const BIG_WINDOW_TOKENS = 1000000;
const DEFAULT_WINDOW_TOKENS = 200000;
const MODEL_SIGNALS = ["currentMainLoopModel", "lastServedModel"];

const DEFAULT_BUTTONS = [["context", "/context", "usage"]];

const EXTENSION_PREFIX = "anthropic.claude-code";

// Editor homes that keep extensions in `<home>/<dir>/extensions`. The home scan
// below catches anything not listed here (forks, renamed installs).
const KNOWN_EDITOR_DIRS = [
  ".vscode",
  ".vscode-insiders",
  ".vscode-oss",
  ".vscode-exploration",
  ".vscode-server",
  ".vscode-server-insiders",
  ".cursor",
  ".cursor-server",
  ".windsurf",
  ".windsurf-server",
  ".trae",
  ".trae-server",
  ".positron",
];

// Machine-specific state (runtime path, where things were found last time) lives
// outside the skill folder on purpose: the skill folder stays shareable.
const STATE_DIR = process.env.CCM_STATE_DIR || path.join(os.homedir(), ".claude");
const STATE_FILE = path.join(STATE_DIR, "vscode-claude-chat-context-meter.local.json");
const RUNTIME_HINT = path.join(STATE_DIR, "vscode-claude-chat-context-meter.runtime");

// The ledger of builds already worked out ships with the skill and is treated as
// read-only: the skill folder may be a git clone (a write there makes `git pull`
// refuse) or read-only altogether. Builds this machine works out are written
// beside the rest of the machine state and read on top of the shipped file.
const LEDGER = path.join(HERE, "verified-versions.json");
const LEDGER_LOCAL = path.join(STATE_DIR, "vscode-claude-chat-context-meter.ledger.json");

const BUTTON_STYLE =
  'style:{width:"auto",padding:"0 6px",fontSize:"11px",lineHeight:"1",' +
  'whiteSpace:"nowrap",borderRadius:"5px"}';

// Ring + label. The stock .menuButton class is a 26px circle, so width, shape
// and layout are overridden here.
//
// Padding is asymmetric on purpose. The ring's own 26px box carries ~5px of
// slack around the circle (see buildRingJs - that slack cannot be cropped out),
// so a symmetric padding lands the visible ring ~10px from the left edge while
// the count sits 5px from the right: under the hover background the button reads
// as misaligned. Dropping the left padding puts the ring's edge where the text's
// edge is. No minWidth either - a box wider than its contents centres them and
// adds the same dead space back; nothing but the flex spacer sits to the right,
// so a width that follows the count moves nothing.
const USAGE_BUTTON_STYLE =
  'style:{width:"auto",height:"26px",padding:"0 5px 0 0",' +
  'display:"inline-flex",alignItems:"center",justifyContent:"center",gap:"3px",' +
  'fontSize:"11px",lineHeight:"1",whiteSpace:"nowrap",borderRadius:"5px"}';

// How far from the anchor the toolbar's own pieces may sit before we treat the
// layout as "not the component we think it is".
const SPACER_MAX_DISTANCE = 4000;
const REGISTRY_LOOKBACK = 60000;

class LayoutError extends Error {}
class Fatal extends Error {}

/* ------------------------------------------------------------------ layout */

/**
 * Everything the patch needs to know about the current bundle.
 *
 * Every field is derived from the bundle itself. Nothing is hardcoded except
 * the anchor string, so a rebuild with different minified names still works -
 * but a *structural* change throws LayoutError instead of writing garbage.
 */
class Layout {
  constructor(src) {
    const hits = countOccurrences(src, ANCHOR);
    if (hits !== 1) {
      throw new LayoutError(`anchor ${JSON.stringify(ANCHOR)} found ${hits} times (expected 1) - layout changed`);
    }
    this.anchorAt = src.indexOf(ANCHOR);
    const windowStart = Math.max(0, this.anchorAt - 900);
    const window = src.slice(windowStart, this.anchorAt);

    const children = [...window.matchAll(/children:\[([\w$]+)\(/g)];
    if (children.length === 0) throw new LayoutError("no toolbar 'children:[' array before the anchor");
    const lastChild = children[children.length - 1];
    this.jsx = lastChild[1];
    this.childrenAt = windowStart + lastChild.index + "children:[".length;

    // The array-children helper (jsxs), i.e. what opens the toolbar element
    // itself. Needed only for a button holding both a ring and a label.
    //
    // The lookbehind matters: this name goes straight into generated code, and
    // on a build shipping `e.jsxs("div",{` a bare `[\w$]+` would capture `jsxs`
    // - a free identifier that parses fine, so the trial patch passes and the
    // toolbar throws at render instead. Every other probe here binds a name it
    // only compares, so a member expression makes them refuse, not lie.
    const wrappers = [...window.matchAll(/(?<![.\w$])([\w$]+)\("div",\{/g)].filter((m) => m.index < lastChild.index);
    this.jsxs = wrappers.length ? wrappers[wrappers.length - 1][1] : null;

    const styles = window.match(/className:([\w$]+)\.menuButton/);
    if (!styles) throw new LayoutError("no CSS-module object (className:X.menuButton)");
    this.styles = styles[1];

    const insertFn = window.match(/onInsertAtMention:([\w$]+)[,}]/);
    if (!insertFn) throw new LayoutError("no text-insertion callback (onInsertAtMention:X)");
    this.insertFn = insertFn[1];

    // Third slot: right after the built-in slash-command button element.
    const slashButtons = [...src.slice(0, this.anchorAt).matchAll(/([\w$]+)\("button",\{/g)];
    if (slashButtons.length === 0) throw new LayoutError("no button element wrapping the anchor");
    const btn = slashButtons[slashButtons.length - 1];
    const elementEnd = callEnd(src, btn.index + btn[1].length);
    if (!(btn.index < this.anchorAt && this.anchorAt < elementEnd)) {
      throw new LayoutError("the anchor is not inside the button element it should belong to");
    }
    if (src[elementEnd] !== ",") {
      throw new LayoutError("unexpected token after the slash-command button element");
    }
    this.afterSlashAt = elementEnd + 1;

    // Right-hand group starts after the flex spacer element.
    const tail = src.slice(this.anchorAt);
    const spacer = tail.match(/[\w$]+\("div",\{className:[\w$]+\.spacer\}\),/);
    if (!spacer) throw new LayoutError("no toolbar spacer element (right-hand group)");
    if (spacer.index > SPACER_MAX_DISTANCE) {
      throw new LayoutError(
        `nearest spacer is ${spacer.index} chars past the anchor - ` +
          "probably a different component, refusing to guess"
      );
    }
    this.spacerEnd = this.anchorAt + spacer.index + spacer[0].length;

    // Toolbar component: the function that contains the anchor.
    const fnStart = src.lastIndexOf("function ", this.anchorAt - "function ".length);
    const name = fnStart >= 0 ? /^function ([\w$]+)\(\{/.exec(src.slice(fnStart, fnStart + 60)) : null;
    if (!name) throw new LayoutError("no toolbar component declaration (function X({...}))");
    this.toolbar = name[1];
    const sigEnd = src.indexOf("}){", fnStart);
    if (sigEnd < 0 || sigEnd > this.anchorAt) {
      throw new LayoutError("could not delimit the toolbar component signature");
    }
    this.signatureEnd = sigEnd; // insert extra prop right before '}'

    this.readUsage(src, fnStart, sigEnd);

    // Its single call site, and the context object holding the command registry.
    const calls = [...src.matchAll(new RegExp(`[\\w$]+\\(${escapeRe(this.toolbar)},\\{`, "g"))];
    if (calls.length !== 1) {
      throw new LayoutError(`expected exactly 1 call site of ${this.toolbar}, found ${calls.length}`);
    }
    this.callPropsAt = calls[0].index + calls[0][0].length;
    const scope = src.slice(Math.max(0, this.callPropsAt - REGISTRY_LOOKBACK), this.callPropsAt);
    const registry = [...scope.matchAll(/(?<![.\w$])([\w$]+)\.commandRegistry/g)];
    if (registry.length === 0) {
      throw new LayoutError("command registry not in the caller's scope (run mode impossible)");
    }
    this.ctx = registry[registry.length - 1][1];

    // The registry API the run-mode handler calls must exist.
    for (const method of ["findCommandByLabel(", "executeCommand("]) {
      if (!src.includes(method)) {
        throw new LayoutError(`registry method ${JSON.stringify(method)} missing from the bundle`);
      }
    }
  }

  /**
   * Locate the live context figure, for the `usage` button mode. Optional by
   * design: a build that hides or renames it costs us the percentage, not the
   * button, so nothing here throws - `hasUsage` just stays false.
   *
   * What we are after is the session object the toolbar already reads to feed
   * the built-in pie counter:
   *
   *   b(Pie,{usedTokens:<session>.usageData.value.totalTokens,
   *          contextWindow:<session>.usageData.value.contextWindow
   *                        -<session>.usageData.value.maxOutputTokens-13000, ...})
   *
   * Reading the same signal from our button adds no subscription and no work:
   * that render already happens.
   *
   * We take the numerator from it and leave the denominator alone: the button
   * reports the model's **whole** window (`contextWindow`, e.g. 1M), not the
   * stock counter's usable remainder (minus max output, minus the auto-compact
   * reserve, e.g. 923k). A round, recognisable number is what the figure is for -
   * and it is the same denominator `/context` itself prints.
   *
   * The proof is the two fields the button actually reads, both read by the
   * toolbar itself: nothing else is required of the build. Requiring the stock
   * counter's whole window arithmetic as well cost the ring on 2.1.280, which
   * merely moved that arithmetic into a helper - so the reserve is read for the
   * --verify report only, and not finding it costs nothing.
   */
  readUsage(src, fnStart, sigEnd) {
    this.session = null;
    this.hasUsage = false;
    this.usageReserve = null; // informational: what the stock counter held back
    this.modelSignals = [];
    this.pieOffAt = null; // where to switch the built-in counter off

    const signature = src.slice(fnStart, sigEnd);
    const session = signature.match(/[({,]session:([\w$]+)[,}]/);
    if (!session) return;
    this.session = session[1];

    // The toolbar's own JSX: from the end of the signature past the spacer, so
    // the counter is caught in either group.
    const body = src.slice(sigEnd, Math.min(src.length, this.spacerEnd + 3000));
    const value = `${escapeRe(this.session)}\\.usageData\\.value`;
    if (!new RegExp(`${value}\\.totalTokens`).test(body)) return;
    if (!new RegExp(`${value}\\.contextWindow`).test(body)) return;

    this.usageReserve = this.readReserve(src, body, value);
    this.hasUsage = true;

    // Signals naming the model in play, for the fallback window. Optional like
    // everything else here: a build without them just shows no arc until the
    // first completed turn.
    this.modelSignals = MODEL_SIGNALS.filter((name) => src.includes(`${name}=`));

    this.readPie(src, body);
  }

  /**
   * The auto-compact reserve in the stock counter's window expression, or null
   * when it cannot be read. Only --verify prints it. Two shapes are known:
   *
   *   inline (<= 2.1.27x):  <v>.contextWindow-<v>.maxOutputTokens-13000
   *   helper (2.1.280+):    fn(<v>.contextWindow,<v>.maxOutputTokens)
   *                         function fn($,J){return $-Math.min(J,CAP)-RES}
   *                         var RES=13000
   */
  readReserve(src, body, value) {
    const inline = body.match(new RegExp(`${value}\\.contextWindow-${value}\\.maxOutputTokens-(\\d+)`));
    if (inline) return Number(inline[1]);

    const call = body.match(new RegExp(`([\\w$]+)\\(${value}\\.contextWindow,${value}\\.maxOutputTokens\\)`));
    if (!call) return null;
    const fn = src.match(new RegExp(
      `function ${escapeRe(call[1])}\\(([\\w$]+),([\\w$]+)\\)\\{return \\1-Math\\.min\\(\\2,[\\w$]+\\)-([\\w$]+|\\d+)\\}`));
    if (!fn) return null;
    if (/^\d+$/.test(fn[3])) return Number(fn[3]);
    const res = src.match(new RegExp(`(?:var|let|const) ${escapeRe(fn[3])}=(\\d+)[;,]`));
    return res ? Number(res[1]) : null;
  }

  /**
   * Where to switch the stock usage counter off, so it cannot double up with
   * our own ring. Optional, like the rest of readUsage: not finding it means we
   * draw no ring and leave the counter alone.
   *
   *   toolbar:  b(<counter>,{usedTokens:…,contextWindow:…,onCompact:…})
   *   counter:  function <counter>({…}){ … }
   *
   * We do NOT reuse their ring component. It looks like a progress ring but is
   * not one: `if(e<62.5)return 50; if(e<87)return 75; return 99` — three states,
   * covering only "past half", because the counter never shows below 50%. Fed a
   * real percentage it sits at a permanent half-full arc. Ours is a two-circle
   * SVG with a proper 0-100 sweep; the accent colour is still theirs
   * (`--app-claude-clay-button-orange`, declared on `html`).
   */
  readPie(src, body) {
    const host = body.match(/[\w$]+\(([\w$]+),\{usedTokens:/);
    if (!host) return;
    const fnAt = src.indexOf(`function ${host[1]}(`);
    if (fnAt < 0) return;
    const bodyAt = src.indexOf("}){", fnAt);
    if (bodyAt < 0 || bodyAt - fnAt > 400) return; // not the signature we expect

    this.pieOffAt = bodyAt + "}){".length;
  }

  /** Insertion offset for the requested position in the toolbar. */
  slot(side) {
    return { slash: this.afterSlashAt, left: this.childrenAt, right: this.spacerEnd }[side];
  }

  symbols() {
    return {
      jsx: this.jsx,
      jsxs: this.jsxs || "-",
      css: this.styles,
      insert: this.insertFn,
      toolbar: this.toolbar,
      ctx: this.ctx,
      session: this.session || "-",
    };
  }

  describe() {
    return Object.entries(this.symbols())
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
  }
}

/**
 * Offset just past the ')' that closes the call opening at `openParen`.
 *
 * String-aware: the minified code carries brackets inside string literals
 * (the anchor tooltip itself contains '(/)'), so naive counting misplaces
 * the button by a few characters and breaks the bundle.
 */
function callEnd(src, openParen) {
  if (src[openParen] !== "(") throw new LayoutError("expected '(' at the start of the button element");
  let depth = 0;
  let quote = "";
  let i = openParen;
  while (i < src.length) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  throw new LayoutError("unbalanced parentheses while measuring the button element");
}

/** Escape a minified identifier for use inside a RegExp source (names carry `$`). */
function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function countOccurrences(haystack, needle) {
  let n = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    n += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return n;
}

/* -------------------------------------------------------------- injections */

/** Render the injected button as a call to the bundle's own JSX helper. */
function buildButtonJs(buttonId, text, mode, lay) {
  const insert = `${lay.insertFn}&&${lay.insertFn}("${text}")`;
  const ring = mode === "usage" && wantsRing([[buttonId, text, mode]], lay);
  const helper = ring ? lay.jsxs : lay.jsx; // array children need jsxs
  const style = ring ? USAGE_BUTTON_STYLE : BUTTON_STYLE;
  let extra;
  let action;
  let label = `children:"${buttonId}"`;
  if (mode === "run" || mode === "usage") {
    // Slash commands land in the registry only once the CLI sends its config,
    // so until then the button is disabled instead of falling back to typing
    // the text (a stray "/context" in the input is worse than a dead button).
    // The input component re-renders on registry changes, so this self-heals.
    const ready = `${CAN_PROP}&&${CAN_PROP}("${text}")`;
    action = `${RUN_PROP}?${RUN_PROP}("${text}"):(${insert})`;
    if (mode === "usage") {
      extra = `disabled:!(${ready}),`;
      label = buildUsageLabelJs(buttonId, text, ready, lay, ring); // spreads children+title
    } else {
      extra = `disabled:!(${ready}),title:(${ready})?"Run ${text}":"${text} — commands still loading",`;
    }
  } else {
    extra = `title:"Insert ${text}",`;
    action = insert;
  }
  return (
    `${btnMarker(buttonId)}${helper}` +
    '("button",{type:"button",' +
    `className:${lay.styles}.menuButton,` +
    `${extra}${style},` +
    `onClick:()=>{${action}},` +
    `${label}}),`
  );
}

/**
 * The ring: a faint full circle plus an arc swept to `cp` percent.
 *
 * Geometry is copied from the stock counter so the button does not grow — same
 * 20x20 box, same radius 5, same 1.5 stroke.
 *
 * DO NOT "crop" the viewBox to the ring to tighten the spacing: the stylesheet
 * sizes this element (`.inputFooterV2 .menuButton svg{width:26px;height:26px}`),
 * which beats the width/height attributes, so the viewBox is not a box at all -
 * it is the scale. 20 units in a 26px box draw the ring at 1.3x, exactly like the
 * stock one; a 12-unit viewBox draws the same circle at 2.17x, i.e. fat and
 * oversized. The ~5px of slack around the ring is dealt with by the button's
 * padding instead (see USAGE_BUTTON_STYLE).
 *
 * What differs from the stock counter is the sweep:
 * `stroke-dasharray` = the circumference (2*pi*5 = 31.42) and `stroke-dashoffset`
 * = the unpainted remainder, so every value from 0 to 100 is drawn exactly,
 * instead of the three states the stock ring quantises to. Rotated -90deg to
 * start at twelve o'clock. At 0% the arc is dropped entirely — a round cap on a
 * zero-length dash paints a stray dot.
 *
 * Colour: calm green below GREEN_BELOW_TOKENS, the native clay orange above it.
 */
function buildRingJs(lay) {
  const circle = (props) => `${lay.jsx}("circle",{cx:"10",cy:"10",r:"5",fill:"none",${props}})`;
  const track = circle('stroke:"currentColor",strokeOpacity:"0.22",strokeWidth:"1.5"');
  // `!(cp>=x)` rather than `cp<x`: cp is null while the window is unknown, and
  // an unknown share must not turn the ring orange by itself.
  const colour =
    `ct<${GREEN_BELOW_TOKENS}&&!(cp>=${ORANGE_ABOVE_PERCENT})` +
    `?"${RING_GREEN}":"var(--app-claude-clay-button-orange)"`;
  const arc = circle(
    `stroke:${colour},strokeWidth:"1.5",strokeLinecap:"round",` +
      'strokeDasharray:"31.42",strokeDashoffset:31.42*(1-Math.max(0,Math.min(100,cp||0))/100),' +
      'transform:"rotate(-90 10 10)"'
  );
  return (
    `${lay.jsxs}("svg",{width:"20",height:"20",viewBox:"0 0 20 20",fill:"none",` +
    `style:{display:"block",flexShrink:0},children:[${track},cp>0&&${arc}]})`
  );
}

/**
 * Switch the stock usage counter off: ours says the same thing, and two rings
 * side by side (the stock one appears once the window is half full) would just
 * be noise.
 *
 * An early `return null` rather than a rewrite of its "should I hide?" test:
 * pure insertion, so it reverts cleanly and cannot damage the expression. The
 * component is consistent across renders (it always bails before touching a
 * hook), which is all the renderer requires.
 */
function buildPieOffJs() {
  return `${PIE_MARKER}return null;`;
}

/**
 * Contents and tooltip of a `usage` button, as a spread of {children,title}:
 * the native ring plus a short token count, e.g. `◔ 184k`.
 *
 * Evaluated inline in the toolbar's render, where the usage signal is already
 * being read - so this subscribes to nothing, schedules nothing and polls
 * nothing; it is one division on a render that happens anyway.
 *
 * Two figures, deliberately: the ring needs the window size, which only arrives
 * with the first completed turn, while the token count is there from the first
 * assistant message. So a fresh session shows `◔ 12k` with an empty ring rather
 * than nothing at all, and the ring fills in once the CLI reports the window.
 * Percentages, totals and the exact numbers live in the tooltip.
 *
 * The button never falls back to bare text: with nothing counted yet it reads
 * `◔ 0`, an empty ring next to a zero. A word where a gauge is expected reads as
 * a different button, and it showed up exactly where the reading matters least
 * (a chat not started yet), so it looked like a leftover of an older patch.
 */
/**
 * Fallback denominator from the model id, when the CLI has not reported the
 * window yet. Sets `cg` (guessed) so the tooltip can own up to it.
 *
 * The id survives what the window does not: it comes back with the replayed
 * messages of a resumed chat, while `contextWindow` only ever arrives with a
 * completed turn. `[1m]` is the suffix Claude Code appends to million-token
 * variants; everything else is 200k today. Emits nothing at all on a build where
 * neither signal was found — a missing arc beats an invented one.
 */
function buildGuessedWindowJs(lay) {
  if (!lay.modelSignals.length) return "";
  const read = lay.modelSignals
    .map((name) => `(${lay.session}.${name}&&${lay.session}.${name}.value)`)
    .join("||");
  return (
    "if(!(cw>0)){var cm=String(" +
    `${read}||""` +
    `).toLowerCase();cg=1;cw=cm.slice(-${BIG_WINDOW_SUFFIX.length})===` +
    `"${BIG_WINDOW_SUFFIX}"?${BIG_WINDOW_TOKENS}:${DEFAULT_WINDOW_TOKENS}}`
  );
}

function buildUsageLabelJs(buttonId, text, ready, lay, ring) {
  const value = `${lay.session}.usageData.value`;
  // Whole thousands only: `184.3k` would change width on every message and
  // jitter the toolbar. `cf` also renders the window, so `1M` never comes out
  // as `1000k` - a round window is half the point of showing it.
  const short =
    'var cf=function(cv){return cv>=1e6?+(cv/1e6).toFixed(1)+"M":Math.round(cv/1000)+"k"},' +
    'cs=ct<=0?"0":ct<1000?"<1k":cf(ct);';
  const label = ring ? `[${buildRingJs(lay)},cs]` : "cs";
  return (
    "..." +
    "(()=>{" +
    `var cr=${ready},cu=(${lay.session}.usageData&&${value})||{},` +
    // The whole window, not the stock counter's usable remainder: 1M reads as
    // 1M. See Layout.readUsage for why the reserve is parsed but not applied.
    "cw=cu.contextWindow||0," +
    "ct=cu.totalTokens||0,cg=0;" +
    // Carry the window across reloads (localStorage, WINDOW_MEMO_KEY) and across
    // session switches inside one page (a plain global, which also covers a
    // webview with storage disabled). Both are wrapped: neither is worth losing
    // the toolbar over. Without this a resumed chat knows its token count long
    // before it knows what to divide it by - the CLI only reports the window
    // with a completed turn - and the ring would sit empty next to a real count.
    // The key is versioned: an older patch stored a different quantity under a
    // different name, and a stale one is dropped rather than read as this one.
    `if(cw>0){try{globalThis.${WINDOW_MEMO_GLOBAL}=cw;` +
    `localStorage.setItem("${WINDOW_MEMO_KEY}",cw);` +
    `localStorage.removeItem("${WINDOW_MEMO_LEGACY_KEY}")}catch(ce){}}` +
    `else{try{cw=+globalThis.${WINDOW_MEMO_GLOBAL}||` +
    `+localStorage.getItem("${WINDOW_MEMO_KEY}")||0}catch(ce){cw=0}}` +
    // Still nothing (a chat opened but never written in, on a machine that has
    // not completed a turn since): fall back to the window the model id implies,
    // and say so with a `~` in the tooltip.
    buildGuessedWindowJs(lay) +
    "var cp=cw>0?Math.min(100,Math.round(ct/cw*100)):null;" +
    short +
    "return{" +
    `children:${label},` +
    `title:!cr?"${text} — commands still loading":` +
    `ct<=0?"Run ${text}":` +
    `cs+" of context used"+(cp===null?"":" ("+cp+"% of "+(cg?"~":"")+cf(cw)+")")+" — click to run ${text}"` +
    "}})()"
  );
}

/**
 * Downgrade `usage` to `run` on builds where the live figure was not found.
 * The percentage is a nicety; losing the button over it would not be.
 */
function resolveModes(buttons, lay, onDowngrade) {
  return buttons.map(([id, text, mode]) => {
    if (mode !== "usage" || lay.hasUsage) return [id, text, mode];
    if (onDowngrade) onDowngrade(id);
    return [id, text, "run"];
  });
}

/** Edits that give the toolbar a 'run this slash command' callback. */
function buildRunPlumbing(lay) {
  return [
    [lay.signatureEnd, `,onRunSlash:${RUN_PROP},onCanRunSlash:${CAN_PROP}${RUN_MARKER}`],
    [
      lay.callPropsAt,
      `onRunSlash:(cc)=>{let ca=${lay.ctx}.commandRegistry.findCommandByLabel(cc);` +
        `if(!ca)return!1;return ${lay.ctx}.commandRegistry.executeCommand(ca.id),!0},` +
        `onCanRunSlash:(cc)=>!!${lay.ctx}.commandRegistry.findCommandByLabel(cc),${RUN_MARKER}`,
    ],
  ];
}

/** The full edit list a patch of `buttons` would apply to a pristine bundle. */
function trialEdits(lay, buttons) {
  const slot = lay.slot("slash");
  const resolved = resolveModes(buttons, lay);
  const edits = [...buildRunPlumbing(lay)];
  if (wantsRing(resolved, lay)) edits.push([lay.pieOffAt, buildPieOffJs()]);
  for (const [id, text, mode] of resolved) {
    edits.push([slot, buildButtonJs(id, text, mode, lay)]);
  }
  return edits;
}

/** Does this set of buttons put the ring on our own button? */
function wantsRing(buttons, lay) {
  return usageLevel(lay) === "ring" && buttons.some(([, , mode]) => mode === "usage");
}

/** The best a `usage` button can show on this layout (see LEVELS). */
function usageLevel(lay) {
  if (!lay.hasUsage) return "plain";
  return lay.jsxs && lay.pieOffAt !== null ? "ring" : "count";
}

/* ---------------------------------------------------- buttons already there */

/**
 * [start, end) of one of our buttons: the marker, the element, and the comma
 * buildButtonJs puts after it. Throws LayoutError on anything shaped otherwise:
 * then it is not ours to take apart.
 */
function buttonSpan(src, id) {
  const marker = btnMarker(id);
  const at = src.indexOf(marker);
  if (at < 0) return null;
  const from = at + marker.length;
  const head = /^([\w$]+)\("button",\{/.exec(src.slice(from, from + 80));
  if (!head) throw new LayoutError(`button '${id}' is not shaped the way this skill writes it`);
  const end = callEnd(src, from + head[1].length);
  if (src[end] !== ",") throw new LayoutError(`button '${id}' does not end the way this skill writes it`);
  return [at, end + 1];
}

/** What one of our buttons shows now (see LEVELS), or null if it is not there. */
function buttonLevel(src, id) {
  const span = buttonSpan(src, id);
  if (!span) return null;
  const code = src.slice(span[0], span[1]);
  if (code.includes('("svg",')) return "ring";
  if (code.includes(".usageData")) return "count";
  return "plain";
}

/** buttonLevel for a report: never throws. */
function describeLevel(src, id) {
  try {
    return buttonLevel(src, id) || "missing";
  } catch (exc) {
    if (exc instanceof LayoutError) return "unrecognised";
    throw exc;
  }
}

/**
 * `usage` buttons that went in showing less than this build allows: a skill
 * that could not read the build put a plain label in, the skill has learnt it
 * since, and the button would otherwise stay plain until the next extension
 * update - the self-heal only checks that a button is there. The judge is the
 * pristine bundle, the same one --verify reads. A button this skill did not
 * write, or a layout it cannot read, is left alone.
 */
function staleButtons(src, original, buttons) {
  const usage = buttons.filter(([id, , mode]) => mode === "usage" && src.includes(btnMarker(id)));
  if (usage.length === 0) return [];
  let best;
  try {
    best = LEVELS.indexOf(usageLevel(new Layout(original)));
  } catch (exc) {
    if (exc instanceof LayoutError) return [];
    throw exc;
  }
  return usage.filter(([id]) => {
    const now = describeLevel(src, id);
    return LEVELS.includes(now) && LEVELS.indexOf(now) < best;
  });
}

/**
 * Take our own buttons back out. Returns the source without them and, per id,
 * the offset in that source where each one sat - which is where its
 * replacement goes. What is left is again "original + our insertions", so
 * --revert stays exact.
 */
function stripButtons(src, ids) {
  const spans = ids.map((id) => [id, ...buttonSpan(src, id)]).sort((a, b) => a[1] - b[1]);
  const at = new Map();
  let out = "";
  let from = 0;
  let removed = 0;
  for (const [id, start, end] of spans) {
    out += src.slice(from, start);
    at.set(id, start - removed);
    removed += end - start;
    from = end;
  }
  return { src: out + src.slice(from), at };
}

/** Apply [offset, js] edits back-to-front so earlier offsets stay valid. */
function applyEdits(src, edits) {
  const ordered = [...edits].sort((a, b) => b[0] - a[0]); // stable: same slot keeps order
  let out = src;
  for (const [offset, js] of ordered) out = out.slice(0, offset) + js + out.slice(offset);
  return out;
}

/* ------------------------------------------------------------ syntax check */

/**
 * Parse check without any external tooling: V8 pre-parses the whole source, so
 * a compile with no execution catches the syntax damage we care about.
 * The webview bundle is a classic script (esbuild IIFE loaded by <script>), so
 * the script goal is the right one; were it ever shipped as an ES module this
 * would report a parse error and refuse to patch - a safe failure, not damage.
 * Returns an error string, or null when the source parses.
 */
function checkSyntax(src) {
  try {
    new vm.Script(src, { filename: "ccm-check.js" });
    return null;
  } catch (err) {
    return String(err && err.message ? err.message : err).slice(0, 500);
  }
}

/* ------------------------------------------------------------------- files */

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function backupOf(bundle) {
  return bundle + BACKUP_SUFFIX;
}

function extensionDir(bundle) {
  return path.dirname(path.dirname(bundle));
}

function extensionVersion(bundle) {
  const name = path.basename(extensionDir(bundle));
  const m = name.match(/claude-code-([\d.]+)/);
  return m ? m[1] : name;
}

function sha1(text) {
  return crypto.createHash("sha1").update(text, "utf8").digest("hex").slice(0, 12);
}

/* ------------------------------------------------- discovery (any platform) */

/** Every directory that could hold installed editor extensions, on any OS. */
function extensionRoots() {
  const home = os.homedir();
  const roots = [];
  const add = (p) => {
    if (p && !roots.includes(p)) roots.push(p);
  };

  for (const p of splitPathList(process.env.CCM_EXT_DIR)) add(path.resolve(p));
  for (const p of splitPathList(process.env.CCM_EXT_DIR_EXTRA)) add(path.resolve(p));

  // Portable installs put everything next to the executable.
  if (process.env.VSCODE_PORTABLE) add(path.join(process.env.VSCODE_PORTABLE, "extensions"));

  for (const dir of KNOWN_EDITOR_DIRS) add(path.join(home, dir, "extensions"));

  // Anything else that looks like an editor home (forks, renamed installs,
  // unusual setups) - cheap, the home dir is small.
  try {
    for (const entry of fs.readdirSync(home)) {
      if (entry.startsWith(".") && isDir(path.join(home, entry, "extensions"))) {
        add(path.join(home, entry, "extensions"));
      }
    }
  } catch {}

  // Flatpak keeps a sandboxed home per app.
  const flatpakRoot = path.join(home, ".var", "app");
  if (isDir(flatpakRoot)) {
    try {
      for (const app of fs.readdirSync(flatpakRoot)) {
        for (const rel of [
          ["data", "vscode", "extensions"],
          ["data", "vscode-oss", "extensions"],
          ["config", "Code", "extensions"],
        ]) {
          const p = path.join(flatpakRoot, app, ...rel);
          if (isDir(p)) add(p);
        }
      }
    } catch {}
  }

  // Roots that worked last time (a custom --extensions-dir, say) survive here.
  const state = readJson(STATE_FILE, {});
  for (const p of state.extensionRoots || []) add(p);

  return roots.filter(isDir);
}

function splitPathList(value) {
  if (!value) return [];
  return value
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Locate every installed Claude Code extension's webview bundle. */
function findBundles(roots) {
  const bundles = [];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root).sort();
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.startsWith(EXTENSION_PREFIX)) continue;
      const extDir = path.join(root, name);
      if (!isDir(extDir)) continue;
      const primary = path.join(extDir, "webview", "index.js");
      if (isFile(primary)) {
        if (!bundles.includes(primary)) bundles.push(primary);
        continue;
      }
      // Layout moved inside the extension: look for a big index.js nearby.
      const found = findWebviewBundle(extDir, 3);
      if (found && !bundles.includes(found)) bundles.push(found);
    }
  }
  return bundles;
}

/** Fallback scan: the largest index.js under the extension, depth-limited. */
function findWebviewBundle(dir, depth) {
  if (depth < 0) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let best = null;
  let bestSize = 1024 * 1024; // a real bundle is megabytes; ignore stubs
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === "index.js") {
      try {
        const size = fs.statSync(p).size;
        if (size > bestSize) {
          best = p;
          bestSize = size;
        }
      } catch {}
    } else if (entry.isDirectory() && entry.name !== "node_modules") {
      const nested = findWebviewBundle(p, depth - 1);
      if (nested) {
        try {
          const size = fs.statSync(nested).size;
          if (size > bestSize) {
            best = nested;
            bestSize = size;
          }
        } catch {}
      }
    }
  }
  return best;
}

/* ------------------------------------------------------------------ ledger */

/** Shipped ledger, with this machine's own findings layered on top. */
function readLedger() {
  return { ...readJson(LEDGER, {}), ...readJson(LEDGER_LOCAL, {}) };
}

/**
 * Record a build we just worked out - into the machine state, never into the
 * skill folder. Failing to record is not a reason to fail a patch that already
 * succeeded: the ledger is a convenience, and the bundle is already written.
 */
function writeLedger(version, entry) {
  try {
    const ledger = { ...readJson(LEDGER_LOCAL, {}), [version]: entry };
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(LEDGER_LOCAL, JSON.stringify(ledger, null, 2) + "\n", "utf8");
  } catch {}
}

/* ----------------------------------------------------------- machine state */

/**
 * Remember where this machine keeps things, so the next run (and the runner
 * scripts) skip the search. Never consulted for *which* bundle to patch - an
 * extension update creates a new directory and a stale hit would be patched
 * silently - only for speed and diagnostics.
 *
 * `facts` holds what this run learnt per bundle; a field it leaves undefined
 * keeps its previous value as long as the file itself is unchanged. Otherwise
 * a --where or a --status would wipe what --ensure knows (`refused`,
 * `checkedBy`), and the next session start would re-read and re-report a build
 * it had already dealt with.
 */
function saveState(bundles, roots, facts) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const previous = new Map((readJson(STATE_FILE, {}).bundles || []).map((b) => [b.path, b]));
    const state = {
      updated: new Date().toISOString().slice(0, 10),
      platform: `${process.platform}-${process.arch}`,
      runtime: process.execPath,
      runtimeIsElectron: Boolean(process.versions.electron),
      extensionRoots: roots,
      bundles: bundles.map((b) => {
        // Identity of the file we last looked at, so --ensure can tell "still
        // the bundle I patched" from "replaced by an update" without reading
        // five megabytes on every session start.
        const stamp = fileStamp(b);
        const old = previous.get(b);
        const same = old && old.size === stamp.size && old.mtimeMs === stamp.mtimeMs;
        const known = {};
        for (const key of ["patched", "buttons", "refused", "checkedBy"]) {
          const now = facts && facts.get(b) ? facts.get(b)[key] : undefined;
          if (now !== undefined) known[key] = now;
          else if (same && old[key] !== undefined) known[key] = old[key];
        }
        return { path: b, version: extensionVersion(b), backup: isFile(backupOf(b)), ...stamp, ...known };
      }),
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n", "utf8");
    fs.writeFileSync(RUNTIME_HINT, process.execPath + "\n", "utf8");
  } catch {
    // State is a convenience; never fail the patch over it.
  }
}

/** Size + mtime of a file, the cheap "is this still the same file" fingerprint. */
function fileStamp(file) {
  try {
    const st = fs.statSync(file);
    return { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
  } catch {
    return {};
  }
}

function forgetState() {
  let removed = 0;
  for (const f of [STATE_FILE, RUNTIME_HINT]) {
    try {
      fs.unlinkSync(f);
      removed += 1;
      console.log(`  [-] removed ${f}`);
    } catch {}
  }
  if (removed === 0) console.log("  nothing cached");
}

/* ---------------------------------------------------------------- commands */

/** Return [source, isPatched]. Prefers the untouched backup when present. */
function pristineSource(bundle) {
  const backup = backupOf(bundle);
  const src = fs.readFileSync(bundle, "utf8");
  const patched = ANY_MARKER.test(src);
  if (isFile(backup)) {
    const original = fs.readFileSync(backup, "utf8");
    if (ANY_MARKER.test(original)) {
      throw new LayoutError(
        `backup ${path.basename(backup)} itself contains patch markers - it is not a clean original; ` +
          "delete it only if you are sure, otherwise reinstall the extension"
      );
    }
    return [original, patched];
  }
  return [src, patched];
}

/** Preflight: is this build safe to patch? Writes nothing. True = safe. */
function verifyBundle(bundle, buttons) {
  const version = extensionVersion(bundle);
  const known = readLedger()[version];
  console.log(`  version: ${version}` + (known ? `  (verified ${known.date})` : "  (NEW - never patched before)"));

  let original;
  let patched;
  try {
    [original, patched] = pristineSource(bundle);
  } catch (exc) {
    if (!(exc instanceof LayoutError)) throw exc;
    console.log(`  UNSAFE: ${exc.message}`);
    return false;
  }

  console.log(
    `  state:   ${patched ? "patched" : "clean"};` + ` backup ${isFile(backupOf(bundle)) ? "present" : "absent"}`
  );
  console.log(`  origin:  sha1 ${sha1(original)} of pristine bundle`);

  let lay;
  try {
    lay = new Layout(original);
  } catch (exc) {
    if (!(exc instanceof LayoutError)) throw exc;
    console.log(`  UNSAFE: ${exc.message}`);
    console.log("  -> do NOT patch blindly; re-derive the anchors (see SKILL.md)");
    return false;
  }

  console.log(`  layout:  ${lay.describe()}`);
  if (known && known.symbols) {
    // Only names the recorded entry actually carries: an older entry predating
    // a name we track now would otherwise read as "changed" on every run.
    const changed = Object.entries(lay.symbols()).filter(([k, v]) => k in known.symbols && known.symbols[k] !== v);
    if (changed.length) {
      const pretty = changed.map(([k, v]) => `${k}: ${known.symbols[k]} -> ${v}`).join(", ");
      console.log(`  note:    minified names differ from last run (${pretty}) - expected after a rebuild, harmless`);
    }
  }

  const wantsUsage = buttons.some(([, , mode]) => mode === "usage");
  if (lay.hasUsage) {
    const ring = wantsRing(buttons, lay)
      ? "ring drawn (0-100 sweep), stock counter off"
      : "count only (the ring cannot be placed on this build)";
    const reserve =
      lay.usageReserve === null ? "reserve not read, informational only" : `reserves ${lay.usageReserve} + max output`;
    console.log(
      `  usage:   live from ${lay.session}.usageData, full window as the denominator ` +
        `(stock counter ${reserve}); ${ring}`
    );
  } else if (wantsUsage) {
    console.log("  usage:   live figure NOT found in this build - the button falls back to a plain label");
  }

  // Rehearse exactly what the real run would inject, in the same slot, and
  // through the same single applyEdits pass: splicing the button in first and
  // only then applying the plumbing would shift every later offset (the
  // toolbar's call site sits tens of kilobytes further down the file) and
  // rehearse a patch nobody is going to apply.
  const err = checkSyntax(applyEdits(original, trialEdits(lay, buttons)));
  if (err) {
    console.log(`  UNSAFE: a trial patch does not parse:\n${err}`);
    return false;
  }
  console.log("  parse:   trial patch parses cleanly");
  // Safe, but not what the user asked for: say so in the verdict itself, where
  // the protocol looks, not only in the usage line above it.
  const level = usageLevel(lay);
  if (wantsUsage && level !== "ring") {
    const what = level === "plain" ? "a plain label, no count and no ring" : "the count without its ring";
    console.log(`  SAFE TO PATCH - DEGRADED: ${what} (see references/layout-recovery.md)`);
  } else {
    console.log("  SAFE TO PATCH");
  }
  return true;
}

/**
 * `base: "pristine"` patches the untouched original instead of what is on disk.
 * Used by --reapply, so that its --dry-run rehearsal reports the same plan the
 * real run would follow (on disk the buttons are still there, and a plain read
 * would make every edit look like a no-op).
 */
function patchBundle(bundle, buttons, side, dryRun, base = "current") {
  const [original] = pristineSource(bundle);
  const backup = backupOf(bundle);
  let src = base === "pristine" ? original : fs.readFileSync(bundle, "utf8");

  // Without a backup the file on disk is the only original we have. If it is
  // already patched, copying it to .orig would freeze the patch in as the
  // "original" and make --revert impossible for good.
  if (!isFile(backup) && ANY_MARKER.test(src)) {
    throw new Fatal(
      `${path.basename(bundle)} already contains patch markers but ${path.basename(backup)} is missing - ` +
        "refusing to save a patched bundle as the original.\n" +
        "Reinstall the extension (Extensions -> Claude Code -> Uninstall, then Install) and patch again."
    );
  }

  // A usage button showing less than this build allows is replaced in place:
  // the one way a skill fix reaches a bundle that was patched before the fix.
  const stale = staleButtons(src, original, buttons);
  const staleIds = stale.map(([id]) => id);
  for (const [buttonId] of buttons) {
    if (!src.includes(btnMarker(buttonId))) continue;
    if (staleIds.includes(buttonId)) {
      const now = LEVEL_TEXT[describeLevel(src, buttonId)];
      console.log(`  [^] button '${buttonId}' (${now}) - this build allows more, replacing it`);
    } else {
      console.log(`  [=] button '${buttonId}' already present`);
    }
  }
  let pending = buttons.filter(([id]) => !src.includes(btnMarker(id)));
  if (pending.length === 0 && stale.length === 0) return;

  const holes = stripButtons(src, staleIds);
  src = holes.src;
  const lay = new Layout(src);
  console.log(`  [i] ${lay.describe()}`);
  const downgrade = (id) =>
    console.log(`  [!] button '${id}': live context % not found in this build, using a plain label`);
  pending = resolveModes(pending, lay, downgrade);
  const replacing = resolveModes(stale, lay, downgrade);
  const all = [...pending, ...replacing];

  const edits = [];
  if (all.some(([, , mode]) => mode === "run" || mode === "usage") && !src.includes(RUN_MARKER)) {
    edits.push(...buildRunPlumbing(lay));
    console.log("  [+] run plumbing (onRunSlash prop + command-registry handler)");
  }
  if (wantsRing(all, lay) && !src.includes(PIE_MARKER)) {
    edits.push([lay.pieOffAt, buildPieOffJs()]);
    console.log("  [+] stock usage counter switched off (our button carries the ring)");
  }

  const where = lay.slot(side);
  for (const [buttonId, text, mode] of pending) {
    edits.push([where, buildButtonJs(buttonId, text, mode, lay)]);
    console.log(`  [+] button '${buttonId}' -> ${mode} '${text}' (slot: ${side})`);
  }
  for (const [buttonId, text, mode] of replacing) {
    edits.push([holes.at.get(buttonId), buildButtonJs(buttonId, text, mode, lay)]);
    console.log(`  [+] button '${buttonId}' -> ${mode} '${text}' (in its old place)`);
  }

  const added = edits.reduce((sum, [, js]) => sum + js.length, 0);
  const expectedLen = src.length + added;
  src = applyEdits(src, edits);

  const err = checkSyntax(src);
  if (err) throw new Fatal(`patched bundle fails to parse, aborting:\n${err}`);

  if (dryRun) {
    console.log("  [dry-run] nothing written");
    return;
  }

  if (!isFile(backup)) {
    fs.copyFileSync(bundle, backup);
    console.log(`  [b] backup -> ${path.basename(backup)}`);
  }
  try {
    fs.writeFileSync(bundle, src, "utf8");
  } catch (exc) {
    // A write that dies halfway (a full disk) leaves a truncated bundle, and
    // the checks below only run after a write that finished. Put the original
    // back now: a missing button beats a chat that does not open.
    let restored = "restored from backup";
    try {
      fs.copyFileSync(backup, bundle);
    } catch {
      restored = "could not restore it either; if the chat does not open, run --revert";
    }
    throw new Fatal(`writing the bundle failed (${exc.message}) - ${restored}`);
  }

  // Re-read what actually landed on disk: catches truncated/garbled writes.
  const written = fs.readFileSync(bundle, "utf8");
  const missing = buttons.map(([id]) => id).filter((id) => !written.includes(btnMarker(id)));
  if (missing.length || written.length !== expectedLen) {
    fs.copyFileSync(backup, bundle);
    throw new Fatal(`post-write check failed (missing=${JSON.stringify(missing)}) - bundle restored from backup`);
  }
  const err2 = checkSyntax(written);
  if (err2) {
    fs.copyFileSync(backup, bundle);
    throw new Fatal(`written bundle does not parse - restored from backup:\n${err2}`);
  }

  console.log(`  [w] written ${bundle} (+${added} bytes, verified on disk)`);
  writeLedger(extensionVersion(bundle), {
    date: new Date().toISOString().slice(0, 10),
    symbols: lay.symbols(),
    // What the bundle actually carries now, not what this run asked for: an
    // earlier run's buttons are still in there and belong in the record, and a
    // `usage` button that went in as a plain label is recorded as `run`.
    buttons: describeButtons(markersIn(written), [...buttons, ...all], extensionVersion(bundle)),
    side,
    sha1_pristine: sha1(original),
  });
}

/* ------------------------------------------------------------------ ensure */

/**
 * Quiet self-heal, meant to be wired to a Claude Code SessionStart hook: an
 * extension update replaces the whole directory and takes the patch with it,
 * and this puts it back without anyone having to notice.
 *
 * It is built to cost nothing on the overwhelmingly common path - nothing
 * changed since last time:
 *
 *   - the state cache holds size+mtime of every bundle we patched, so the check
 *     is a handful of stat() calls; the 5 MB bundle is not read at all,
 *   - only a bundle whose fingerprint moved (i.e. an update landed) is opened -
 *     or every bundle once after this script itself changed, since a new
 *     version may read a build the old one could not,
 *   - a button that went in without its ring is swapped for the full one as
 *     soon as the script can draw it (see staleButtons),
 *   - it prints nothing when there is nothing to do, and never exits non-zero:
 *     a hook that fails loudly on every session start would be worse than the
 *     problem it solves. What needs a human - no button, or no ring - goes to
 *     the agent once per build (see reportToAgent), not every session.
 *
 * A lock keeps two editor windows starting at once from writing the same file.
 */
function ensureBundles(bundles, roots, buttons, side) {
  const wanted = buttons.map(([id]) => id);
  const cached = new Map((readJson(STATE_FILE, {}).bundles || []).map((b) => [b.path, b]));
  const me = patcherId();

  const suspect = bundles.filter((bundle) => {
    const known = cached.get(bundle);
    if (!known || known.checkedBy !== me) return true;
    const stamp = fileStamp(bundle);
    if (stamp.size !== known.size || stamp.mtimeMs !== known.mtimeMs) return true;
    if (known.refused) return false; // already refused and reported; nothing changed since
    if (!known.patched) return true;
    return !wanted.every((id) => (known.buttons || []).includes(id));
  });

  if (suspect.length === 0) return 0; // fast path: stat only, nothing read

  return withLock(() => {
    // Bundles we do not touch keep what is known about them: saveState carries
    // it over while their files are unchanged.
    const facts = new Map();
    const notes = [];
    for (const bundle of suspect) {
      const version = extensionVersion(bundle);
      try {
        const [original] = pristineSource(bundle);
        let src = fs.readFileSync(bundle, "utf8");
        const complete = wanted.every((id) => src.includes(btnMarker(id)));
        if (!complete || staleButtons(src, original, buttons).length) {
          if (!verifyQuietly(bundle, buttons)) {
            const ids = markersIn(src);
            facts.set(bundle, { patched: ids.length > 0, buttons: ids, refused: true, checkedBy: me });
            notes.push(refusedNote(version, complete));
            continue;
          }
          patchQuietly(bundle, buttons, side);
          src = fs.readFileSync(bundle, "utf8");
        }
        facts.set(bundle, { patched: true, buttons: markersIn(src), refused: false, checkedBy: me });
        for (const [id, , mode] of buttons) {
          const level = describeLevel(src, id);
          if (mode === "usage" && (level === "plain" || level === "count")) notes.push(degradedNote(version, id, level));
        }
      } catch (exc) {
        // Read-only extension folder, a deleted backup: nothing that fixes itself
        // by the next session start. Report once, like a refusal; a new file or
        // a new version of this script brings it up again.
        facts.set(bundle, { refused: true, checkedBy: me });
        notes.push(
          `${NOTE_TAG} ${path.basename(extensionDir(bundle))}: ${exc.message}. ` +
            "Tell the user in one line and offer to look into it with the vscode-claude-chat-context-meter skill."
        );
      }
    }
    saveState(bundles, roots, facts);
    reportToAgent(notes);
    return 0;
  });
}

const NOTE_TAG = "[vscode-claude-chat-context-meter]";

function refusedNote(version, hadButton) {
  return (
    `${NOTE_TAG} Claude Code ${version} rewrote the chat toolbar, so the context button ` +
    (hadButton ? "could not be brought up to date" : "was not put back after the update") +
    ". Tell the user in one line and offer to fix it with the vscode-claude-chat-context-meter skill " +
    "(--verify first, then step 3 of its protocol)."
  );
}

function degradedNote(version, id, level) {
  const what =
    level === "plain"
      ? "a plain label, no count and no ring: the skill cannot read this build's usage signal"
      : "the count without its ring: the usage signal is read, but the skill cannot place the ring on this build";
  return (
    `${NOTE_TAG} On Claude Code ${version} the '${id}' button shows ${what}. ` +
    "Tell the user in one line and offer to fix it with the " +
    "vscode-claude-chat-context-meter skill (step 3 of its protocol). Once the skill reads the build " +
    "again, the next session start puts the ring back by itself."
  );
}

/**
 * Hand what needs a human to the agent. The hook runs in the background, and a
 * background hook has one way back: the JSON response's `systemMessage`, which
 * Claude Code gives to Claude on the next turn. Checked with two canaries in
 * one headless session: the JSON one reached the model, plain stdout did not -
 * so the plain "button restored" line printed here before never reached anyone.
 * One JSON object on stdout, and nothing else there; nothing when all is well.
 */
function reportToAgent(notes) {
  if (notes.length === 0) return;
  process.stdout.write(JSON.stringify({ systemMessage: notes.join("\n") }) + "\n");
}

/** Preflight without the report: same checks, no output. */
function verifyQuietly(bundle, buttons) {
  try {
    const [original] = pristineSource(bundle);
    const lay = new Layout(original);
    return checkSyntax(applyEdits(original, trialEdits(lay, buttons))) === null;
  } catch (exc) {
    if (exc instanceof LayoutError) return false;
    throw exc;
  }
}

/** patchBundle with its progress chatter muted; errors still propagate. */
function patchQuietly(bundle, buttons, side) {
  const log = console.log;
  console.log = () => {};
  try {
    patchBundle(bundle, buttons, side, false);
  } finally {
    console.log = log;
  }
}

/**
 * Run `fn` while holding a lock file; return 0 without running it if someone
 * else holds it. Several editor windows can start sessions at the same moment,
 * and two processes rewriting one bundle is the one way this patch could
 * actually damage something.
 */
function withLock(fn) {
  const lock = path.join(STATE_DIR, "vscode-claude-chat-context-meter.lock");
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  } catch {}
  let fd;
  try {
    fd = fs.openSync(lock, "wx");
  } catch {
    let age = Infinity;
    try {
      age = Date.now() - fs.statSync(lock).mtimeMs;
    } catch {}
    if (age < 120000) return 0; // another run is on it
    try {
      fs.unlinkSync(lock); // stale (a run was killed mid-flight)
      fd = fs.openSync(lock, "wx");
    } catch {
      return 0;
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
    try {
      fs.unlinkSync(lock);
    } catch {}
  }
}

/* -------------------------------------------------------------- auto-heal */

// The hook is a Claude Code feature, so it goes into Claude Code's own settings.
// CCM_STATE_DIR moves it along with the rest of the state, which is what makes a
// dry run against a sandbox directory possible.
const SETTINGS_FILE = path.join(STATE_DIR, "settings.json");
const SELF = path.join(HERE, "patch_claude_code_ui.mjs");

let patcherIdMemo = null;

/**
 * Identity of this very script, kept per bundle in the state cache as
 * `checkedBy`. A skill update does not touch the bundle, so its fingerprint
 * cannot tell --ensure that a newer script might now read a build (or draw a
 * ring) the old one could not. Only a run that did the stale check (--ensure,
 * or an actual patch) writes it: a --status or --verify must not vouch for a
 * bundle it never looked at that way.
 */
function patcherId() {
  if (patcherIdMemo === null) {
    try {
      patcherIdMemo = sha1(fs.readFileSync(SELF, "utf8"));
    } catch {
      patcherIdMemo = "unknown";
    }
  }
  return patcherIdMemo;
}
// How our entry is recognised among the user's other hooks, on any platform.
const HOOK_TAG = "patch_claude_code_ui.mjs";

/**
 * How to invoke `--ensure` from a hook on this machine.
 *
 * Exec form (`command` + `args`) when we are running under a real Node: no
 * shell is involved, so the path cannot be mangled by quoting rules. Under
 * VS Code's bundled Electron that form is unavailable (it needs
 * ELECTRON_RUN_AS_NODE in the environment), so fall back to the runner script.
 */
function ensureInvocation() {
  if (!process.versions.electron && isFile(process.execPath)) {
    return { command: process.execPath, args: [SELF, "--ensure"] };
  }
  if (process.platform === "win32") {
    return {
      command: `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${path.join(HERE, "run.ps1")}" --ensure`,
    };
  }
  return { command: `sh "${path.join(HERE, "run.sh")}" --ensure` };
}

function hookEntry() {
  return {
    type: "command",
    ...ensureInvocation(),
    // Background: the session must not wait on us, ever.
    async: true,
    timeout: 120,
  };
}

function isOurHook(entry) {
  return JSON.stringify(entry || {}).includes(HOOK_TAG);
}

/** Add (or refresh) the SessionStart hook that keeps the button alive. */
function installHook(dryRun) {
  const settings = readJson(SETTINGS_FILE, null);
  if (settings === null && isFile(SETTINGS_FILE)) {
    throw new Fatal(`${SETTINGS_FILE} is not valid JSON - fix it first, refusing to overwrite`);
  }
  const next = settings || {};
  next.hooks = next.hooks || {};
  const groups = Array.isArray(next.hooks.SessionStart) ? next.hooks.SessionStart : [];

  let replaced = false;
  for (const group of groups) {
    const hooks = Array.isArray(group.hooks) ? group.hooks : [];
    for (let i = 0; i < hooks.length; i += 1) {
      if (isOurHook(hooks[i])) {
        hooks[i] = hookEntry();
        replaced = true;
      }
    }
  }
  if (!replaced) groups.push({ hooks: [hookEntry()] });
  next.hooks.SessionStart = groups;

  const json = JSON.stringify(next, null, 2) + "\n";
  JSON.parse(json); // never hand back something Claude Code cannot read

  if (dryRun) {
    console.log(`  [dry-run] would ${replaced ? "refresh" : "add"} the SessionStart hook in ${SETTINGS_FILE}`);
    return;
  }
  backupSettingsOnce();
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, json, "utf8");
  console.log(`  [+] SessionStart hook ${replaced ? "refreshed" : "added"} in ${SETTINGS_FILE}`);
  console.log("      it runs --ensure in the background on session start (~80 ms, silent when there is nothing to do)");
}

/**
 * Copy settings.json aside before the first write we ever make to it - and only
 * the first: the backup is worth having because it predates us, so a second run
 * must not overwrite it with a file that already carries our hook.
 */
function backupSettingsOnce() {
  const backup = SETTINGS_FILE + ".ccm.bak";
  if (isFile(SETTINGS_FILE) && !isFile(backup)) fs.copyFileSync(SETTINGS_FILE, backup);
}

/** Remove our SessionStart hook, leaving every other hook untouched. */
function uninstallHook(dryRun) {
  const settings = readJson(SETTINGS_FILE, null);
  if (!settings || !settings.hooks || !Array.isArray(settings.hooks.SessionStart)) {
    console.log("  [=] no SessionStart hook to remove");
    return;
  }
  let removed = 0;
  const groups = [];
  for (const group of settings.hooks.SessionStart) {
    const hooks = (group.hooks || []).filter((h) => {
      if (!isOurHook(h)) return true;
      removed += 1;
      return false;
    });
    if (hooks.length) groups.push({ ...group, hooks });
  }
  if (!removed) {
    console.log("  [=] no hook of ours in SessionStart");
    return;
  }
  if (groups.length) settings.hooks.SessionStart = groups;
  else delete settings.hooks.SessionStart;

  if (dryRun) {
    console.log(`  [dry-run] would remove ${removed} hook(s) from ${SETTINGS_FILE}`);
    return;
  }
  backupSettingsOnce();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n", "utf8");
  console.log(`  [-] removed ${removed} hook(s) from ${SETTINGS_FILE}`);
}

/** One line for --status: is the self-heal hook wired up? */
function hookState() {
  const settings = readJson(SETTINGS_FILE, null);
  const groups = (settings && settings.hooks && settings.hooks.SessionStart) || [];
  for (const group of groups) {
    for (const entry of group.hooks || []) if (isOurHook(entry)) return "installed";
  }
  return "not installed (run --install-hook)";
}

/** Button ids the bundle currently carries, in the order they appear. */
function markersIn(src) {
  return [...src.matchAll(/\/\*CC-BTN:(\w+)\*\//g)].map((m) => m[1]);
}

/**
 * Full `id:/text:mode` specs for the buttons present. This run knows its own;
 * ones added earlier are looked up in the ledger, and fall back to a bare id.
 */
function describeButtons(presentIds, buttons, version) {
  const specs = new Map(buttons.map(([id, text, mode]) => [id, `${id}:${text}:${mode}`])); // last one wins
  const previous = readLedger()[version];
  for (const spec of (previous && previous.buttons) || []) {
    const id = String(spec).split(":")[0];
    if (!specs.has(id)) specs.set(id, spec);
  }
  return presentIds.map((id) => specs.get(id) || id);
}

function revertBundle(bundle) {
  const backup = backupOf(bundle);
  if (!isFile(backup)) {
    console.log("  [!] no backup next to this bundle, nothing to restore");
    return;
  }
  if (ANY_MARKER.test(fs.readFileSync(backup, "utf8"))) {
    throw new Fatal(`${path.basename(backup)} contains patch markers - refusing to restore a patched 'original'`);
  }
  fs.copyFileSync(backup, bundle);
  fs.unlinkSync(backup);
  console.log(`  [-] restored from backup, ${path.basename(backup)} removed`);
}

function statusBundle(bundle, buttons) {
  const src = fs.readFileSync(bundle, "utf8");
  const found = markersIn(src);
  const known = readLedger()[extensionVersion(bundle)];
  const hits = countOccurrences(src, ANCHOR);
  console.log(`  version: ${extensionVersion(bundle)}` + (known ? ` (last patched ${known.date})` : " (not in ledger)"));
  const listed = found.map((id) => `${id} (${LEVEL_TEXT[describeLevel(src, id)] || describeLevel(src, id)})`);
  console.log(`  buttons: ${found.length ? listed.join(", ") : "(none - unpatched)"}`);
  if (found.length) {
    let stale = [];
    try {
      stale = staleButtons(src, pristineSource(bundle)[0], buttons).map(([id]) => id);
    } catch (exc) {
      if (!(exc instanceof LayoutError)) throw exc;
    }
    if (stale.length) {
      console.log(`  upgrade: ${stale.join(", ")} can show more on this build - run the patch again, or let the hook do it`);
    }
  }
  console.log(`  run mode: ${src.includes(RUN_MARKER) ? "wired" : "no"}`);
  console.log(`  backup:  ${isFile(backupOf(bundle)) ? "yes" : "no"}`);
  console.log(`  anchor:  ${hits === 1 ? "ok" : `${hits} hits - LAYOUT CHANGED`}`);
  console.log(`  self-heal hook: ${hookState()}`);
}

/* ------------------------------------------------------------------- entry */

/** Parse 'id:/text' or 'id:/text:mode' into [id, text, mode]. */
function parseButton(spec) {
  let parts = spec.split(":");
  if (parts.length < 2) throw new Fatal(`expected 'id:/text[:mode]', got ${JSON.stringify(spec)}`);
  // `run`, not `usage`: the live figure is the context window, which only makes
  // sense on a /context button. Ask for it explicitly on anything else.
  let mode = "run";
  if (parts.length > 2 && MODES.includes(parts[parts.length - 1])) {
    mode = parts[parts.length - 1];
    parts = parts.slice(0, -1);
  }
  const buttonId = parts[0].trim();
  const text = parts.slice(1).join(":").trim();
  if (!/^\w+$/.test(buttonId) || !text) throw new Fatal(`bad button spec ${JSON.stringify(spec)}`);
  // The text is spliced into a double-quoted literal in the generated code. A
  // quote, a backslash or a newline would break it; the syntax check catches
  // that before anything is written, but a plain refusal here says why.
  if (/["\\\r\n]/.test(text)) {
    throw new Fatal(`button text may not contain quotes, backslashes or newlines: ${JSON.stringify(text)}`);
  }
  return [buttonId, text, mode];
}

const HELP = `Add buttons to the Claude Code chat composer (VS Code and forks).

  --verify                 preflight this build; writes nothing but the path cache
  --ensure                 quiet self-heal (for a SessionStart hook): re-patch
                           when an extension update wiped the button, and put
                           the ring back on one that went in without it
  --install-hook           wire --ensure to a SessionStart hook, so the button
                           comes back by itself after a Claude Code update
  --uninstall-hook         remove that hook again
  --status                 report installed extensions and patch state
  --where                  show runtime, extension roots and bundles found
  --revert                 restore the original bundle from backup
  --reapply                revert, then patch again from the clean original
  --dry-run                resolve and validate, but do not write
  --side SLOT              slash (default) | left | right
  --button ID:/TEXT[:MODE] button to inject (repeatable)
                           MODE = usage (run + live ring and count, "◔ 184k")
                                | run | insert
  --ext-dir PATH           extra extensions directory to search
  --forget                 drop this machine's cached paths
  -h, --help               this text

Env: CCM_EXT_DIR, CCM_EXT_DIR_EXTRA (extra extensions dirs, path-list),
     CCM_STATE_DIR (where local state and the hook's settings.json live).`;

function parseArgs(argv) {
  const opts = {
    buttons: [],
    side: "slash",
    verify: false,
    revert: false,
    reapply: false,
    status: false,
    dryRun: false,
    where: false,
    forget: false,
    ensure: false,
    installHook: false,
    uninstallHook: false,
    extraRoots: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const need = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Fatal(`${arg} needs a value`);
      i += 1;
      return v;
    };
    switch (arg) {
      case "--button":
        opts.buttons.push(parseButton(need()));
        break;
      case "--side":
        opts.side = need();
        if (!["slash", "left", "right"].includes(opts.side)) throw new Fatal(`bad --side ${JSON.stringify(opts.side)}`);
        break;
      case "--ext-dir":
        opts.extraRoots.push(path.resolve(need()));
        break;
      case "--verify":
        opts.verify = true;
        break;
      case "--ensure":
        opts.ensure = true;
        break;
      case "--install-hook":
        opts.installHook = true;
        break;
      case "--uninstall-hook":
        opts.uninstallHook = true;
        break;
      case "--revert":
        opts.revert = true;
        break;
      case "--reapply":
        opts.reapply = true;
        break;
      case "--status":
        opts.status = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--where":
        opts.where = true;
        break;
      case "--forget":
        opts.forget = true;
        break;
      case "-h":
      case "--help":
        console.log(HELP);
        process.exit(0);
      default:
        throw new Fatal(`unknown argument ${JSON.stringify(arg)} (try --help)`);
    }
  }
  // One id, one button: a repeated id would splice two buttons into one hole.
  const ids = opts.buttons.map(([id]) => id);
  const twice = ids.find((id, i) => ids.indexOf(id) !== i);
  if (twice) throw new Fatal(`button id ${JSON.stringify(twice)} given twice - every --button needs its own id`);
  return opts;
}

function main(argv) {
  const opts = parseArgs(argv);

  if (opts.forget) {
    forgetState();
    return 0;
  }

  if (opts.installHook || opts.uninstallHook) {
    if (opts.installHook) installHook(opts.dryRun);
    if (opts.uninstallHook) uninstallHook(opts.dryRun);
    return 0;
  }

  const roots = [...opts.extraRoots.filter(isDir), ...extensionRoots()].filter(
    (p, i, all) => all.indexOf(p) === i
  );
  const bundles = findBundles(roots);
  const buttons = opts.buttons.length ? opts.buttons : DEFAULT_BUTTONS;

  // Before anything that prints: a hook must stay silent and must not fail the
  // session start, even when no editor is installed at all.
  if (opts.ensure) {
    // --ensure exists to write; a "rehearsal" of it would patch for real.
    if (opts.dryRun) throw new Fatal("--ensure cannot be rehearsed - use --verify, or --dry-run without --ensure");
    if (bundles.length === 0) return 0;
    return ensureBundles(bundles, roots, buttons, opts.side);
  }

  if (opts.where) {
    console.log(`  runtime: ${process.execPath}${process.versions.electron ? " (VS Code's Electron)" : ""}`);
    console.log(`  node:    ${process.versions.node}   platform: ${process.platform}-${process.arch}`);
    console.log(`  state:   ${STATE_FILE}`);
    console.log("  roots:");
    for (const r of roots) console.log(`    ${r}`);
    console.log("  bundles:");
    for (const b of bundles) console.log(`    ${b}  (v${extensionVersion(b)})`);
    if (!bundles.length) console.log("    (none)");
    saveState(bundles, roots);
    return bundles.length ? 0 : 1;
  }

  if (bundles.length === 0) {
    console.error("No Claude Code extension found under:");
    for (const root of roots) console.error(`  ${root}`);
    console.error("Pass --ext-dir <path> (or set CCM_EXT_DIR) if the editor keeps extensions elsewhere.");
    return 1;
  }

  const checked = new Set(); // bundles this run patched, i.e. put through the stale check
  let failed = false;
  for (const bundle of bundles) {
    console.log(path.basename(extensionDir(bundle)));
    try {
      if (opts.verify) {
        failed = !verifyBundle(bundle, buttons) || failed;
      } else if (opts.status) {
        statusBundle(bundle, buttons);
      } else if (opts.revert) {
        // --dry-run means "write nothing", and that has to hold for the
        // destructive commands too, not just for patching.
        if (opts.dryRun) console.log("  [dry-run] would restore the original from backup");
        else revertBundle(bundle);
      } else {
        if (opts.reapply) {
          if (opts.dryRun) console.log("  [dry-run] would restore the original from backup first");
          else revertBundle(bundle);
        }
        // --reapply always builds on the pristine original: after a real revert
        // that is what is on disk anyway, and in a dry run it is what lets the
        // rehearsal show the actual plan instead of "already present".
        patchBundle(bundle, buttons, opts.side, opts.dryRun, opts.reapply ? "pristine" : "current");
        if (!opts.dryRun) checked.add(bundle);
      }
    } catch (exc) {
      if (!(exc instanceof LayoutError)) throw exc;
      console.log(`  ABORTED: ${exc.message}\n  -> nothing was written; see SKILL.md before patching by hand`);
      failed = true;
    }
  }

  // Record what each bundle carries now, so the next --ensure can trust its
  // stat-only fast path instead of re-reading megabytes.
  const facts = new Map();
  if (!opts.dryRun) {
    for (const bundle of bundles) {
      try {
        const present = markersIn(fs.readFileSync(bundle, "utf8"));
        // Undefined keeps the previous value (see saveState).
        const checkedBy = checked.has(bundle) ? patcherId() : undefined;
        facts.set(bundle, { patched: present.length > 0, buttons: present, checkedBy });
      } catch {}
    }
  }
  saveState(bundles, roots, facts);

  if (!(opts.status || opts.verify || opts.dryRun) && !failed) {
    console.log("\nReload VS Code to pick up the change: Ctrl+Shift+P -> 'Developer: Reload Window'");
  }
  return failed ? 1 : 0;
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (err) {
  if (err instanceof Fatal) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
