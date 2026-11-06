# scripts — instalación del lado Claude Code

## Instalación

Con **DeepSeek Harness abierto** (para que el plugin responda) y Claude Code en el PATH:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\luisl\Downloads\SQL\dsh-claude-bridge\scripts\install-claude.ps1"
```

Opciones: `-SkipHealthCheck` (no comprobar el puente), `-SkipHooks` (no tocar
`~/.claude/settings.json`), `-SkipClaudeMd` (no tocar `~/.claude/CLAUDE.md`).

Hace, con backups `.bak-<timestamp>`:

1. `claude mcp remove --scope user dsh-bridge` (best-effort) y
   `claude mcp add --scope user --transport stdio dsh-bridge -- <node> <mcp/server.mjs>`.
2. `node scripts/merge-claude-settings.mjs install <mcp/notify.mjs>`: añade el hook
   `UserPromptSubmit` (marcado con `--dsh-bridge-hook`) y los permisos por herramienta
   `mcp__dsh-bridge__dsh_*` (quita la regla antigua `mcp__dsh-bridge`) a
   `~/.claude/settings.json`, conservando todo lo demás (no rompe arrays de un solo elemento;
   no escribe BOM). El instalador solo registra el hook `UserPromptSubmit`; los avisos llegan
   en tu siguiente mensaje (o con `dsh_inbox`). Reinstalar es idempotente: quita los hooks
   propios (también los viejos de `Stop`) y deja uno solo, con la ruta actual.
3. Añade/actualiza el bloque `<!-- dsh-bridge:start --> … <!-- dsh-bridge:end -->` en
   `~/.claude/CLAUDE.md` con las instrucciones para delegar.

## Verificación

```powershell
claude mcp list                      # dsh-bridge debe salir "Connected"
claude mcp get dsh-bridge
node "..\mcp\selftest.mjs"           # tools/list sin necesitar DSH
node "..\tests\e2e.mjs"              # HTTP del plugin contra DSH
node "..\tests\mcp-e2e.mjs"          # MCP completo contra DSH
```

En Claude Code:

> "Pásale a DSH: revisa la carpeta X y devuélveme un resumen."

## Desinstalación

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\luisl\Downloads\SQL\dsh-claude-bridge\scripts\uninstall-claude.ps1"
```

Quita el MCP, los hooks, el permiso y el bloque de CLAUDE.md (con backups). El plugin de DSH se
quita desde la página Plugins de DSH.

## Por qué dos scripts

- `merge-claude-settings.mjs` hace la fusión JSON con Node: preserva la forma exacta que espera
  Claude Code (`hooks.<evento>[].hooks[]`) y evita el BOM de PowerShell 5.1.
- `install-claude.ps1` orquesta: comprobar entorno, registrar el MCP y llamar al merge.
