# When the layout changed (`UNSAFE` / `LAYOUT CHANGED`)

Read this when `--verify` refused: the toolbar was rewritten in a new extension
build, and the job is to find the new anchor and re-teach it to the `Layout` class
in the patcher.

Recon is read-only — write nothing. Start from the paths the skill itself resolved,
rather than guessing an editor home: `--where` prints the bundle and the Node-capable
runtime it uses, and both are needed below (a machine with no `node` on PATH is the
normal case here — that is the whole point of the runners).

Without `sh`, the same first step reads
`powershell -NoProfile -ExecutionPolicy Bypass -File run.ps1 --where`; the recon
commands below then need a POSIX shell of their own, so on such a machine hand
the two paths to whatever search tool the agent does have.

```bash
sh run.sh --where
#   runtime: <node or the editor binary>      ← RUNTIME below
#   bundles: <…>/webview/index.js (v2.1.226)  ← BUNDLE below
BUNDLE=…; RUNTIME=…                           # copy the two paths out of that output

grep -o 'title:"[^"]\{0,40\}"' "$BUNDLE" | sort | uniq -c | head -40   # button tooltips → the new anchor
grep -o 'commandRegistry[^;]\{0,80\}' "$BUNDLE" | head                 # is the command registry still there?

# the toolbar in context; ELECTRON_RUN_AS_NODE lets the editor binary stand in for node
ELECTRON_RUN_AS_NODE=1 "$RUNTIME" -e "const s=require('fs').readFileSync(process.argv[1],'utf8'),i=s.indexOf('inputFooter');console.log(JSON.stringify(s.slice(i-200,i+1500)))" "$BUNDLE"
```

On PowerShell there is no `grep`: use `Select-String -Pattern 'title:"[^"]{0,40}"'
-AllMatches` over the same file, or run the whole recon from Git Bash.

You need: (1) a unique string constant next to the toolbar → the new `ANCHOR` in
the script, (2) `children:[<helper>(` before it, (3) the button element containing
the anchor — the `slash` slot is measured from it, (4) the same
`findCommandByLabel`/`executeCommand` in the registry (without them only `insert`
mode remains). All of the binding lives in the `Layout` class — nothing else in the
script needs touching. After editing: `--verify` again, and only then patch.

Whatever you re-teach here is an edit to **someone's installed copy** of the skill,
which may be a git clone or managed by an installer that overwrites it on the next
update. Treat it as local and temporary, say what you changed, and offer to send it
upstream as an issue or a pull request — see step 3 of the protocol in `SKILL.md`.
