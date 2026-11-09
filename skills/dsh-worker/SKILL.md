---
name: dsh-worker
description: Usa el puente Claude Code <-> DeepSeek Harness (DSH) con monitoreo activo. Úsala siempre que el usuario quiera pasar trabajo a DSH, delegar a DeepSeek, usar sus workers/Agent Teams, o saber si DSH ya entregó algo — aunque diga "pásalo a DSH", "que lo haga DeepSeek", "dale esto a otro agente" o similar. Define el protocolo APLICABLE sin excepciones: delegar + vigilar con dsh_watch hasta que DSH entregue; nunca dejar una tarea corriendo sin monitoreo ni terminar la sesión con trabajo en curso.
---

# Delegar a DSH con monitoreo activo

Tienes el MCP `dsh-bridge` conectado (tools `dsh_delegate`, `dsh_list`, `dsh_status`, `dsh_result`, `dsh_followup`, `dsh_cancel`, `dsh_watch`, `dsh_inbox`). DeepSeek Harness es otro agente del usuario: ejecuta en sesiones reales de DSH (visibles en su GUI) y su Lead puede usar workers (Agent Teams).

## El protocolo (obligatorio)

Ninguna delegación queda sin monitoreo. El flujo completo es:

1. **`dsh_delegate`** con tarea autosuficiente (contexto, criterio de terminado, qué devolver) y el `cwd` absoluto correcto. Dos modos:
   - **Sincrónico**: deja `wait_seconds` por defecto (600 s). El resultado vuelve en la misma llamada; intégralo y sigue.
   - **Con vigilancia**: usa `wait_seconds: 0` y pasa de inmediato al paso 2.
2. **`dsh_watch`** — se queda **bloqueada** hasta que DSH entregue. Es el corazón del monitoreo:
   - Con `task_id`: vigila esa tarea concreta.
   - Sin `task_id`: vigila **todas** las tareas activas y despierta en cuanto alguna entregue o pida aprobación.
   - Si expira sin entrega, devuelve el estado: **vuelve a llamarla** (puedes subir `timeout_seconds`, máx 3600). No termines la sesión con trabajo en curso sin decirlo.
3. Al despertar con la entrega, recoge el resultado (`dsh_watch` ya lo trae; si no, `dsh_result` / `dsh_inbox`) e **intéglalo**: haz lo que el resultado pide (commit, verificación, siguiente paso) en vez de limitarte a resumir.
4. Casos especiales:
   - `waiting-input`: DSH necesita aprobación en su GUI. Avisa al usuario qué necesita y dónde aprobarlo; luego sigue vigilando con `dsh_watch`.
   - `error` / `cancelled`: repórtalo con el detalle; decide con el usuario si reintentar (`dsh_followup` o nueva delegación).
   - Si DSH está cerrado, el MCP responde un error claro: avisa al usuario que lo abra.

## Qué NO hacer

- No delegues y termines tu turno sin vigilancia: el aviso pasivo (hook en el siguiente mensaje del usuario, `dsh_inbox`) existe como respaldo, no como plan principal.
- No sondees con shell/`sleep` ni hagas polling manual de `events.jsonl`: para eso está `dsh_watch`.
- No delegues secretos ni credenciales: DSH ejecuta con su propio sandbox y aprobaciones.
- No des por hecho que el resultado se entregó solo por terminar el timeout: verifica siempre el estado devuelto por `dsh_watch`.

## Ejemplos

**Delegación normal:**
> Usuario: "Pásale a DSH: revisa el proyecto X y hazme un informe de TODOs, luego un commit."
> Tú: `dsh_delegate` (espera 600 s) → resultado → integras el commit.

**Trabajo largo con monitoreo:**
> Tú: `dsh_delegate(wait_seconds: 0)` → `dsh_watch(task_id)` bloqueada → al entregar, `dsh_result` y seguir.

**Varias tareas en paralelo:**
> Tú: delegas dos tareas → `dsh_watch()` sin task_id → te despierta con cada entrega.

## Referencia

Contrato completo (endpoints, estados, persistencia): `docs/PROTOCOL.md` del repo `PLUGIN-DSH-WORKER`.
