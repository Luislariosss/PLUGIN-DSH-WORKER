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
| `dsh_delegate` | Manda una tarea a DSH y espera el resultado final (texto autosuficiente). `wait_seconds` por defecto 600 s (máx. 3600; `0` = no esperar). La sesión es real, se ve en el GUI de DSH y su Lead puede usar `spawn_teammate` / `team_task_*`. |
| `dsh_followup` | Sigue el mismo hilo de DSH con otra instrucción. |
| `dsh_result` / `dsh_status` / `dsh_list` | Recogen y consultan el estado del trabajo delegado. |
| `dsh_watch` | **Monitoreo activo**: se queda bloqueada hasta que DSH entregue (o pida aprobación) y te despierta con la entrega. Con `task_id` vigila esa tarea; sin él, vigila todas las activas. Al expirar sin entrega devuelve el estado: llama otra vez en vez de terminar la sesión. |
| `dsh_cancel` | Cancela una tarea que sigue corriendo. |
| `dsh_inbox` | Lista los avisos de finalización pendientes (`done`, `error`, `waiting-input`, `cancelled`) y los marca como leídos (salvo `ack: false`). |

Y el **aviso de terminado** + **monitoreo activo**: `dsh_delegate` espera el resultado si le das
`wait_seconds` (600 s por defecto). Para trabajo largo, deja `wait_seconds: 0` y llama a
`dsh_watch`: se queda bloqueada (hasta 3600 s) y te **despierta con la entrega**, sin que tengas
que revisar a mano. Al expirar sin entrega devuelve el estado y vuelves a llamarla. Si el trabajo
se dejó en segundo plano sin vigilar, los avisos llegan en tu **siguiente mensaje** mediante el
único hook que se instala, `UserPromptSubmit` (el comando lleva el marcador `--dsh-bridge-hook`),
o puedes leerlos con `dsh_inbox`. `additionalContext` solo es válido en ese evento, así que no se
instala en `Stop`; si te queda un hook de `Stop` de una versión anterior, el instalador lo quita y
`notify.mjs` lo ignora. La skill `dsh-worker` (en `skills/`) define el protocolo de monitoreo.

## Instalación

### 1. Plugin en DeepSeek Harness

En DSH: página **Plugins → instalar desde carpeta**, apuntando a `<repo>/plugin`. O con el
gestor de plugins del Host:

```
plugin_manager install_bundle  target: <ruta-absoluta>/plugin
```

Al activarse escribe en `%USERPROFILE%\.dsh\claude-bridge` (o en `bridgeDir`, ver
[Configuración](#configuración-del-plugin)) los archivos `token`, `state.json`, `events.jsonl` y
`tasks.json` (ver [Estado y persistencia](#estado-y-persistencia)). Escucha en
`http://127.0.0.1:49777` (loopback, con token; si el puerto está ocupado prueba 49778…49786).

### 2. MCP + hook + permisos en Claude Code

Con DSH abierto (para que el plugin responda):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<repo>\scripts\install-claude.ps1"
```

El instalador:

- registra el MCP `dsh-bridge` a nivel usuario (`claude mcp add --scope user --transport stdio …`);
- añade el hook `UserPromptSubmit` (con marcador `--dsh-bridge-hook`) en `~/.claude/settings.json`
  y **8 reglas por herramienta**: `mcp__dsh-bridge__dsh_delegate`, `mcp__dsh-bridge__dsh_list`,
  `mcp__dsh-bridge__dsh_status`, `mcp__dsh-bridge__dsh_result`, `mcp__dsh-bridge__dsh_followup`,
  `mcp__dsh-bridge__dsh_cancel` y `mcp__dsh-bridge__dsh_inbox`. No autoriza el servidor MCP entero.
  El merge se hace en Node (conserva otros hooks y no escribe BOM). Reinstalar es idempotente: quita
  hooks propios duplicados o viejos de `Stop` y migra la regla antigua `mcp__dsh-bridge`, que
  autorizaba todo el MCP;
- añade el bloque gestionado `<!-- dsh-bridge:start -->…<!-- dsh-bridge:end -->` en
  `~/.claude/CLAUDE.md` para que Claude sepa cuándo delegar.

`settings.json` y `CLAUDE.md` se respaldan como `.bak-<timestamp>` antes de tocarlos.

### 3. Verificar

```powershell
claude mcp list                       # dsh-bridge debe salir Connected
node "<repo>\mcp\selftest.mjs"        # tools/list sin necesitar DSH
node "<repo>\tests\e2e.mjs"           # HTTP del plugin contra DSH (requiere DSH abierto)
node "<repo>\tests\mcp-e2e.mjs"       # MCP completo contra DSH (requiere DSH abierto)
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

### 4. Desinstalar

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<repo>\scripts\uninstall-claude.ps1"
```

Quita el MCP `dsh-bridge`, el hook, las reglas `mcp__dsh-bridge__dsh_*` (y la regla antigua
`mcp__dsh-bridge`) y el bloque de `CLAUDE.md`, con backups `.bak-<timestamp>`. No toca el plugin de
DSH: quítalo desde **Plugins** en DSH. Tampoco borra la carpeta `%USERPROFILE%\.dsh\claude-bridge`.

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
luego Claude puede consultar `dsh_result` / `dsh_status`, leer `dsh_inbox`, o recibir el aviso en
tu siguiente mensaje.

## Configuración del plugin

En `~/.dsh/profiles/desktop/cordis.patch.yml` (o en la fila del plugin). Los valores por defecto
son los de `readSettings` en `plugin/index.js`; un valor no válido se sustituye por su default.

```yaml
- id: claude-bridge
  name: '@local/dsh-claude-bridge'
  config:
    port: 49777                 # default 49777; si está ocupado prueba los 9 siguientes
    host: 127.0.0.1             # default 127.0.0.1; solo loopback, no lo cambies a 0.0.0.0
    bridgeDir: 'C:\Users\<usuario>\.dsh\claude-bridge'   # default %USERPROFILE%\.dsh\claude-bridge
    defaultCwd: null            # default null: si la petición no manda cwd, el del proceso de DSH
    agentPreset: null           # default null = preset por defecto del perfil
    permission: null            # null = no tocar; 'workspace-write' | 'danger-full-access' (requiere allowFullAccess: true)
    allowFullAccess: false      # true = admitir 'danger-full-access', ya sea en la petición o en permission de esta config
    maxConcurrent: 4            # default 4; con esas tareas en curso, una nueva recibe 409
    clientTimeZone: America/Mexico_City   # default America/Mexico_City
    maxTaskMs: 21600000         # default 6 h; pasado ese tiempo la tarea se marca error
```

El MCP lee `state.json`/`token` de la carpeta del puente con una caché de 2 s y la vuelve a leer si
falla la conexión; si el plugin se reinicia en otro puerto se entera solo. Se puede forzar otra
carpeta con la variable de entorno `DSH_BRIDGE_DIR` (la leen el MCP y el hook).

## Estado y persistencia

- Las tareas se guardan en `<bridgeDir>\tasks.json` (escritura atómica, con un pequeño retardo) y
  sobreviven a reinicios de DSH. Se guardan las **200 tareas más recientes**.
- El archivo contiene **prompts y resultados** de las tareas (puede pesar varios MB), por eso está en
  `.gitignore`. Lo mismo para `token`, `state.json`, `events.jsonl` y `cursor.json`.
- Al arrancar, las tareas finales (`done`, `error`, `cancelled`) se restauran tal cual, así que
  `dsh_result` sigue devolviendo su resultado. Las que estaban en curso se reevalúan; si su sesión de
  DSH ya no existe, se cierran con error.
- `events.jsonl` guarda un evento por aviso de finalización (solo se añade) y `cursor.json` el último
  aviso ya leído.

## Seguridad

- El plugin escucha **solo en 127.0.0.1** y exige `Authorization: Bearer <token>`; el token vive en
  `%USERPROFILE%\.dsh\claude-bridge\token` con permisos del usuario.
- No expone puertos a la red ni ejecuta comandos arbitrarios: solo crea sesiones de DSH, envía
  prompts y seguimientos, consulta estado y cancela tareas (las tools de DSH siguen su propio sandbox
  y aprobaciones).
- Las sesiones delegadas usan el preset de permisos del perfil (`workspace-write` por defecto).
- El permiso **efectivo** de una sesión (el `permission` de la petición o, si no viene, el de la config)
  se valida antes de crear la sesión: si es `danger-full-access` y no hay `allowFullAccess: true`, se
  rechaza con **403** (`permission/forbidden`). Esto cubre tanto la petición como la config del plugin.
  Es un ajuste explícito de Luis; no lo actives por defecto.
- El permiso de Claude Code se concede **por herramienta** (las 8 reglas `mcp__dsh-bridge__dsh_*`
  listadas en la instalación), no a todo el servidor MCP: una herramienta nueva que se añada al MCP
  pedirá confirmación.
- Si una sesión pide aprobación, se responde en el **GUI de DSH**; la tarea queda
  `waiting-input` y Claude Code lo ve.
- **No delegues secretos ni credenciales** en el texto de la tarea.

## Solución de problemas

- **`state.json` no existe** (o el MCP dice que el plugin no está corriendo): el plugin no está
  activo. Abre DeepSeek Harness o instala/activa el plugin.
- **HTTP 401**: token desincronizado. Borra `token` y reinicia DSH; se regenera.
- **HTTP 403 `permission/forbidden`**: se pidió `danger-full-access` sin `allowFullAccess: true`.
- **HTTP 409 `tasks/too-many-running`**: ya hay `maxConcurrent` tareas en curso. Espera o cancela una.
- **La tarea sigue `running` mucho rato**: consulta `/v1/_diag?sessionId=…` (ver arriba) para ver si
  hay `turn/end`; revisa también el modelo por defecto del perfil de DSH. Tras `maxTaskMs` se marca
  error.
- **No llegan avisos**: se entregan en el siguiente mensaje o con `dsh_inbox`. Revisa
  `events.jsonl` y `cursor.json` en la carpeta del puente.
- **Regla de permiso antigua (`mcp__dsh-bridge` a secas)**: vuelve a ejecutar `install-claude.ps1`;
  migra la regla a las 8 reglas por herramienta.
- **Tests**: ejecútalos desde la raíz del repo con `node tests\…`. `selftest.mjs` no necesita DSH;
  `e2e.mjs` y `mcp-e2e.mjs` sí.

## Estructura del repo

| Ruta | Qué es |
|---|---|
| `plugin/` | Bundle DSH (`@local/dsh-claude-bridge`): servidor HTTP local + puente a `sessionController`. |
| `mcp/` | Servidor MCP stdio para Claude Code (`server.mjs`), hook de avisos (`notify.mjs`), `selftest.mjs`. |
| `scripts/` | `install-claude.ps1` / `uninstall-claude.ps1` + merges de settings/CLAUDE.md en Node. |
| `skills/dsh-worker/` | Skill que define el protocolo de monitoreo activo (delegar + `dsh_watch` hasta la entrega). |
| `tests/` | `e2e.mjs` (HTTP), `mcp-e2e.mjs` (MCP completo), `debug-once.mjs` (diagnóstico). |
| `docs/PROTOCOL.md` | Contrato congelado entre las tres piezas. |
| `docs/PARA-QUE-SIRVE.md` | Casos de uso, límites y estado verificado. |

## Desarrollo

El plugin se instala como enlace al directorio. Un cambio en `plugin/index.js` **no** se recarga
solo de forma garantizada: reinstala el bundle (Plugins → quitar + instalar, o
`remove_bundle` + `install_bundle`) para que el Host importe el módulo nuevo. Algunos builds de DSH
pueden recargarlo al tocar `~/.dsh/profiles/desktop/cordis.patch.yml` (HMR del perfil), pero no
está verificado; si lo pruebas en tu build, anótalo aquí.

Contrato interno (endpoints, estados, eventos, tools MCP): [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

## Límites conocidos

- Claude Code **no acepta mensajes entrantes** en una sesión interactiva: el aviso se entrega como
  resultado de una tool o como `additionalContext` del hook `UserPromptSubmit` (en el siguiente
  mensaje), nunca despertando una sesión idle.
- Si DSH está cerrado, el MCP devuelve un error claro.
- Cada tarea deja una sesión visible en el GUI de DSH (se puede archivar ahí).
- Win-11 únicamente en esta versión (rutas y scripts PowerShell).

## Licencia

MIT — ver [LICENSE](LICENSE).
