<#
.SYNOPSIS
    Instala el puente Claude Code <-> DeepSeek Harness en Claude Code (MCP + hooks + CLAUDE.md).

.DESCRIPTION
    - Registra el servidor MCP `dsh-bridge` a nivel usuario (scope user).
    - Añade hooks UserPromptSubmit y Stop para que los avisos de "DSH terminó" lleguen a Claude.
    - Añade el permiso mcp__dsh-bridge para no preguntar en cada llamada.
    - Añade un bloque gestionado en ~/.claude/CLAUDE.md explicando cuándo delegar.
    Hace backups .bak-<timestamp>. No instala el plugin de DSH: eso se hace desde la página
    Plugins de DSH (o con el gestor de plugins del Host).

.PARAMETER SkipHealthCheck
    No comprobar que el plugin del puente responda (útil si DSH está cerrado).

.PARAMETER SkipHooks
    No tocar ~/.claude/settings.json.

.PARAMETER SkipClaudeMd
    No tocar ~/.claude/CLAUDE.md.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-claude.ps1
#>
param(
    [switch]$SkipHealthCheck,
    [switch]$SkipHooks,
    [switch]$SkipClaudeMd
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$serverPath = Join-Path $root 'mcp\server.mjs'
$notifyPath = Join-Path $root 'mcp\notify.mjs'
$mergeSettings = Join-Path $root 'scripts\merge-claude-settings.mjs'
$mergeMd = Join-Path $root 'scripts\merge-claude-md.mjs'

function Write-Step([string]$text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok([string]$text) { Write-Host "OK  $text" -ForegroundColor Green }
function Write-Warn([string]$text) { Write-Host "WARN $text" -ForegroundColor Yellow }

foreach ($file in @($serverPath, $notifyPath, $mergeSettings, $mergeMd)) {
    if (-not (Test-Path $file)) { throw "No encuentro $file (¿carpeta del proyecto movida?)" }
}

Write-Step 'Comprobando herramientas'
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw 'node no está en PATH. Instala Node 24+ y vuelve a intentarlo.' }
$nodePath = $nodeCmd.Source
Write-Ok "node: $nodePath"

$claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claudeCmd) { throw 'claude no está en PATH. Instala Claude Code y vuelve a intentarlo.' }
Write-Ok "claude: $($claudeCmd.Source)"

if (-not $SkipHealthCheck) {
    Write-Step 'Comprobando el plugin del puente en DeepSeek Harness'
    $bridgeDir = Join-Path $env:USERPROFILE '.dsh\claude-bridge'
    $stateFile = Join-Path $bridgeDir 'state.json'
    $tokenFile = Join-Path $bridgeDir 'token'
    $healthy = $false
    if ((Test-Path $stateFile) -and (Test-Path $tokenFile)) {
        try {
            $state = Get-Content $stateFile -Raw | ConvertFrom-Json
            $token = (Get-Content $tokenFile -Raw).Trim()
            $health = Invoke-RestMethod -Uri "http://$($state.host):$($state.port)/v1/health" -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 5
            $healthy = $true
            Write-Ok "puente activo en http://$($state.host):$($state.port) (pid $($health.pid))"
        } catch {
            Write-Warn "el puente no respondió: $($_.Exception.Message)"
        }
    } else {
        Write-Warn "no existe $stateFile (¿plugin instalado y DSH abierto?)"
    }
    if (-not $healthy) {
        Write-Warn 'Claude Code quedará configurado igual; arranca DeepSeek Harness con el plugin para que funcione.'
    }
}

Write-Step 'Registrando el MCP dsh-bridge en Claude Code (scope user)'
# Windows PowerShell 5.1 convierte el stderr de un .exe en error terminante; el remove
# es best-effort (puede no existir todavía). `add-json` rompe el JSON al pasar por
# PowerShell, así que usamos `add --transport`.
$previousEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
& claude mcp remove --scope user dsh-bridge 2>&1 | Out-Null
& claude mcp add --scope user --transport stdio dsh-bridge -- $nodePath $serverPath 2>&1 | Out-Host
$addExit = $LASTEXITCODE
$ErrorActionPreference = $previousEap
if ($addExit -ne 0) { throw "claude mcp add falló con código $addExit" }
Write-Ok 'MCP dsh-bridge registrado'
& claude mcp get dsh-bridge 2>&1 | Out-Host

if (-not $SkipHooks) {
    Write-Step 'Instalando hooks de aviso (UserPromptSubmit y Stop) y permiso mcp__dsh-bridge'
    & $nodePath $mergeSettings install $notifyPath
    if ($LASTEXITCODE -ne 0) { throw "merge-claude-settings.mjs falló con código $LASTEXITCODE" }
    Write-Ok 'settings.json actualizado (con backup)'
}

if (-not $SkipClaudeMd) {
    Write-Step 'Añadiendo instrucciones de delegación a ~/.claude/CLAUDE.md'
    & $nodePath $mergeMd install
    if ($LASTEXITCODE -ne 0) { throw "merge-claude-md.mjs falló con código $LASTEXITCODE" }
    Write-Ok 'CLAUDE.md actualizado (con backup)'
}

Write-Host ''
Write-Host 'LISTO. Verifica con:' -ForegroundColor Green
Write-Host '  claude mcp list'
Write-Host 'Y en Claude Code prueba:' -ForegroundColor Green
Write-Host '  "Pasale a DSH: responde solo con la palabra PUENTE_OK"'
Write-Host ''
Write-Host 'Para deshacerlo: scripts\uninstall-claude.ps1' -ForegroundColor DarkGray
