# ¿De qué sirve el puente Claude Code ⇄ DSH?

Revisión inicial el **2026-11-05** (la misma noche en que se construyó) y **aviso directo
verificado el 2026-11-09** contra Claude Code 2.1.314.

## El problema que resuelve

Claude Code y DeepSeek Harness son dos agentes distintos:

- **Claude Code** es el agente que abres en la terminal; bueno para trabajar junto a ti, pero
  una sola conversación no paraleliza mucho.
- **DeepSeek Harness (DSH)** tiene *Agent Teams*: un Lead que reparte trabajo entre workers en
  paralelo, con su propio GUI, modelos, plugins y sandbox.

El puente deja que Claude Code **delegue** trabajo a DSH y **reciba** el resultado (y el aviso de
que terminó). No es "Claude dentro de DSH": es DSH como **equipo de workers** al que Claude le
manda trabajo.

## Casos de uso en los que sí sirve

1. **Delegar trabajo largo y seguir en Claude.** Mandas a DSH una migración, un barrido de TODOs
   o una auditoría; DSH la ejecuta mientras tú sigues en la terminal con otra cosa.
2. **Paralelismo real sin cambiar de herramienta.** La tarea delegada se ejecuta con Agent Teams:
   varios workers mirando partes distintas del mismo repo.
3. **Trabajo en segundo plano con aviso inmediato.** `dsh_delegate` con `wait_seconds: 0` deja la
   tarea corriendo; al terminar, el MCP escribe el aviso en el buzón de la sesión de Claude Code y,
   si está idle, Claude Code la despierta con un turno nuevo (verificado contra Claude Code
   2.1.314: el aviso llegó, Claude llamó a `dsh_result` y a `dsh_channel_ack`). Sin buzón
   disponible, el aviso cae al hook en el siguiente turno.
4. **Reutilizar la configuración de DSH.** Las sesiones delegadas usan el perfil de DSH: sus
   modelos, sus plugins, su GUI, sus aprobaciones. Nada que reconfigurar en Claude.
5. **Cadenas de agentes.** Claude planifica/revisa, DSH ejecuta con workers, Claude integra el
   resultado. Útil con tareas mecánicas y comprobables.

## Lo que NO hace (límites reales)

- **No comparte contexto solo.** Hay que escribir una tarea autosuficiente (qué, dónde, criterio de
  terminado, qué devolver). DSH no ve la conversación de Claude ni el repo por sí solo.
- **El aviso directo depende del buzón de Claude Code.** Si la sesión está abierta y tiene
  *cross-session messaging* (Claude Code 2.1.234+ en Windows), el aviso despierta a Claude al
  momento. Con Claude Code cerrado, o con `crossSessionInbound` en `hold`/`refuse`, el aviso llega
  en el siguiente mensaje (hook) o con `dsh_inbox`. El mensaje inyectado consume tokens como un
  turno normal.
- **No funciona con DSH cerrado.** El plugin vive dentro del proceso de DSH; si lo cierras, el MCP
  devuelve un error claro.
- **No sustituye la revisión humana.** DSH ejecuta con su propio sandbox y aprobaciones; lo que
  haga falta aprobar se responde en el GUI de DSH (la tarea queda `waiting-input`).
- **No es gratis:** cada tarea consume tokens de Claude (el prompt y el resultado) y de DSH
  (el trabajo real). Para preguntas de 2 líneas no vale la pena.
- **No borra las sesiones:** cada tarea deja una sesión visible en el GUI de DSH (se pueden
  archivar ahí).

## Coste y seguridad

- El plugin escucha **solo en 127.0.0.1** y exige token Bearer que vive en
  `%USERPROFILE%\.dsh\claude-bridge\token`.
- No hay puertos expuestos a la red. El token no se comparte con terceros.
- Las sesiones delegadas siguen el preset de permisos de DSH (`workspace-write` por defecto).
- **No delegues secretos, tokens ni credenciales** en el texto de la tarea.

## Estado verificado (2026-11-05)

- Plugin `@local/dsh-claude-bridge` activo: `GET /v1/health` → `ok`, 8 tareas `done`, 0 errores.
- MCP `dsh-bridge` en Claude Code: `Connected`.
- Hook `UserPromptSubmit` (marcador `--dsh-bridge-hook`) y permisos `mcp__dsh-bridge__dsh_*` instalados;
  bloque en `~/.claude/CLAUDE.md`.
- `tests/e2e.mjs` (HTTP: crear, resultado, evento, follow-up, 404) y `tests/mcp-e2e.mjs`
  (MCP completo) en verde.
- Probado con Claude Code real: delegó tareas y recibió `CLAUDE_CLI_OK` / `INSTALADO_OK`.
- Probado Agent Teams: la tarea delegada creó el worker `probe` y devolvió `TEAM_OK`.

## Estado verificado del aviso directo (2026-11-09)

- `node mcp/selftest.mjs` y `node tests/push-e2e.mjs` en verde: `initialize` declara
  `experimental['claude/channel']`, los dos transportes emiten el payload esperado, `dsh_channel_ack`
  avanza el cursor, el backlog no se empuja y la tarea entregada inline por `dsh_delegate` no se
  duplica.
- Extremo a extremo con Claude Code real (2.1.314, sesión `-p` headless con
  `crossSessionInbound: accept`): el MCP `dsh-bridge` arrancó como hijo de Claude Code, descubrió el
  buzón por `CLAUDE_CODE_MESSAGING_SOCKET/TOKEN`, y un evento de DSH apareció en el debug log como
  `[uds-messaging] Routed user message to queue: DSH terminó la tarea …`. Claude respondió llamando
  `dsh_result` y `dsh_channel_ack {seq:1}`, y el mensaje quedó en el transcript.
- Lo que **no** se verificó en esta máquina: una sesión interactiva de escritorio del usuario (el
  token OAuth de la CLI estaba caducado, así que el turno del modelo no se completó) y el transporte
  2 (canal MCP), que exige relanzar Claude Code con el flag de desarrollo.
- Para activarlo en una instalación existente: volver a ejecutar `scripts\install-claude.ps1`
  (deja `crossSessionInbound: "accept"`, las 9 reglas y el MCP) y **reiniciar** Claude Code.

## Recomendación

Vale la pena si usas Claude Code a diario y quieres **paralelismo y workers** para trabajo
pesado (refactors, auditorías, migraciones, barridos de repo) sin salir de Claude. Para trabajo
pequeño o conversacional, el coste de ida y vuelta no compensa: usa DSH directamente o sigue en
Claude.

## Idea de extensión (no incluida)

**Apagar la PC al terminar una tarea larga** (útil para dejar algo corriendo de noche). No se
incluyó por seguridad: apagar la máquina puede perder trabajo sin guardar. Si se quiere, el
camino correcto es un tool MCP explícito (`dsh_shutdown_pc`) con confirmación y cuenta atrás
cancelable (`shutdown /a`), nunca automático.
