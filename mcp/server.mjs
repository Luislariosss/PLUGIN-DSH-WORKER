#!/usr/bin/env node
/**
 * dsh-bridge — servidor MCP (stdio) para Claude Code.
 *
 * Traduce tools MCP a HTTP contra el plugin @local/dsh-claude-bridge que corre dentro de
 * DeepSeek Harness (127.0.0.1 + token Bearer). Sin dependencias: solo Node 24.
 *
 * Contrato: docs/PROTOCOL.md
 */
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import os from 'node:os'
import path from 'node:path'

const VERSION = '1.0.0'
const SERVER_NAME = 'dsh-bridge'
const BRIDGE_DIR = process.env.DSH_BRIDGE_DIR ?? path.join(os.homedir(), '.dsh', 'claude-bridge')
const STATE_PATH = path.join(BRIDGE_DIR, 'state.json')
const TOKEN_PATH = path.join(BRIDGE_DIR, 'token')
const FINAL = new Set(['done', 'error', 'cancelled'])

let cached = null // { at, base, token }

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
    name: 'dsh_inbox',
    description: 'Lee los avisos de finalización de DSH pendientes (tareas que terminaron desde la última lectura) y opcionalmente los marca como leídos.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { ack: { type: 'boolean', description: 'true (default) = marcar como leídos; false = solo leer.' } },
    },
  },
]

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
  return (
    `Puente DSH: ${health.ok ? 'activo' : 'inactivo'} (puerto ${health.port}, tareas: ${JSON.stringify(health.tasks)})\n` +
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

const HANDLERS = {
  dsh_delegate: toolDelegate,
  dsh_list: toolList,
  dsh_status: toolStatus,
  dsh_result: toolResult,
  dsh_followup: toolFollowup,
  dsh_cancel: toolCancel,
  dsh_inbox: toolInbox,
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
    reply(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: VERSION },
      instructions:
        'Puente a DeepSeek Harness (DSH), el otro agente de Luis. Usa dsh_delegate para mandarle trabajo ' +
        '(su Lead puede usar Agent Teams/workers) y recibe el resultado final. Avisos de trabajos terminados: ' +
        'dsh_inbox. Cuando Luis diga "pásalo a DSH", "delega esto", "que lo haga DeepSeek" o similar, usa ' +
        'dsh_delegate con una tarea autosuficiente y el cwd correcto.',
    })
    return
  }
  if (method === 'notifications/initialized' || method === 'initialized') return
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
