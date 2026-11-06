# Protocolo del puente Claude Code ⇄ DeepSeek Harness

Contrato **congelado** entre los tres componentes. Cualquier cambio aquí lo anuncian quien lo
haga; los demás no se desvían del documento.

```
Claude Code (CLI, cualquier consola)
   │  MCP stdio
   ▼
dsh-bridge (mcp/server.mjs, Node, sin dependencias)
   │  HTTP 127.0.0.1 + Bearer token
   ▼
plugin Host @local/dsh-claude-bridge  (dentro de DSH Desktop, perfil "desktop")
   │  ctx.sessionController / ctx.sessions / ctx.agents / ctx.permissionPresets
   ▼
Sesión real de DSH visible en el GUI (con Agent Teams disponibles)
```

Objetivo: Claude Code delega una tarea, DSH la ejecuta (puede usar sus workers/Agent Teams) y
Claude recibe el resultado y los avisos de finalización.

## 1. Archivos y rutas

`BRIDGE_DIR` por defecto: `%USERPROFILE%\.dsh\claude-bridge`
(override por env `DSH_BRIDGE_DIR` en el MCP; por `config.bridgeDir` en el plugin).

| Archivo | Quién escribe | Contenido |
|---|---|---|
| `token` | plugin (si no existe) | 64 chars hex + `\n`. Modo usuario. |
| `state.json` | plugin al arrancar / dispose | `{ "version": 1, "host": "127.0.0.1", "port": 49777, "pid": 1234, "startedAt": 1762... }` |
| `events.jsonl` | plugin | una línea JSON por evento de finalización (append-only) |
| `cursor.json` | MCP (`dsh_inbox`, hook) | `{ "ackedSeq": 12 }` |
| `tasks.json` | plugin (debounce ~300 ms, escritura atómica) | `{ "version": 1, "savedAt": 1762..., "tasks": Task[] }` con las 200 tareas más recientes (ver §2.1) |

El plugin borra `state.json` en dispose. Si `state.json` no existe o el health check falla, el
MCP debe responder con un error claro: *"El plugin dsh-claude-bridge no está corriendo en
DeepSeek Harness (abre/actualiza DSH Desktop e inténtalo otra vez)."*

Endpoint: `http://127.0.0.1:<port>`; el plugin escucha **solo loopback**.
Autenticación: header `Authorization: Bearer <token>`. Sin token correcto → HTTP 401.

## 2. API HTTP del plugin

Todas las respuestas son JSON UTF-8. Errores: HTTP 400/401/404/409/500 con
`{ "error": { "code": "string", "message": "string" } }`.

### Tipos

```ts
type TaskStatus =
  | 'queued'          // creada, prompt aún no admitido
  | 'running'         // el agente está trabajando
  | 'waiting-input'   // el agente pide aprobación/pregunta en el GUI
  | 'done'            // terminó; result disponible
  | 'error'           // falló; error disponible
  | 'cancelled'       // cancelada

interface Task {
  taskId: string          // 'tsk_<12 hex>'
  sessionId: string       // id real de la sesión DSH
  status: TaskStatus
  prompt: string          // prompt original sin envolver
  cwd: string
  preset: string | null
  permission: string | null
  workers: boolean
  client: string          // 'claude-code' u otro
  createdAt: number       // epoch ms
  updatedAt: number
  completedAt?: number
  turns: number           // turnos observados
  result?: { text: string; truncated?: boolean }
  error?: { message: string }
}

interface BridgeEvent {
  seq: number
  kind: 'done' | 'error' | 'waiting-input' | 'cancelled'
  taskId: string
  sessionId: string
  summary: string         // ≤ 2000 chars, texto plano
  at: number
}
```

### Endpoints

| Método y ruta | Body | Respuesta |
|---|---|---|
| `GET /v1/health` | — | `{ ok: true, version: "1.0.0", pid, port, startedAt, tasks: { total, running, done, error } }` |
| `POST /v1/tasks` | `{ prompt, cwd?, preset?, permission?, workers?, client? }` | `Task` (201) |
| `GET /v1/tasks` | — | `{ tasks: Task[] }` (máx. 100, más recientes primero) |
| `GET /v1/tasks/:id` | — | `Task` |
| `POST /v1/tasks/:id/wait` | `{ timeoutMs?: number }` | `Task` — bloquea hasta estado final o timeout |
| `POST /v1/tasks/:id/messages` | `{ text: string }` | `Task` (follow-up al mismo hilo; vuelve a `running`) |
| `POST /v1/tasks/:id/cancel` | — | `Task` (status `cancelled`) |
| `GET /v1/events?since=<seq>` | — | `{ events: BridgeEvent[], lastSeq: number }` |
| `POST /v1/events/ack` | `{ seq: number }` | `{ ackedSeq: number }` |
| `GET /v1/_diag?sessionId=<id>` | — | `{ live, state, tailTypes, lastAssistant, liveLastAssistant }` (diagnóstico) |

Reglas:
- `prompt` obligatorio, 1..60 000 chars. `cwd` si se omite = `config.defaultCwd` o el cwd del
  proceso Host. Debe ser ruta absoluta existente; si no existe → 400.
- `permission` opcional: `workspace-write` o `danger-full-access`. Omitido (y sin config) = no
  tocar el preset del perfil, que ya arranca en `workspace-write`.
- Se valida el permiso **efectivo**: `body.permission ?? config.permission`. Si es
  `danger-full-access` y el plugin no tiene `allowFullAccess: true` (default `false`) → **403**
  `permission/forbidden`. Se valida antes de crear la sesión. Si el origen es la config, el mensaje
  indica que `permission` de la config también requiere `allowFullAccess: true`. Al arrancar, si la
  config tiene `permission: 'danger-full-access'` sin `allowFullAccess`, el plugin escribe un aviso en log.
- `preset` opcional: id de agent preset de DSH; omitido = preset por defecto del perfil.
- `workers` default `true`: el prompt enviado a DSH incluye la instrucción de usar Agent Teams.
- `turns` empieza en 1 al crear la tarea y sube con cada follow-up. La tarea se cierra cuando la
  cola durable muestra un `turn/end` con `turn >= turns` (así no se cierra por el turno viejo).
- Seguimientos (`POST /v1/tasks/:id/messages`): al enviar el prompt la tarea pasa a `running` y
  el puente guarda, solo internamente, `followupAt` (epoch ms) y `lastResultText` (el `result.text`
  del turno anterior). Un cierre **sin** evidencia durable (fallback de `state()`/`list()` con el
  último texto del asistente) no se acepta si el texto es igual a `lastResultText` o si han pasado
  menos de 2 s desde `followupAt`. Un `turn/end` con `turn >= turns` sí cierra la tarea. Ambos
  campos se limpian al finalizar. No aparecen en `Task`.
- Máximo de tareas `running` simultáneas: `config.maxConcurrent` (default 4) → 409.
- `wait` con `timeoutMs` limitado a 1..120000; default 25000. Si la tarea sigue `running`,
  responde `Task` sin finalizar (el cliente vuelve a llamar).
- La sesión es **real y visible** en DSH: aparece en la lista de sesiones y en el GUI.
- Un `turn/end` o idle del agente marca la tarea `done` y escribe **un** evento `done` en
  `events.jsonl` con `summary` = últimos ≤2000 chars del texto final.

### 2.1 Persistencia de tareas (`tasks.json`)

- El plugin guarda el Map de tareas en `<bridgeDir>\tasks.json` para que sobreviva a un reinicio
  de DSH. Se escribe cuando una tarea se crea o cambia de estado (`queued/running/waiting-input`
  → final, `running` tras un seguimiento, etc.), con debounce de ~300 ms.
- La escritura es atómica: se escribe `tasks.json.<pid>.<hex>.tmp` y luego `rename` sobre
  `tasks.json`. Si falla, se registra en el log y el archivo anterior queda intacto.
- Se guardan solo las **200 tareas más recientes** (por `createdAt`). Como `result.text` puede
  ser grande, el archivo puede pesar varios MB.
- Al `start()` se carga el archivo, se descartan entradas con forma inválida y se repuebla el Map.
  Las tareas `queued`/`running`/`waiting-input` se conservan para que el poller (`settle`) las
  reevalúe; `queued` se trata como `running` porque el poller no sondea `queued`. Si la sesión
  de DSH ya no existe, el camino existente la cierra con error (`La sesión de DSH ya no está viva`).
- Las tareas finales (`done/error/cancelled`) se restauran tal cual: `dsh_result` sigue
  devolviendo su resultado tras reiniciar.
- `tasks.json` está en `.gitignore`: contiene texto de tareas y resultados.

## 3. Implementación del plugin Host

Archivo `plugin/index.js`, ESM, **solo builtins de Node** (`node:http`, `node:fs`,
`node:fs/promises`, `node:path`, `node:os`, `node:crypto`). No importar paquetes
`@deepseek-ai/*`.

```js
export const name = 'claude-bridge'
export const inject = ['sessionController', 'sessions']
export function apply(ctx, config) { /* … */ }
```

No registres tools del Harness: `defineTool` vive en `@deepseek-ai/dsh-tools`, que no está
garantizado desde un bundle instalado en el perfil. La activación se comprueba con
`GET /v1/health` y con `Config.listConfigs` (Lead).

Config (sin `Config` schema; se lee defensivamente):

```
port: 49777
host: '127.0.0.1'
bridgeDir: '%USERPROFILE%\.dsh\claude-bridge'
defaultCwd: null
agentPreset: null
permission: null            // null = no tocar; si no, 'workspace-write' | 'danger-full-access' (requiere allowFullAccess: true)
allowFullAccess: false      // true = admitir 'danger-full-access' en POST /v1/tasks (petición o config)
maxConcurrent: 4
clientTimeZone: 'America/Mexico_City'
```

Servicios que usa:

- `ctx.sessionController.create({ cwd, agentPreset? })` → `{ sessionId, agentPreset? }`
- `ctx.permissionPresets.set(session, name)` (solo si `permission` y el servicio existen; se
  obtiene con `ctx.get('permissionPresets')`; `session` = `ctx.sessions.get(sessionId)`)
- `ctx.sessionController.prompt({ requestId, sessionId, mode: 'queue',
  content: [{ type: 'text', text }], clientTimeZone })`
- `ctx.sessionController.wait({ sessionId, timeoutMs, afterSeq, maxMessages: 200 })` →
  `{ reason: 'idle' | 'input-required' | 'timeout', state, output }`
- `ctx.sessionController.cancel({ sessionId })`
- `ctx.sessionController.state({ sessionId })` → `{ active, running, pendingInput, queue }`
- Final: `ctx.sessions.get(sessionId)?.deriveMessages()` → `Message[]`; tomar el último con
  `role === 'assistant'` y concatenar los bloques `content[].type === 'text'` (`content[].text`).
  Tambi���n aceptar `{ type: 'text', text }` o string. Si no hay, `expires` → `result.text = ''`.

**Disponibilidad real según el build.** Con `@deepseek-ai/dsh-api-session-controller` (DSH 0.2.x)
existen `create`, `prompt` y `cancel`, pero **no** `events`, `state` ni `wait`. El plugin comprueba
`typeof ctx.sessionController.x === 'function'` y, si faltan, usa:

- `inspect(sessionId, signal)` → `{ meta, inheritedEventCount, events }` en lugar de `events()`;
- la fila de `list({})` → `{ running, agentAvailable, … }` como señal viva en lugar de `state()`;
- sondeo con `settle()` en lugar de `wait()`.

La tarea se cierra con la evidencia durable (`turn/end` + último `assistant/message`) y la fila de
`list()` decide si la sesión sigue viva. El contrato HTTP y las tools MCP no cambian: es una
adaptación interna del plugin Host.

Comportamiento:
- Crear servidor HTTP en `apply` con `http.createServer`, `server.listen(port, host)`, y
  registrarlo con `ctx.effect(() => { …; return () => server.close() })` (el disposer también
  borra `state.json`).
- Escribir `state.json` al escuchar; crear `token` con `crypto.randomBytes(32).toString('hex')`
  si falta (permiso 0o600).
- Comprobar la activación con `GET /v1/health` (el tool `dsh_bridge_status` que se planteó al principio
  no está implementado).
- Log con `console.error('[claude-bridge]', …)`.
- Errores nunca tumban el Host: toda excepción por request → 500 JSON; un fallo del servidor
  se reporta por `console.error` y no relanza.
- Al finalizar una tarea escribir el evento en `events.jsonl` (append con `fs.appendFile`) y
  actualizar el Task en memoria.
- Deduplicar finalización (no escribir dos eventos para la misma tarea).

## 4. MCP server (lado Claude Code)

`mcp/server.mjs`: servidor MCP **stdio**, JSON-RPC 2.0 delimitado por líneas (`\n`), sin
dependencias. Debe implementar: `initialize`, `notifications/initialized` (sin respuesta),
`ping`, `tools/list`, `tools/call`. Protocol version: responder la del cliente si es una de
`2024-11-05` / `2025-06-18`, si no `2025-06-18`. `serverInfo: { name: "dsh-bridge", version: "1.0.0" }`,
`capabilities: { tools: {} }`.

Tools (nombres estables):

| tool | args | qué hace |
|---|---|---|
| `dsh_delegate` | `{ task, cwd?, preset?, permission?, workers?, wait_seconds? }` | crea la tarea y espera (default 600 s, máx 3600) el resultado; devuelve texto final + `task_id`/`session_id`. Si expira: estado y cómo seguir. |
| `dsh_list` | `{}` | lista tareas |
| `dsh_status` | `{ task_id? }` | estado; sin id = health + tareas activas |
| `dsh_result` | `{ task_id }` | resultado final (si aún no termina, lo dice) |
| `dsh_followup` | `{ task_id, message }` | envía seguimiento al mismo hilo |
| `dsh_cancel` | `{ task_id }` | cancela |
| `dsh_inbox` | `{ ack?: boolean }` | eventos de finalización pendientes; `ack:true` los marca leídos |

- Leer `state.json` y `token` con una caché de 2 s, y volver a leerlos si falla la conexión (el plugin puede reiniciarse con otro puerto).
- HTTP con `fetch` y `AbortSignal.timeout(...)`; errores → `{ content: [{type:'text',text}], isError: true }`.
- `dsh_delegate` hace polling: `POST /v1/tasks/:id/wait {timeoutMs:25000}` cada iteración hasta
  `done|error|cancelled|waiting-input` o agotar `wait_seconds`.
- Texto de respuesta claro, en español, con `task_id`, `session_id` y el resultado.
- El prompt que se envía a DSH lo envuelve el MCP (no el plugin):

```
Tarea delegada por Claude Code (Claude CLI) a DeepSeek Harness. Trabajas en: <cwd>.

<si workers=true>
Eres el Lead de esta sesión. Usa Agent Teams (spawn_teammate / team_task_*) cuando la tarea se
beneficie de trabajo en paralelo o de varios especialistas; si es pequeña, resuélvela directamente.
</si workers=false>
No uses Agent Teams; resuelve tú.

Cuando termines, entrega un resumen final autosuficiente: qué hiciste, archivos tocados, cómo
verificarlo y qué quedó pendiente. Ese texto se devuelve a Claude Code.

TAREA:
<task>
```

`mcp/notify.mjs`: hook de Claude Code para que los avisos de "DSH terminó" lleguen a Claude.
Se registra **solo en `UserPromptSubmit`** (el comando lleva el marcador `--dsh-bridge-hook`):
`additionalContext` solo es válido en ese evento, así que en `Stop` —hook que instalaban versiones
anteriores— no se entrega nada ni se marca como leído, y el aviso sale en el siguiente prompt.
Lee stdin (JSON del hook, campo `hook_event_name`), lee eventos no ackeados de `events.jsonl`
(según `cursor.json`), e imprime en stdout **una sola línea JSON**:

```json
{"hookSpecificOutput":{"hookEventName":"<hook_event_name>","additionalContext":"…texto con los avisos de DSH…"}}
```

Reglas:
- `hookEventName` = el `hook_event_name` recibido por stdin; si no llega, `UserPromptSubmit`.
- Si el evento no es `UserPromptSubmit`, sale 0 sin imprimir y **sin avanzar el cursor**.
- Solo imprime cuando hay eventos nuevos; sin eventos no imprime nada y sale 0.
- Hace ack del último `seq` entregado (en `cursor.json`, escribiendo el máximo entre el cursor
  actual y ese `seq`) para no repetir el aviso ni retroceder.
- Siempre exit 0 y nunca lanza: un hook que falla molesta; un aviso perdido no es crítico.
- El texto debe leerse como información de estado, no como orden de sistema, p. ej.:
  `"DSH terminó la tarea tsk_ab12 (sesión session-7): <resumen>"`.


## 5. Instalación (scripts)

`scripts/install-claude.ps1` (lo ejecuta el usuario o el agente):
1. Comprueba health del plugin (state.json + token); si no responde, avisa y sigue.
2. `claude mcp remove --scope user dsh-bridge` (best-effort) y
   `claude mcp add --scope user --transport stdio dsh-bridge -- <node> <abs>\mcp\server.mjs`.
   (`add-json` falla con el paso de argumentos de PowerShell en esta versión de Claude Code.)
3. Ejecuta `node scripts/merge-claude-settings.mjs install <abs>\mcp\notify.mjs`: fusiona en
   `~/.claude/settings.json` el hook `UserPromptSubmit` y los permisos **por herramienta**
   `mcp__dsh-bridge__dsh_delegate`, `…__dsh_list`, `…__dsh_status`, `…__dsh_result`,
   `…__dsh_followup`, `…__dsh_cancel`, `…__dsh_inbox` (nunca `mcp__dsh-bridge` completo: la regla
   antigua se quita al instalar y al desinstalar; así una herramienta nueva del MCP vuelve a pedir
   confirmación) (backup
   `.bak-<timestamp>`, preservando la forma de array y sin BOM). Es idempotente: primero quita los
   handlers propios —reconocidos por el marcador `--dsh-bridge-hook` o por una instalación previa
   con `notify.mjs`— y también los viejos de `Stop`, y luego deja uno solo con la ruta actual.
4. Añade a `~/.claude/CLAUDE.md` un bloque gestionado
   `<!-- dsh-bridge:start --> … <!-- dsh-bridge:end -->` explicando cuándo usar `dsh_delegate`.
5. Imprime cómo verificar: `claude mcp list`, `claude mcp get dsh-bridge`, y un ejemplo de frase.

`scripts/uninstall-claude.ps1`: quita el MCP, el hook y el bloque de CLAUDE.md (con backups).
