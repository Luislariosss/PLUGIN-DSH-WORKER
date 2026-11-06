# @local/dsh-claude-bridge (plugin de DeepSeek Harness)

Plugin **Host** que corre dentro de DeepSeek Harness (perfil `desktop`). Abre un HTTP local
(`127.0.0.1` + token Bearer) para que el servidor MCP `dsh-bridge` de Claude Code pueda:

- crear **sesiones reales de DSH** (visibles en el GUI, con Agent Teams disponibles),
- mandarles un prompt,
- esperar su finalización y devolver el **texto final**,
- enviar seguimientos, cancelar y leer avisos de terminación.

Contrato completo: `../docs/PROTOCOL.md`.

## Instalación

Desde DSH: página **Plugins → instalar desde carpeta**, apuntando a esta carpeta
(`C:\Users\luisl\Downloads\SQL\dsh-claude-bridge\plugin`). O con el gestor de plugins del Host:

```
plugin_manager install_bundle target: C:\Users\luisl\Downloads\SQL\dsh-claude-bridge\plugin
```

Al activarse escribe:

- `%USERPROFILE%\.dsh\claude-bridge\token` — token de 64 hex (permiso del usuario).
- `%USERPROFILE%\.dsh\claude-bridge\state.json` — `{ version, host, port, pid, startedAt }`.
- `%USERPROFILE%\.dsh\claude-bridge\events.jsonl` — eventos de terminación (append-only).

y escucha en `http://127.0.0.1:49777` (si está ocupado prueba 49778…49786).

## Configuración

En `~/.dsh/profiles/desktop/cordis.patch.yml` (o en la fila del plugin en la página Plugins):

```yaml
- id: claude-bridge
  name: '@local/dsh-claude-bridge'
  config:
    port: 49777                 # puerto base (prueba +1..+9 si está ocupado)
    host: 127.0.0.1             # solo loopback; no lo cambies a 0.0.0.0
    bridgeDir: 'C:\Users\luisl\.dsh\claude-bridge'
    defaultCwd: null            # cwd si la petición no manda uno
    agentPreset: null           # null = preset por defecto del perfil
    permission: null            # null = no tocar; 'workspace-write' | 'danger-full-access'
    maxConcurrent: 4            # tareas simultáneas antes de devolver 409
    clientTimeZone: America/Mexico_City
    maxTaskMs: 21600000         # 6 h: tras eso la tarea se marca error
```

## Endpoints

| Método y ruta | Qué hace |
|---|---|
| `GET /v1/health` | estado del puente |
| `POST /v1/tasks` | crea tarea (`prompt`, `cwd`, `preset`, `permission`, `workers`, `client`) |
| `GET /v1/tasks` | lista (máx. 100) |
| `GET /v1/tasks/:id` | estado de una tarea |
| `POST /v1/tasks/:id/wait` | espera hasta terminar (`timeoutMs` ≤ 120000) |
| `POST /v1/tasks/:id/messages` | seguimiento en el mismo hilo |
| `POST /v1/tasks/:id/cancel` | cancela |
| `GET /v1/events?since=N` | eventos de terminación |
| `POST /v1/events/ack` | marca eventos como leídos |
| `GET /v1/_diag?sessionId=` | diagnóstico (cola durable, estado, último mensaje) |

Todas exigen `Authorization: Bearer <token>`. Los errores devuelven
`{ "error": { "code", "message" } }`.

## Cómo cierra las tareas

El plugin **no** depende de que la sesión siga viva en memoria: lee la cola **durable** con
`sessionController.events` y busca un `turn/end` del turno esperado
(`completed` → done, `error` → error, `aborted/interrupted` → cancelled, `blocked` →
waiting-input). Además:
- un poller cada 3 s cierra tareas aunque nadie llame a `wait` (así se generan los avisos),
- `pendingInput` del estado de sesión marca `waiting-input` (aprobaciones/preguntas en el GUI),
- si la sesión desaparece, la tarea se cierra como error.

## Diagnóstico

```powershell
$dir = "$env:USERPROFILE\.dsh\claude-bridge"
$s = Get-Content "$dir\state.json" | ConvertFrom-Json
$t = (Get-Content "$dir\token" -Raw).Trim()
Invoke-RestMethod -Uri "http://$($s.host):$($s.port)/v1/health" -Headers @{ Authorization = "Bearer $t" }
Get-Content "$dir\events.jsonl" -Tail 5
```

- **`state.json` no existe**: el plugin no está activo (¿instalado y DSH abierto?).
- **HTTP 401**: token desincronizado; borra `token` y reinicia DSH (se regenera) o usa el
  `token` actual en el cliente.
- **La tarea queda `running`**: llama a `/v1/_diag?sessionId=…` para ver la cola de eventos y
  si hay `turn/end`; si el modelo no responde, revisa el modelo por defecto del perfil.

## Desarrollo

La instalación queda como enlace al directorio (`link:`). Un cambio en `index.js` **no** se
recarga solo: hay que reinstalar el bundle (Plugins → quitar + instalar, o
`plugin_manager remove_bundle` + `install_bundle`) para que el Host importe el módulo nuevo.
