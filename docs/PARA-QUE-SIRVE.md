# ¿De qué sirve el puente Claude Code ⇄ DSH?

Revisión y estado verificado el **2026-11-05** (la misma noche en que se construyó).

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
3. **Trabajo en segundo plano con aviso.** `dsh_delegate` con `wait_seconds: 0` deja la tarea
   corriendo; cuando termina, el hook inyecta el aviso en el siguiente turno de Claude
   (probado: Claude vio los `task_id` y sus resultados sin que el usuario los pegara).
4. **Reutilizar la configuración de DSH.** Las sesiones delegadas usan el perfil de DSH: sus
   modelos, sus plugins, su GUI, sus aprobaciones. Nada que reconfigurar en Claude.
5. **Cadenas de agentes.** Claude planifica/revisa, DSH ejecuta con workers, Claude integra el
   resultado. Útil con tareas mecánicas y comprobables.

## Lo que NO hace (límites reales)

- **No comparte contexto solo.** Hay que escribir una tarea autosuficiente (qué, dónde, criterio de
  terminado, qué devolver). DSH no ve la conversación de Claude ni el repo por sí solo.
- **No despierta a Claude dormido.** Si Claude terminó su turno y está idle, el aviso llega en el
  siguiente prompt o al final del turno en curso; no se puede inyectar en una sesión idle.
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
- Hook `UserPromptSubmit` (marcador `--dsh-bridge-hook`) y permiso `mcp__dsh-bridge` instalados;
  bloque en `~/.claude/CLAUDE.md`.
- `tests/e2e.mjs` (HTTP: crear, resultado, evento, follow-up, 404) y `tests/mcp-e2e.mjs`
  (MCP completo) en verde.
- Probado con Claude Code real: delegó tareas y recibió `CLAUDE_CLI_OK` / `INSTALADO_OK`.
- Probado Agent Teams: la tarea delegada creó el worker `probe` y devolvió `TEAM_OK`.

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
