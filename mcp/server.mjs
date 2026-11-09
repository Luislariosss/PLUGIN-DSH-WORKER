#!/usr/bin/env node
/**
 * dsh-bridge — servidor MCP (stdio) para Claude Code.
 *
 * Traduce tools MCP a HTTP contra el plugin @local/dsh-claude-bridge que corre dentro de
 * DeepSeek Harness (127.0.0.1 + token Bearer). Sin dependencias: solo Node 24.
 *
 * Contrato: docs/PROTOCOL.md
 */
import { readFile, readdir, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

const VERSION = '1.1.0'
const SERVER_NAME = 'dsh-bridge'
const BRIDGE_DIR = process.env.DSH_BRIDGE_DIR ?? path.join(os.homedir(), '.dsh', 'claude-bridge')
const STATE_PATH = path.join(BRIDGE_DIR, 'state.json')
const TOKEN_PATH = path.join(BRIDGE_DIR, 'token')
const CURSOR_PATH = path.join(BRIDGE_DIR, 'cursor.json')
const FINAL = new Set(['done', 'error', 'cancelled'])

// Canal (aviso directo): Claude Code 2.1.x acepta notificaciones MCP
// `notifications/claude/channel` de servidores que declaran `claude/channel`, y las
// inyecta en la sesión abierta como `<channel source="dsh-bridge" …>`. Es research
// preview: el servidor debe estar habilitado con `--channels` o
// `--dangerously-load-development-channels server:dsh-bridge`; si no, Claude Code las
// descarta en silencio (por eso la confirmación va por la tool `dsh_channel_ack`).
const CHANNEL_METHOD = 'notifications/claude/channel'
const CHANNEL_CAPABILITY = 'claude/channel'
const CHANNEL_DISABLED = process.env.DSH_BRIDGE_CHANNEL === '0'
const CHANNEL_POLL_MS = (() => {
  const raw = Number.parseInt(process.env.DSH_BRIDGE_CHANNEL_POLL_MS ?? '', 10)
  return Number.isFinite(raw) && raw >= 250 ? raw : 2000
})()

let cached = null // { at, base, token }

// Estado del aviso directo (una instancia por sesión de Claude Code).
let channelStarted = false
let channelReady = false // ya hicimos la sincronización inicial (saltamos el backlog)
let channelBusy = false
let lastPushedSeq = 0 // último evento empujado por el canal
let lastChannelError = null
// taskId → timestamp: tareas cuyo resultado ya volvió dentro de dsh_delegate. Solo se
// usa para no empujar el evento de ESE cierre (una tarea puede volver a cerrar tras un
// follow-up, así que la entrada caduca y sendFollowup la borra).
const inlineDelivered = new Map()
const INLINE_TTL_MS = 60_000

async function bridge() {
  const now = Date.now()
  if (cached && now - cached.at < 2000) return cached
  let state
  let token
  try {
    state = JSON.parse(await readFile(STATE_PATH, 'utf8'))
    token = (await readFile(TOKEN_PATH, 'utf8')).trim()
  } catch (error) {
    throw new Error(
      'El plugin dsh-claude-bridge no está corriendo en DeepSeek Harness ' +
        '(abre o reinicia DSH Desktop y vuelve a intentarlo). Detalle: ' +
        (error instanceof Error ? error.message : String(error)),
    )
  }
  if (!state || typeof state.port !== 'number') throw new Error('state.json del puente inválido')
  cached = { at: now, base: `http://${state.host ?? '127.0.0.1'}:${state.port}`, token }
  return cached
}

async function api(method, url, body, timeoutMs = 60000) {
  const { base, token } = await bridge()
  let response
  try {
    response = await fetch(base + url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    cached = null
    throw new Error(
      'No pude hablar con el puente de DSH en ' +
        base +
        '. ¿Sigue abierto DeepSeek Harness? Detalle: ' +
        (error instanceof Error ? error.message : String(error)),
    )
  }
  const text = await response.text()
  let json
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    json = undefined
  }
  if (!response.ok) {
    const detail = json?.error?.message ?? text.slice(0, 400)
    throw new Error(`El puente de DSH respondió HTTP ${response.status}: ${detail}`)
  }
  return json
}

function wrapPrompt(task, cwd, workers) {
  const lines = [
    'Tarea delegada por Claude Code (Claude CLI) a DeepSeek Harness. Trabajas en: ' + cwd + '.',
    '',
  ]
  if (workers) {
    lines.push(
      'Eres el Lead de esta sesión. Usa Agent Teams (spawn_teammate, team_task_*) cuando la tarea se beneficie de trabajo en paralelo o de varios especialistas; si es pequeña, resuélvela directamente.',
    )
  } else {
    lines.push('No uses Agent Teams; resuelve tú directamente.')
  }
  lines.push(
    '',
    'Cuando termines, entrega un resumen final autosuficiente: qué hiciste, archivos tocados, cómo verificarlo y qué quedó pendiente. Ese texto se devuelve a Claude Code.',
    '',
    'TAREA:',
    task,
  )
  return lines.join('\n')
}

function truncate(text, limit = 20000) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  return value.slice(0, limit) + `\n… (truncado; ${value.length - limit} caracteres más)`
}

function taskHeader(task) {
  return `task_id: ${task.taskId}\nsession_id: ${task.sessionId}\nstatus: ${task.status}`
}

function formatTask(task, { waited = false } = {}) {
  const header = taskHeader(task)
  if (task.status === 'done') {
    return `${waited ? '✅ DSH terminó' : '✅ Tarea lista'} (${header})\n\nResultado:\n${truncate(task.result?.text ?? '(sin texto final)')}`
  }
  if (task.status === 'error') {
    return `❌ DSH reportó error (${header})\n\n${task.error?.message ?? 'sin detalle'}`
  }
  if (task.status === 'cancelled') {
    return `⛔ Tarea cancelada (${header})`
  }
  if (task.status === 'waiting-input') {
    return (
      `⏸ DSH necesita una respuesta en su GUI (${header})\n\n` +
      'La sesión pidió aprobación o una pregunta al usuario. Responde en la ventana de DeepSeek Harness y ' +
      'luego usa dsh_result para recoger el resultado, o dsh_followup para continuar.'
    )
  }
  return (
    `⏳ DSH sigue trabajando (${header})\n\n` +
    'No esperes más aquí: usa dsh_result(task_id) o dsh_status para consultar, o dsh_cancel para parar.'
  )
}

async function waitFor(task, waitSeconds) {
  const deadline = Date.now() + Math.max(0, waitSeconds) * 1000
  let current = task
  while (!FINAL.has(current.status) && current.status !== 'waiting-input') {
    const remaining = deadline - Date.now()
    if (remaining < 500) break
    const timeoutMs = Math.max(1000, Math.min(25000, remaining))
    current = await api('POST', `/v1/tasks/${encodeURIComponent(task.taskId)}/wait`, { timeoutMs }, 40000)
  }
  return current
}

// ── Aviso directo (push a la sesión de Claude Code) ──────────────────────────
// El servidor sondea los eventos de finalización del plugin y los empuja a la sesión
// de Claude Code. Dos transportes, en este orden:
//  1. Buzón de la propia sesión (cross-session messaging de Claude Code): named pipe en
//     Windows / unix socket en mac/Linux. Claude Code lo documenta para que hooks y
//     scripts posteen en su propia sesión; el mensaje despierta una sesión idle (arranca
//     un turno nuevo). Formato NDJSON: {type:'auth',token} y después
//     {type:'user',message:{role:'user',content}}.
//  2. Canal MCP `notifications/claude/channel` (research preview): solo si el usuario
//     relanzó Claude Code con --channels / --dangerously-load-development-channels.
// Ninguno acusa recibo: el mensaje pide confirmar con `dsh_channel_ack(seq)`. Si nadie
// confirma, el hook UserPromptSubmit lo vuelve a entregar en el siguiente mensaje.

async function readAckedSeq() {
  try {
    const parsed = JSON.parse(await readFile(CURSOR_PATH, 'utf8'))
    return typeof parsed.ackedSeq === 'number' ? parsed.ackedSeq : 0
  } catch {
    return 0
  }
}

function channelContent(event) {
  const kind = String(event.kind ?? 'done')
  const taskId = String(event.taskId ?? '')
  const sessionId = String(event.sessionId ?? '')
  const summary = String(event.summary ?? '').trim()
  const head =
    kind === 'error'
      ? `DSH falló en la tarea ${taskId}`
      : kind === 'cancelled'
        ? `DSH canceló la tarea ${taskId}`
        : kind === 'waiting-input'
          ? `DSH necesita una respuesta en su GUI para la tarea ${taskId}`
          : `DSH terminó la tarea ${taskId}`
  return (
    `${head} (sesión DSH ${sessionId}).\n\n` +
    `${summary || '(sin resumen)'}\n\n` +
    `Resultado completo: dsh_result con task_id ${taskId}. ` +
    `Confirma la entrega con dsh_channel_ack seq=${event.seq}.`
  )
}

function inboxPayload(token, text) {
  return (
    JSON.stringify({ type: 'auth', token }) +
    '\n' +
    JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) +
    '\n'
  )
}

let inbox = null // { socketPath, token, source: 'env' | 'registro' }
let inboxBusy = false
let inboxRetryAt = 0
let lastInboxError = null

/**
 * Descubre el buzón (inbox socket) de ESTA sesión de Claude Code.
 * 1) Variables que Claude Code exporta a sus hijos: CLAUDE_CODE_MESSAGING_SOCKET/TOKEN.
 * 2) Registro de sesiones ~/.claude/sessions/<pid>.json → messagingSocketPath y la clave
 *    <pid>.<hash>.key → peerToken. <pid> sale de CLAUDE_PID o del proceso padre (el MCP
 *    server es hijo de Claude Code).
 * Devuelve null si la sesión no tiene cross-session messaging.
 */
async function discoverInbox() {
  const envSocket = process.env.CLAUDE_CODE_MESSAGING_SOCKET
  const envToken = process.env.CLAUDE_CODE_MESSAGING_TOKEN
  if (envSocket && envToken) return { socketPath: envSocket, token: envToken, source: 'env' }

  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  const sessionsDir = path.join(configDir, 'sessions')
  const pid = Number.parseInt(process.env.CLAUDE_PID ?? '', 10) || process.ppid
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID
  let names = []
  try {
    names = await readdir(sessionsDir)
  } catch {
    return null
  }
  const jsonNames = names.filter((name) => /^\d+\.json$/.test(name))
  let socketPath = null
  let ownerPid = null
  for (const name of jsonNames) {
    try {
      const parsed = JSON.parse(await readFile(path.join(sessionsDir, name), 'utf8'))
      if (!parsed || typeof parsed.messagingSocketPath !== 'string') continue
      const namePid = Number.parseInt(name.slice(0, -5), 10)
      const matchesSession = Boolean(sessionId) && parsed.sessionId === sessionId
      const matchesPid = Number.isInteger(namePid) && namePid === pid
      if (!matchesSession && !matchesPid) continue
      if (matchesSession || socketPath === null) {
        socketPath = parsed.messagingSocketPath
        ownerPid = Number.isInteger(parsed.pid) ? parsed.pid : namePid
      }
      if (matchesSession) break
    } catch {}
  }
  if (!socketPath || !Number.isInteger(ownerPid)) return null

  const keyNames = names.filter((name) => /^\d+\.[0-9a-f]{32,64}\.key$/.test(name) && name.startsWith(`${ownerPid}.`))
  let newest = null
  for (const name of keyNames) {
    try {
      const info = await stat(path.join(sessionsDir, name))
      if (newest === null || info.mtimeMs > newest.mtimeMs) newest = { name, mtimeMs: info.mtimeMs }
    } catch {}
  }
  if (newest === null) return null
  try {
    const key = JSON.parse(await readFile(path.join(sessionsDir, newest.name), 'utf8'))
    if (typeof key?.peerToken === 'string' && /^[0-9a-f]{32}$/.test(key.peerToken)) {
      return { socketPath, token: key.peerToken, source: 'registro' }
    }
  } catch {}
  return null
}

async function ensureInbox() {
  if (inbox) return inbox
  if (inboxBusy || Date.now() < inboxRetryAt) return null
  inboxBusy = true
  try {
    inbox = await discoverInbox()
    if (inbox) {
      console.error(`[dsh-bridge] aviso directo por el buzón de la sesión (${inbox.source})`)
    } else {
      // Sin canal propio no hay push: reintenta por si la sesión bindea el buzón más tarde.
      inboxRetryAt = Date.now() + 15000
    }
    return inbox
  } catch (error) {
    inboxRetryAt = Date.now() + 15000
    console.error('[dsh-bridge] no pude descubrir el buzón de la sesión:', error)
    return null
  } finally {
    inboxBusy = false
  }
}

function postToInbox(text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(inbox.socketPath)
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      socket.destroy()
      if (error) reject(error)
      else resolve()
    }
    socket.setTimeout(5000, () => finish(new Error('timeout conectando al buzón de Claude Code')))
    socket.once('error', finish)
    socket.once('connect', () => {
      socket.end(inboxPayload(inbox.token, text), () => finish())
    })
  })
}

function sendChannelEvent(event) {
  const meta = {
    seq: String(event.seq),
    task_id: String(event.taskId ?? ''),
    kind: String(event.kind ?? 'done'),
  }
  if (event.sessionId) meta.session_id = String(event.sessionId)
  send({
    jsonrpc: '2.0',
    method: CHANNEL_METHOD,
    params: { content: channelContent(event), meta },
  })
}

async function ackEvents(seq) {
  await api('POST', '/v1/events/ack', { seq }, 15000)
}

/** Entrega un evento: buzón de la sesión y, si no hay, canal MCP (o nada y cae al hook). */
async function deliverEvent(event) {
  const text = channelContent(event)
  if (await ensureInbox()) {
    try {
      await postToInbox(text)
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message !== lastInboxError) {
        lastInboxError = message
        console.error('[dsh-bridge] no pude escribir en el buzón; se intentará de nuevo:', message)
      }
      inbox = null
      inboxRetryAt = Date.now() + 5000
    }
  }
  sendChannelEvent(event)
  return false
}

async function pollChannel() {
  if (!channelStarted || channelBusy || CHANNEL_DISABLED) return
  channelBusy = true
  try {
    if (!channelReady) {
      // Sincronización inicial: no empujamos el backlog (avisos viejos); el hook los
      // entrega en el siguiente prompt si seguían sin leer.
      const acked = await readAckedSeq()
      const data = await api('GET', `/v1/events?since=${acked}`, undefined, 20000)
      const lastSeq = typeof data?.lastSeq === 'number' ? data.lastSeq : 0
      lastPushedSeq = Math.max(acked, lastSeq)
      channelReady = true
      lastChannelError = null
      return
    }
    const data = await api('GET', `/v1/events?since=${lastPushedSeq}`, undefined, 20000)
    const events = Array.isArray(data?.events) ? data.events : []
    let autoAck = 0
    for (const event of events) {
      if (!event || typeof event.seq !== 'number' || event.seq <= lastPushedSeq) continue
      lastPushedSeq = event.seq
      if (event.taskId && inlineDelivered.has(event.taskId)) {
        const at = inlineDelivered.get(event.taskId)
        inlineDelivered.delete(event.taskId)
        if (Date.now() - at < INLINE_TTL_MS) {
          // El resultado ya volvió dentro de dsh_delegate: no hace falta despertar a Claude.
          autoAck = Math.max(autoAck, event.seq)
          continue
        }
      }
      await deliverEvent(event)
    }
    const staleBefore = Date.now() - INLINE_TTL_MS
    for (const [taskId, at] of inlineDelivered) {
      if (at < staleBefore) inlineDelivered.delete(taskId)
    }
    if (autoAck > 0) await ackEvents(autoAck)
    lastChannelError = null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message !== lastChannelError) {
      lastChannelError = message
      console.error('[dsh-bridge] no pude leer los avisos del plugin:', message)
    }
  } finally {
    channelBusy = false
  }
}

function startChannel() {
  if (channelStarted || CHANNEL_DISABLED) return
  channelStarted = true
  pollChannel().catch(() => {})
  const timer = setInterval(() => {
    pollChannel().catch(() => {})
  }, CHANNEL_POLL_MS)
  if (typeof timer.unref === 'function') timer.unref()
}

const TOOLS = [
  {
    name: 'dsh_delegate',
    description:
      'Delega una tarea a DeepSeek Harness (DSH) y devuelve su resultado final. DSH la ejecuta en una sesión ' +
      'real visible en su GUI; su Lead puede usar Agent Teams (workers) para trabajo en paralelo. Úsalo cuando ' +
      'Luis diga "pásalo a DSH", "que lo haga DeepSeek", "delega esto", o cuando convenga que otra sesión con ' +
      'workers haga el trabajo y tú solo integres el resultado.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task: { type: 'string', description: 'Tarea completa y autosuficiente para DSH (contexto, criterio de terminado, qué devolver).' },
        cwd: { type: 'string', description: 'Carpeta absoluta donde trabajará DSH. Por defecto la del puente o el cwd de Claude.' },
        preset: { type: 'string', description: 'Agent preset de DSH (opcional; normalmente se omite).' },
        permission: {
          type: 'string',
          enum: ['workspace-write', 'danger-full-access'],
          description:
            'Preset de permisos de la sesión de DSH (opcional). danger-full-access requiere habilitarlo en el plugin ' +
            '(allowFullAccess: true en la config de claude-bridge); si no, DSH responde 403 (permission/forbidden). ' +
            'Déjalo omitido salvo que Luis lo pida explícitamente.',
        },
        workers: { type: 'boolean', description: 'true (default) = indica a DSH que puede usar Agent Teams; false = que resuelva solo.' },
        wait_seconds: { type: 'number', description: 'Cuánto esperar el resultado antes de devolver el task_id (default 600, máx 3600; 0 = no esperar).' },
      },
      required: ['task'],
    },
  },
  {
    name: 'dsh_list',
    description: 'Lista las tareas delegadas a DSH en esta sesión del puente (id, estado, cwd, resultado resumido).',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'dsh_status',
    description: 'Estado del puente DSH y de una tarea concreta (o de las tareas activas si no pasas task_id).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { task_id: { type: 'string', description: 'task_id devuelto por dsh_delegate (opcional).' } },
    },
  },
  {
    name: 'dsh_result',
    description: 'Devuelve el resultado final de una tarea ya terminada (o su estado actual). Úsalo para recoger trabajo que dejaste en segundo plano.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { task_id: { type: 'string', description: 'task_id devuelto por dsh_delegate.' } },
      required: ['task_id'],
    },
  },
  {
    name: 'dsh_followup',
    description: 'Envía otra instrucción al mismo hilo de DSH (misma sesión y contexto), como un seguimiento de la tarea.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task_id: { type: 'string', description: 'task_id de la tarea a continuar.' },
        message: { type: 'string', description: 'Instrucción de seguimiento.' },
      },
      required: ['task_id', 'message'],
    },
  },
  {
    name: 'dsh_cancel',
    description: 'Cancela una tarea delegada a DSH que sigue corriendo.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { task_id: { type: 'string', description: 'task_id a cancelar.' } },
      required: ['task_id'],
    },
  },
  {
    name: 'dsh_watch',
    description:
      'Monitorea ACTIVAMENTE una tarea de DSH: se queda esperando (bloqueante) hasta que DSH entregue, ' +
      'pida aprobación (waiting-input) o se agote timeout_seconds. Úsala justo después de dsh_delegate ' +
      '(con o sin task_id) en vez de consultar a mano o terminar la sesión: ella te despierta con la entrega. ' +
      'Sin task_id observa TODAS las tareas activas y retorna en cuanto alguna termine. Si expira sin entrega, ' +
      'devuelve el estado y vuelve a llamarla para seguir monitoreando; no termines la sesión con tareas en curso.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task_id: { type: 'string', description: 'task_id a vigilar (opcional; sin él vigila todas las tareas activas).' },
        timeout_seconds: { type: 'number', description: 'Cuánto mantenerse bloqueada antes de devolver (default 1800, máx 3600).' },
        interval_seconds: { type: 'number', description: 'Frecuencia de sondeo en segundos (default 5, mínimo 1).' },
      },
    },
  },
  {
    name: 'dsh_inbox',
    description: 'Lee los avisos de finalización de DSH pendientes (tareas que terminaron desde la última lectura) y opcionalmente los marca como leídos.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { ack: { type: 'boolean', description: 'true (default) = marcar como leídos; false = solo leer.' } },
    },
  },
  {
    name: 'dsh_channel_ack',
    description:
      'Confirma al puente que recibiste un aviso push de DSH (un mensaje entrante con "DSH terminó/falló/canceló ' +
      'la tarea …" o un evento <channel source="dsh-bridge" …>). Llama a esta tool con el seq del aviso en cuanto ' +
      'llegue, para que no se repita en el siguiente mensaje del usuario.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        seq: {
          type: 'number',
          description: 'Valor seq del aviso recibido (viene en el propio texto del aviso; el mayor, si llegaron varios).',
        },
      },
      required: ['seq'],
    },
  },
]

async function sleepSeconds(seconds) {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, seconds) * 1000))
}

async function toolWatch(args) {
  const taskId = typeof args?.task_id === 'string' && args.task_id.length > 0 ? args.task_id : null
  const timeoutSeconds = Number.isFinite(args?.timeout_seconds)
    ? Math.min(3600, Math.max(0, Number(args.timeout_seconds)))
    : 1800
  const intervalSeconds = Number.isFinite(args?.interval_seconds)
    ? Math.min(60, Math.max(1, Number(args.interval_seconds)))
    : 5
  const deadline = Date.now() + timeoutSeconds * 1000

  if (taskId) {
    // Vigila una tarea concreta: usa el endpoint /wait (long-poll del puente).
    let current = await api('GET', `/v1/tasks/${encodeURIComponent(taskId)}`, undefined, 30000)
    while (!FINAL.has(current.status) && current.status !== 'waiting-input') {
      const remaining = deadline - Date.now()
      if (remaining < 500) break
      const timeoutMs = Math.max(1000, Math.min(25000, remaining))
      current = await api('POST', `/v1/tasks/${encodeURIComponent(taskId)}/wait`, { timeoutMs }, 40000)
    }
    if (FINAL.has(current.status) || current.status === 'waiting-input') {
      return `👀 DSH entregó (vigilancia activa)\n\n${formatTask(current)}`
    }
    return (
      `👀 Sin entrega todavía (${taskHeader(current)})\n\n` +
      `Lancé el watchdog ${timeoutSeconds} s y DSH sigue trabajando. Llama de nuevo a dsh_watch ` +
      `(mismo task_id) para seguir monitoreando en vez de terminar la sesión.`
    )
  }

  // Sin task_id: vigila todas las tareas activas hasta que alguna termine o pida aprobación.
  let finished = new Set()
  let active = []
  for (;;) {
    const data = await api('GET', '/v1/tasks', undefined, 30000)
    const tasks = Array.isArray(data?.tasks) ? data.tasks : []
    active = tasks.filter((task) => !FINAL.has(task.status) && task.status !== 'waiting-input')
    const delivered = tasks.filter(
      (task) => (FINAL.has(task.status) || task.status === 'waiting-input') && !finished.has(task.taskId),
    )
    if (delivered.length > 0) {
      for (const task of delivered) finished.add(task.taskId)
      const seen = delivered.map((task) => formatTask(task)).join('\n\n---\n\n')
      return `👀 DSH entregó (vigilancia activa)\n\n${seen}`
    }
    const remaining = deadline - Date.now()
    if (remaining < 500 || active.length === 0) break
    await sleepSeconds(Math.min(intervalSeconds, Math.max(1, remaining / 1000)))
  }
  if (active.length === 0) {
    return '👀 Sin tareas activas de DSH que monitorear.'
  }
  const lista = active.map((task) => `- ${task.taskId} [${task.status}] ${task.cwd}`).join('\n')
  return (
    `👀 Sin entrega todavía. Tareas en curso:\n${lista}\n\n` +
    `Llama de nuevo a dsh_watch (sin task_id) para seguir monitoreando; no termines la sesión con trabajo en curso.`
  )
}

async function toolDelegate(args) {
  const taskText = String(args?.task ?? '').trim()
  if (!taskText) throw new Error('dsh_delegate requiere "task" no vacío')
  const cwd = typeof args?.cwd === 'string' && args.cwd.length > 0 ? args.cwd : process.cwd()
  const workers = args?.workers !== false
  const waitSeconds = Number.isFinite(args?.wait_seconds) ? Math.min(3600, Math.max(0, Number(args.wait_seconds))) : 600
  const body = {
    prompt: wrapPrompt(taskText, cwd, workers),
    cwd,
    workers,
    client: 'claude-code',
    ...(typeof args?.preset === 'string' && args.preset ? { preset: args.preset } : {}),
    ...(typeof args?.permission === 'string' && args.permission ? { permission: args.permission } : {}),
  }
  const created = await api('POST', '/v1/tasks', body, 60000)
  if (waitSeconds === 0) return `⏳ Tarea enviada a DSH (${taskHeader(created)})\n\nDSH la ejecutará en segundo plano. Recoge el resultado con dsh_result.`
  const finalTask = await waitFor(created, waitSeconds)
  if (FINAL.has(finalTask.status) || finalTask.status === 'waiting-input') {
    // El resultado ya va en esta respuesta: el canal no debe despertar a Claude por la misma tarea.
    inlineDelivered.set(finalTask.taskId, Date.now())
  }
  return formatTask(finalTask, { waited: true })
}

async function toolList() {
  const data = await api('GET', '/v1/tasks', undefined, 30000)
  const tasks = Array.isArray(data?.tasks) ? data.tasks : []
  if (tasks.length === 0) return 'No hay tareas delegadas a DSH todavía.'
  return tasks
    .map((task) => {
      const summary = task.result?.text ? task.result.text.replace(/\s+/g, ' ').slice(0, 180) : ''
      return `- ${task.taskId} [${task.status}] ${task.cwd}${summary ? ' — ' + summary : ''}`
    })
    .join('\n')
}

async function toolStatus(args) {
  if (args?.task_id) {
    const task = await api('GET', `/v1/tasks/${encodeURIComponent(args.task_id)}`, undefined, 30000)
    return formatTask(task)
  }
  const health = await api('GET', '/v1/health', undefined, 15000)
  const data = await api('GET', '/v1/tasks', undefined, 30000)
  const tasks = Array.isArray(data?.tasks) ? data.tasks : []
  const active = tasks.filter((task) => !FINAL.has(task.status))
  let canal
  if (CHANNEL_DISABLED) canal = 'desactivado (DSH_BRIDGE_CHANNEL=0)'
  else if ((await ensureInbox()) !== null) canal = `buzón de esta sesión de Claude Code (${inbox.source})`
  else canal = 'sin buzón detectado; los avisos llegarán en el siguiente mensaje (hook)'
  return (
    `Puente DSH: ${health.ok ? 'activo' : 'inactivo'} (puerto ${health.port}, tareas: ${JSON.stringify(health.tasks)})\n` +
    `Aviso directo: ${canal}\n` +
    (active.length === 0
      ? 'No hay tareas activas.'
      : 'Tareas activas:\n' + active.map((task) => `- ${task.taskId} [${task.status}] ${task.cwd}`).join('\n'))
  )
}

async function toolResult(args) {
  const taskId = String(args?.task_id ?? '')
  if (!taskId) throw new Error('dsh_result requiere "task_id"')
  const task = await api('GET', `/v1/tasks/${encodeURIComponent(taskId)}`, undefined, 30000)
  return formatTask(task)
}

async function toolFollowup(args) {
  const taskId = String(args?.task_id ?? '')
  const message = String(args?.message ?? '').trim()
  if (!taskId) throw new Error('dsh_followup requiere "task_id"')
  if (!message) throw new Error('dsh_followup requiere "message"')
  const task = await api('POST', `/v1/tasks/${encodeURIComponent(taskId)}/messages`, { text: message }, 60000)
  inlineDelivered.delete(taskId)
  return `↪️ Seguimiento enviado a DSH (${taskHeader(task)})\n\nUsa dsh_result o vuelve a llamar a dsh_followup con más contexto.`
}

async function toolCancel(args) {
  const taskId = String(args?.task_id ?? '')
  if (!taskId) throw new Error('dsh_cancel requiere "task_id"')
  const task = await api('POST', `/v1/tasks/${encodeURIComponent(taskId)}/cancel`, {}, 30000)
  return `⛔ ${formatTask(task)}`
}

async function readCursor() {
  try {
    const parsed = JSON.parse(await readFile(path.join(BRIDGE_DIR, 'cursor.json'), 'utf8'))
    return typeof parsed.ackedSeq === 'number' ? parsed.ackedSeq : 0
  } catch {
    return 0
  }
}

async function toolInbox(args) {
  const ack = args?.ack !== false
  const since = await readCursor()
  const data = await api('GET', `/v1/events?since=${since}`, undefined, 30000)
  const events = Array.isArray(data?.events) ? data.events : []
  const lastSeq = typeof data?.lastSeq === 'number' ? data.lastSeq : since
  if (events.length === 0) return 'No hay avisos nuevos de DSH.'
  const text = events
    .map((event) => `- [${event.kind}] ${event.taskId} (${event.sessionId}): ${String(event.summary ?? '').slice(0, 600)}`)
    .join('\n')
  if (ack && lastSeq > since) await api('POST', '/v1/events/ack', { seq: lastSeq }, 15000)
  return `Avisos de finalización de DSH${ack ? '' : ' (sin marcar como leídos)'}:\n${text}`
}

async function toolChannelAck(args) {
  const raw = Number(args?.seq)
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new Error(
      'dsh_channel_ack necesita "seq": el número del atributo seq del evento <channel source="dsh-bridge" …> que recibiste.',
    )
  }
  const target = lastPushedSeq > 0 ? Math.min(raw, lastPushedSeq) : raw
  await ackEvents(target)
  return `Confirmado: los avisos hasta seq=${target} quedan marcados como entregados y no se repetirán en el siguiente mensaje.`
}

const HANDLERS = {
  dsh_delegate: toolDelegate,
  dsh_list: toolList,
  dsh_status: toolStatus,
  dsh_result: toolResult,
  dsh_followup: toolFollowup,
  dsh_cancel: toolCancel,
  dsh_inbox: toolInbox,
  dsh_watch: toolWatch,
  dsh_channel_ack: toolChannelAck,
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handle(message) {
  const { id, method, params } = message ?? {}
  if (method === undefined) return
  if (method === 'initialize') {
    const requested = params?.protocolVersion
    const protocolVersion = requested === '2024-11-05' || requested === '2025-06-18' ? requested : '2025-06-18'
    const capabilities = { tools: {} }
    if (!CHANNEL_DISABLED) capabilities.experimental = { [CHANNEL_CAPABILITY]: {} }
    reply(id, {
      protocolVersion,
      capabilities,
      serverInfo: { name: SERVER_NAME, version: VERSION },
      instructions:
        'Puente a DeepSeek Harness (DSH), el otro agente de Luis. Usa dsh_delegate para mandarle trabajo ' +
        '(su Lead puede usar Agent Teams/workers) y recibe el resultado final. Avisos de trabajos terminados: ' +
        'dsh_inbox. Mientras esta sesión está abierta, el aviso de una tarea que termina llega solo (como ' +
        'mensaje entrante o como evento <channel source="dsh-bridge" task_id="…" kind="…" seq="…">): cuéntale ' +
        'a Luis qué terminó y confírmalo con dsh_channel_ack(seq). Monitoreo activo: tras dsh_delegate llama a ' +
        'dsh_watch (con task_id o sin él) y se queda bloqueada hasta que DSH entregue; al expirar, vuelve a ' +
        'llamarla en vez de terminar la sesión con trabajo en curso. Cuando Luis diga "pásalo a DSH", "delega ' +
        'esto", "que lo haga DeepSeek" o similar, usa dsh_delegate con una tarea autosuficiente y el cwd correcto.',
    })
    return
  }
  if (method === 'notifications/initialized' || method === 'initialized') {
    startChannel()
    return
  }
  if (method === 'ping') {
    reply(id, {})
    return
  }
  if (method === 'tools/list') {
    reply(id, { tools: TOOLS })
    return
  }
  if (method === 'tools/call') {
    const name = params?.name
    const args = params?.arguments ?? {}
    const handler = HANDLERS[name]
    if (!handler) {
      replyError(id, -32602, `Tool desconocido: ${String(name)}`)
      return
    }
    try {
      const text = await handler(args)
      reply(id, { content: [{ type: 'text', text: String(text) }] })
    } catch (error) {
      reply(id, {
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      })
    }
    return
  }
  if (id !== undefined && id !== null) replyError(id, -32601, `Método no soportado: ${method}`)
}

process.on('uncaughtException', (error) => {
  console.error('[dsh-bridge] uncaught:', error)
})
process.on('unhandledRejection', (error) => {
  console.error('[dsh-bridge] unhandled rejection:', error)
})

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    replyError(null, -32700, 'JSON inválido')
    return
  }
  handle(message).catch((error) => {
    console.error('[dsh-bridge] handler:', error)
    if (message && message.id !== undefined && message.id !== null) {
      replyError(message.id, -32603, error instanceof Error ? error.message : String(error))
    }
  })
})
rl.on('close', () => process.exit(0))
