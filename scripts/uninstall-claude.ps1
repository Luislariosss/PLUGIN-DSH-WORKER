<#
.SYNOPSIS
    Desinstala el puente Claude Code <-> DeepSeek Harness de Claude Code.

.DESCRIPTION
    - Quita el MCP `dsh-bridge` (scope user).
    - Quita los hooks de aviso y los permisos mcp__dsh-bridge__dsh_* (y la regla antigua
      mcp__dsh-bridge) de ~/.claude/settings.json, y el `crossSessionInbound: "accept"`
      que puso el instalador.
    - Quita el bloque gestionado del CLAUDE.md.
    Hace backups .bak-<timestamp>. No toca el plugin de DSH (quítalo desde la página Plugins).
#>
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$mergeSettings = Join-Path $root 'scripts\merge-claude-settings.mjs'
$mergeMd = Join-Path $root 'scripts\merge-claude-md.mjs'

function Write-Step([string]$text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok([string]$text) { Write-Host "OK  $text" -ForegroundColor Green }

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw 'node no está en PATH.' }
$nodePath = $nodeCmd.Source

Write-Step 'Quitando el MCP dsh-bridge de Claude Code'
$claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
if ($claudeCmd) {
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & claude mcp remove --scope user dsh-bridge 2>&1 | Out-Host
    $removeExit = $LASTEXITCODE
    $ErrorActionPreference = $previousEap
    if ($removeExit -eq 0) { Write-Ok 'MCP eliminado' } else { Write-Host 'El MCP no estaba registrado o no se pudo quitar.' -ForegroundColor Yellow }
} else {
    Write-Host 'claude no está en PATH; no puedo quitar el MCP.' -ForegroundColor Yellow
}

Write-Step 'Quitando hooks y permiso del puente'
& $nodePath $mergeSettings uninstall
if ($LASTEXITCODE -ne 0) { Write-Host 'No se pudieron quitar los hooks (¿settings.json inválido?).' -ForegroundColor Yellow }

Write-Step 'Quitando el bloque de CLAUDE.md'
& $nodePath $mergeMd uninstall
if ($LASTEXITCODE -ne 0) { Write-Host 'No se pudo limpiar CLAUDE.md.' -ForegroundColor Yellow }

Write-Host ''
Write-Host 'Desinstalado de Claude Code. El plugin de DSH sigue instalado: quítalo desde Plugins en DSH.' -ForegroundColor Green
