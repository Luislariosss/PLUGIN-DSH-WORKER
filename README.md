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
`dsh_delegate`; si el trabajo se dejó en segundo plano, un hook de Claude Code
(`UserPromptSubmit`, marcado con `--dsh-bridge-hook`) inyecta el aviso "DSH terminó X" en tu
siguiente mensaje. `additionalContext` solo es válido en ese evento, así que no se instala en
`Stop`; si te queda uno viejo, el instalador lo quita y `notify.mjs` lo ignora.

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
- añade el hook `UserPromptSubmit` (con marcador `--dsh-bridge-hook`) y los permisos **por
  herramienta** `mcp__dsh-bridge__dsh_delegate`, `…__dsh_list`, `…__dsh_status`, `…__dsh_result`,
  `…__dsh_followup`, `…__dsh_cancel`, `…__dsh_inbox` en `~/.claude/settings.json` (merge en Node,
  sin romper otros hooks ni escribir BOM; reinstalar es idempotente, quita hooks duplicados o
  viejos de `Stop`, y migra la regla antigua `mcp__dsh-bridge` que autorizaba todo el MCP);
- añade el bloque gestionado `<!-- dsh-bridge:start -->…<!-- dsh-bridge:end -->` en
  `~/.claude/CLAUDE.md` para que Claude sepa cuándo delegar.

### 3. Verificar

```powershell
claude mcp list                       # dsh-bridge debe salir Connected
node "<repo>\mcp\selftest.mjs"        # tools/list sin necesitar DSH
node "<repo>\tests\e2e.mjs"           # HTTP del plugin contra DSH
node "<repo>\tests\mcp-e2e.mjs"       # MCP completo contra DSH
```

Sin Claude Code de por medio, el puente se comprueba solo con HTTP:

```powershell
$dir = "$env:USERPROFILE\.dsh\claude-bridge"
$s = Get-Content "$dir\state.json" | ConvertFrom-Json
$t = (Get-Content "$dir\token").Trim()
Invoke-RestMethod "http://$($s.host):$($s.port)/v1/health" -Headers @{ Authorization = "Bearer $t" }
```

`/v1/_diag?sessionId=<id>` devuelve, además de la cola durable de esa sesión, la superficie real de
`sessionController` en tu build (ver [Compatibilidad](#compatibilidad-con-versiones-de-dsh)).

> Nota: si lanzas `claude mcp list` **dentro** del sandbox de DSH, los servidores MCP stdio pueden
> salir como `Failed to connect — EPERM`; es el sandbox bloqueando la creación de pipes para
> procesos hijos, no el puente. Fuera de él salen `Connected`.

## Compatibilidad con versiones de DSH

El plugin habla con el servicio `sessionController` del Host, y su superficie cambia entre builds de
DeepSeek Harness. `plugin/index.js` detecta en caliente qué métodos existen
(`typeof ctx.sessionController.x === 'function'`) y usa el camino que haya:

| Necesidad | Contrato original (`docs/PROTOCOL.md`) | Builds 0.2.x (`dsh-api-session-controller`) |
|---|---|---|
| Crear sesión / admitir prompt / cancelar | `create()`, `prompt()`, `cancel()` | igual |
| Cola durable de la sesión | `events({ address, maxMessages })` | `inspect(sessionId, signal)` → `{ meta, events }` |
| Señal viva (¿corriendo? ¿cola?) | `state({ sessionId })` → `{ running, pendingInput, queue }` | fila de `list({})` → `{ running, agentAvailable, … }` |
| Esperar el final | `wait({ sessionId, timeoutMs })` | sondeo de `inspect()`/`list()` |

No hay que configurar nada: el mismo bundle sirve para ambos. Si tu build no expone
`state`/`wait`/`events`, el puente cierra la tarea con la evidencia durable (`turn/end` +
último `assistant/message`) y usa `list()` para saber si la sesión sigue viva, en vez de marcar
error "La sesión de DSH ya no está viva".

Qué expone tu DSH ahora mismo:

```powershell
$dir = "$env:USERPROFILE\.dsh\claude-bridge"
$s = Get-Content "$dir\state.json" | ConvertFrom-Json
$t = (Get-Content "$dir\token").Trim()
$d = Invoke-RestMethod "http://$($s.host):$($s.port)/v1/_diag?sessionId=$([guid]::NewGuid())" -Headers @{ Authorization = "Bearer $t" }
$d.api    # { create: 'function', inspect: 'function', state: 'undefined', … }
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
    allowFullAccess: false      # true = admitir permission 'danger-full-access' en las peticiones
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
- `permission: 'danger-full-access'` en una petición se rechaza con **403** (`permission/forbidden`)
  salvo que pongas `allowFullAccess: true` en la config del plugin. Es un ajuste explícito de Luis;
  no lo actives por defecto.
- El permiso de Claude Code se concede **por herramienta** (`mcp__dsh-bridge__dsh_*`), no a todo el
  servidor MCP: una herramienta nueva que se añada al MCP pedirá confirmación.
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

El plugin se instala como enlace al directorio. Al editar `plugin/index.js`, el **HMR del perfil**
sustituye el módulo en la siguiente recomposición: basta tocar
`~/.dsh/profiles/desktop/cordis.patch.yml` (por ejemplo, añadiendo y quitando un comentario
`# reload`) para que el Host cargue el código nuevo **sin reiniciar DSH**. Si el cambio toca
`package.json`, `cordis.patch.yml` del bundle o la lista de bundles del perfil, usa el gestor de
plugins (`remove_bundle` + `install_bundle`).

Contrato interno (endpoints, estados, eventos, tools MCP): [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

## Límites conocidos

- Claude Code **no acepta mensajes entrantes** en una sesión interactiva: el aviso se entrega como
  resultado del tool o como `additionalContext` de los hooks, nunca despertando una sesión idle.
- Si DSH está cerrado, el MCP devuelve un error claro.
- Cada tarea deja una sesión visible en el GUI de DSH (se puede archivar ahí).
- Win-11 únicamente en esta versión (rutas y scripts PowerShell).

## Licencia

MIT — ver [LICENSE](LICENSE).
