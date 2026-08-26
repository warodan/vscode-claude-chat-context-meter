<#
Run the patcher with whatever Node-capable runtime this machine has (Windows).

There is no install step: if `node` is missing, VS Code's own Electron binary is
used as Node (ELECTRON_RUN_AS_NODE=1). Anyone patching the Claude Code extension
necessarily has that editor installed.

Search order: $env:CCM_NODE -> node on PATH -> cached hint -> known editor
install paths. The winner is cached so the next run is instant.

Usage:
  powershell -ExecutionPolicy Bypass -File run.ps1 --verify
  powershell -ExecutionPolicy Bypass -File run.ps1 --button ctx:/context
#>
[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $here 'patch_claude_code_ui.mjs'
if (-not (Test-Path -LiteralPath $script)) {
    Write-Error 'patch_claude_code_ui.mjs not found next to run.ps1'
    exit 1
}

$stateDir = if ($env:CCM_STATE_DIR) { $env:CCM_STATE_DIR } else { Join-Path $HOME '.claude' }
$hint = Join-Path $stateDir 'vscode-claude-chat-context-meter.runtime'

# A candidate qualifies only if it actually behaves like Node: in Node mode both
# `node` and Electron answer `--version` with `vX.Y.Z`, while a plain editor
# binary prints its own version without the leading `v`.
function Test-Runtime([string]$exe) {
    if ([string]::IsNullOrWhiteSpace($exe)) { return $false }
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { return $false }
    $prevEA = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    try {
        $env:ELECTRON_RUN_AS_NODE = '1'
        $out = (& $exe --version 2>&1 | Out-String).Trim()
        return ($out -match '^v\d+\.\d+')
    } catch {
        return $false
    } finally {
        $ErrorActionPreference = $prevEA
    }
}

$candidates = New-Object System.Collections.Generic.List[string]

if ($env:CCM_NODE) { $candidates.Add($env:CCM_NODE) }

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) { $candidates.Add($nodeCmd.Source) }

if (Test-Path -LiteralPath $hint) {
    try {
        $cached = @(Get-Content -LiteralPath $hint -TotalCount 1)
        if ($cached.Count -gt 0 -and $cached[0].Trim()) { $candidates.Add($cached[0].Trim()) }
    } catch {
        # An unreadable or empty cache is not an error, just a cold start.
    }
}

$local = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME 'AppData\Local' }
foreach ($p in @(
    (Join-Path $local 'Programs\Microsoft VS Code\Code.exe'),
    (Join-Path $local 'Programs\Microsoft VS Code Insiders\Code - Insiders.exe'),
    (Join-Path $local 'Programs\cursor\Cursor.exe'),
    (Join-Path $local 'Programs\Windsurf\Windsurf.exe'),
    (Join-Path $local 'Programs\VSCodium\VSCodium.exe'),
    'C:\Program Files\Microsoft VS Code\Code.exe',
    'C:\Program Files\Microsoft VS Code Insiders\Code - Insiders.exe',
    'C:\Program Files (x86)\Microsoft VS Code\Code.exe',
    'C:\Program Files\VSCodium\VSCodium.exe'
)) { $candidates.Add($p) }

# Installed somewhere unusual: derive the binary from the `code` launcher.
$codeCmd = Get-Command code -ErrorAction SilentlyContinue
if ($codeCmd -and $codeCmd.Source) {
    $root = Split-Path -Parent (Split-Path -Parent $codeCmd.Source)
    foreach ($name in @('Code.exe', 'Code - Insiders.exe', 'VSCodium.exe', 'Cursor.exe')) {
        $candidates.Add((Join-Path $root $name))
    }
}

$runtime = $null
foreach ($cand in $candidates) {
    if (Test-Runtime $cand) { $runtime = $cand; break }
}

if (-not $runtime) {
    [Console]::Error.WriteLine(@'
No Node-capable runtime found.

Tried: $env:CCM_NODE, `node` on PATH, the cached runtime, and the usual
VS Code / VSCodium / Cursor / Windsurf install paths.

Fix: point the script at your editor binary, e.g.
  $env:CCM_NODE = "C:\Path\To\Code.exe"
(any Electron-based editor works: it is started with ELECTRON_RUN_AS_NODE=1),
or install Node.js.
'@)
    exit 1
}

try {
    New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
    # UTF-8 without BOM: the path may contain non-ASCII (a user name in another
    # script), and a BOM would end up inside the path run.sh reads back.
    [System.IO.File]::WriteAllText($hint, $runtime + "`n", (New-Object System.Text.UTF8Encoding($false)))
} catch {
    # The cache is a convenience; never fail the run over it.
}

$env:ELECTRON_RUN_AS_NODE = '1'
if ($Rest) { & $runtime $script @Rest } else { & $runtime $script }
exit $LASTEXITCODE
