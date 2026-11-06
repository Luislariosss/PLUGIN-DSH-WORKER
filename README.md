# PLUGIN-DSH-WORKER

**Puente Claude Code ⇄ DeepSeek Harness (DSH).** Deja que Claude Code delegue trabajo a DSH y
que DSH lo ejecute con sus **workers (Agent Teams)**. Cuando DSH termina, Claude recibe el
resultado y un aviso.

```
Claude Code (CLI, cualquier carpeta)
   │  MCP stdio:  dsh_delegate / dsh_status / dsh_followup / dsh_inbox …
   ▼
dsh-bridge  (mcp/server.mjs — Node, sin dependencias)
   │  HTTP 127.0.0.1 + token Bearer
   ▼
plugin @local/dsh-claude-bridge  (dentro de DSH, perfil "desktop")
   │  sessionController / sessions / permissionPresets
   ▼
Sesión real de DSH en su GUI  →  su Lead puede usar Agent Teams (workers)
```

- Licencia: MIT
- Plataforma: Windows 11 (Node 24+, Claude Code 2.1+, DeepSeek Harness Desktop)
- Autor: [Luis Larios](https://github.com/Luislariosss)

## ¿Qué gana Claude Code?

| Tool MCP | Qué hace |
|---|---|
| `dsh_delegate` | Manda una tarea a DSH y espera el resultado final (texto autosuficiente). La sesión es real, se ve en el GUI de DSH y su Lead puede usar `spawn_teammate` / `team_task_*`. |
| `dsh_followup` | Sigue el mismo hilo de DSH con otra instrucción. |
| `dsh_result` / `dsh_status` / `dsh_list` | Recogen y consultan el estado del trabajo delegado. |
| `dsh_cancel` | Cancela una tarea que sigue corriendo. |
| `dsh_inbox` | Lista los avisos de tareas terminadas. |

Y el **aviso de terminado**: cuando DSH acaba, el resultado vuelve en la propia llamada
`dsh_delegate`; si el trabajo se dejó en segundo plano, dos hooks de Claude Code
(`UserPromptSubmit` y `Stop`) inyectan el aviso "DSH terminó X" en el siguiente turno.

## Instalación

### 1. Plugin en DeepSeek Harness

En DSH: página **Plugins → instalar desde carpeta**, apuntando a `<repo>/plugin`. O con el
gestor de plugins del Host:

```
plugin_manager install_bundle  target: <ruta-absoluta>/plugin
```

Al activarse escribe `%USERPROFILE%\.dsh\claude-bridge\{token,state.json}` y escucha en
`http://127.0.0.1:49777` (loopback, con token; si el puerto está ocupado prueba 49778…49786).

### 2. MCP + hooks en Claude Code

Con DSH abierto (para que el plugin responda):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<repo>\scripts\install-claude.ps1"
```

Con backups `.bak-<timestamp>`:

- registra el MCP `dsh-bridge` a nivel usuario (`claude mcp add --transport stdio …`);
- añade los hooks `UserPromptSubmit` y `Stop` y el permiso `mcp__dsh-bridge` en
  `~/.claude/settings.json` (merge en Node, sin romper otros hooks ni escribir BOM);
- añade el bloque gestionado `<!-- dsh-bridge:start -->…<!-- dsh-bridge:end -->` en
  `~/.claude/CLAUDE.md` para que Claude sepa cuándo delegar.

### 3. Verificar

```powershell
claude mcp list                       # dsh-bridge debe salir Connected
node "<repo>\mcp\selftest.mjs"        # tools/list sin necesitar DSH
node "<repo>\tests\e2e.mjs"           # HTTP del plugin contra DSH
node "<repo>\tests\mcp-e2e.mjs"       # MCP completo contra DSH
```

## Uso

En Claude Code, en cualquier carpeta:

> "Pásale a DSH: revisa el proyecto X y hazme un informe de los TODOs pendientes y luego un commit."

> "Delega en DSH la migración de tests de X; espera el resultado y luego haz el commit."

Claude llama a `dsh_delegate`; la tarea aparece en DSH como una sesión nueva, su Lead decide si
usa Agent Teams, y al terminar devuelve un resumen que Claude continúa usando.

Para trabajo largo en segundo plano: `dsh_delegate` con `wait_seconds: 0` devuelve el `task_id`;
luego Claude puede consultar `dsh_result` / `dsh_status`, o dejar que el aviso llegue por hooks.

## Configuración del plugin

En `~/.dsh/profiles/desktop/cordis.patch.yml` (o en la fila del plugin):

```yaml
- id: claude-bridge
  name: '@local/dsh-claude-bridge'
  config:
    port: 49777                 # puerto base
    host: 127.0.0.1             # solo loopback; no lo cambies a 0.0.0.0
    bridgeDir: 'C:\Users\<usuario>\.dsh\claude-bridge'
    defaultCwd: null            # cwd si la petición no manda uno
    agentPreset: null           # null = preset por defecto del perfil
    permission: null            # null = no tocar; 'workspace-write' | 'danger-full-access'
    maxConcurrent: 4
    clientTimeZone: America/Mexico_City
    maxTaskMs: 21600000         # 6 h
```

El MCP lee `state.json`/`token` en cada llamada; si el plugin se reinicia en otro puerto se entera
solo. Se puede forzar otra carpeta con `DSH_BRIDGE_DIR`.

## Seguridad

- El plugin escucha **solo en 127.0.0.1** y exige `Authorization: Bearer <token>`; el token vive en
  `%USERPROFILE%\.dsh\claude-bridge\token` con permisos del usuario.
- No expone puertos a la red ni ejecuta comandos arbitrarios desde el token: solo el MCP local
  puede llamar, y solo crea sesiones/prompts (las tools de DSH siguen su propio sandbox y
  aprobaciones).
- Las sesiones delegadas usan el preset de permisos del perfil (`workspace-write` por defecto).
- Si una sesión pide aprobación, se responde en el **GUI de DSH**; la tarea queda
  `waiting-input` y Claude Code lo ve.
- **No delegues secretos ni credenciales** en el texto de la tarea.

## Estructura del repo

| Ruta | Qué es |
|---|---|
| `plugin/` | Bundle DSH (`@local/dsh-claude-bridge`): servidor HTTP local + puente a `sessionController`. |
| `mcp/` | Servidor MCP stdio para Claude Code (`server.mjs`), hook de avisos (`notify.mjs`), `selftest.mjs`. |
| `scripts/` | `install-claude.ps1` / `uninstall-claude.ps1` + merges de settings/CLAUDE.md en Node. |
| `tests/` | `e2e.mjs` (HTTP), `mcp-e2e.mjs` (MCP completo), `debug-once.mjs` (diagnóstico). |
| `docs/PROTOCOL.md` | Contrato congelado entre las tres piezas. |
| `docs/PARA-QUE-SIRVE.md` | Casos de uso, límites y estado verificado. |

## Desarrollo

El plugin se instala como enlace al directorio: si editas `plugin/index.js` hay que reinstalar el
bundle (`plugin_manager remove_bundle` + `install_bundle`) para que el Host cargue el módulo nuevo.

Contrato interno (endpoints, estados, eventos, tools MCP): [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

## Límites conocidos

- Claude Code **no acepta mensajes entrantes** en una sesión interactiva: el aviso se entrega como
  resultado del tool o como `additionalContext` de los hooks, nunca despertando una sesión idle.
- Si DSH está cerrado, el MCP devuelve un error claro.
- Cada tarea deja una sesión visible en el GUI de DSH (se puede archivar ahí).
- Win-11 únicamente en esta versión (rutas y scripts PowerShell).

## Licencia

MIT — ver [LICENSE](LICENSE).
