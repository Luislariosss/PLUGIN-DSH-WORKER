/**
 * Puente Claude Code ⇄ DeepSeek Harness (lado Host).
 *
 * Corre DENTRO del proceso de DeepSeek Harness (perfil desktop). Expone un HTTP local
 * (127.0.0.1 + token Bearer) que el servidor MCP `dsh-bridge` usa para crear sesiones
 * reales de DSH, mandarles prompts, esperar su finalización y devolver el resultado.
 *
 * Solo builtins de Node: un bundle instalado en el perfil no tiene resolución garantizada
 * de los paquetes @deepseek-ai/*.
 *
 * Contrato: docs/PROTOCOL.md
 */
import http from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile, appendFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import os from 'node:os'

export const name = 'claude-bridge'
export const inject = ['sessionController', 'sessions']

const VERSION = '1.0.0'
const LOG = '[claude-bridge]'
const EVENT_KINDS = new Set(['done', 'error', 'waiting-input', 'cancelled'])
const FINAL_STATUSES = new Set(['done', 'error', 'cancelled'])
const MAX_BODY_BYTES = 1024 * 1024
const PROMPT_MAX = 60000
const MAX_PERSISTED_TASKS = 200
const SAVE_DEBOUNCE_MS = 300
const TASK_STATUSES = new Set(['queued', 'running', 'waiting-input', 'done', 'error', 'cancelled'])
const TASK_ID_RE = /^tsk_[0-9a-f]{12}$/
// Tras un seguimiento, un cierre sin evidencia durable no se acepta antes de este plazo.
const FOLLOWUP_GRACE_MS = 2000

function log(...args) {
  console.error(LOG, ...args)
}

function readSettings(config) {
  const c = config && typeof config === 'object' ? config : {}
  const bridgeDir =
    typeof c.bridgeDir === 'string' && c.bridgeDir.length > 0
      ? c.bridgeDir
      : join(os.homedir(), '.dsh', 'claude-bridge')
  const settings = {
    port: Number.isInteger(c.port) && c.port > 0 && c.port < 65536 ? c.port : 49777,
    host: typeof c.host === 'string' && c.host.length > 0 ? c.host : '127.0.0.1',
    bridgeDir,
    defaultCwd: typeof c.defaultCwd === 'string' && c.defaultCwd.length > 0 ? c.defaultCwd : null,
    agentPreset: typeof c.agentPreset === 'string' && c.agentPreset.length > 0 ? c.agentPreset : null,
    permission: typeof c.permission === 'string' && c.permission.length > 0 ? c.permission : null,
    // Permite que las peticiones pidan permission 'danger-full-access'. Desactivado por defecto.
    allowFullAccess: c.allowFullAccess === true,
    maxConcurrent: Number.isInteger(c.maxConcurrent) && c.maxConcurrent > 0 ? c.maxConcurrent : 4,
    clientTimeZone:
      typeof c.clientTimeZone === 'string' && c.clientTimeZone.length > 0
        ? c.clientTimeZone
        : 'America/Mexico_City',
    maxTaskMs:
      Number.isInteger(c.maxTaskMs) && c.maxTaskMs > 0 ? c.maxTaskMs : 6 * 60 * 60 * 1000,
  }
  if (settings.permission === 'danger-full-access' && !settings.allowFullAccess) {
    log(
      'AVISO: permission de la config del plugin es danger-full-access sin allowFullAccess: true. ' +
        'Las sesiones sin permission explicito en la peticion se rechazaran con 403 hasta que lo habilites.',
    )
  }
  return settings
}

class BridgeHttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

function now() {
  return Date.now()
}

function taskId() {
  return 'tsk_' + randomBytes(6).toString('hex')
}

function requestId() {
  return 'req_' + randomBytes(12).toString('hex')
}

function toJson(value) {
  return JSON.stringify(value)
}

function blocksToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

function lastAssistantText(ctx, sessionId) {
  const session = ctx.sessions.get(sessionId)
  if (!session) return null
  let messages
  try {
    messages = session.deriveMessages()
  } catch (error) {
    log('deriveMessages falló:', error)
    return null
  }
  if (!Array.isArray(messages) || messages.length === 0) return null
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (message && message.role === 'assistant') return blocksToText(message.content)
  }
  return null
}

/** Lee la cola durable de la sesión (cold-safe) vía sessionController.events. */
async function readTail(ctx, sessionId) {
  // Builds con sessionController.events() (contrato original).
  if (typeof ctx.sessionController.events === 'function') {
    try {
      const page = await ctx.sessionController.events(
        { address: { kind: 'session', sessionId }, maxMessages: 60 },
        new AbortController().signal,
      )
      const records = Array.isArray(page?.records) ? page.records : []
      return records
        .filter((record) => record && record.type === 'event' && record.event)
        .map((record) => record.event)
    } catch (error) {
      log('events() falló para', sessionId, error)
    }
  }
  // DSH 0.2.x: inspect(sessionId, signal) → { meta, inheritedEventCount, events }.
  if (typeof ctx.sessionController.inspect === 'function') {
    try {
      const view = await ctx.sessionController.inspect(sessionId, new AbortController().signal)
      const events = Array.isArray(view?.events) ? view.events : []
      return events.slice(-60)
    } catch (error) {
      log('inspect() falló para', sessionId, error)
    }
  }
  return null
}

/** Fila viva de la sesión según sessionController.list() (compat DSH 0.2.x). */
async function liveRowOf(ctx, sessionId) {
  if (typeof ctx.sessionController.list !== 'function') return null
  try {
    const page = await ctx.sessionController.list({}, new AbortController().signal)
    const items = Array.isArray(page?.items) ? page.items : []
    return items.find((row) => row && row.sessionId === sessionId) ?? null
  } catch (error) {
    log('list() falló:', error)
    return null
  }
}

function assistantTextOfEvent(event) {
  const content = event?.data?.message?.content
  return blocksToText(content)
}

/**
 * Cierra la tarea si la evidencia durable dice que ya terminó.
 * Devuelve 'done' | 'error' | 'cancelled' | 'waiting-input' | null (sigue).
 */
function evaluateTail(task, events) {
  if (!Array.isArray(events) || events.length === 0) return null
  let lastEnd = null
  let lastAssistant = null
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (!event) continue
    if (event.type === 'turn/end' && lastEnd === null) lastEnd = event
    if (event.type === 'assistant/message' && lastAssistant === null) lastAssistant = event
    if (lastEnd && lastAssistant) break
  }
  if (lastEnd) {
    const turn = Number(lastEnd.data?.turn) || 0
    const reason = lastEnd.data?.reason?.kind
    if (turn < (task.turns ?? 1)) return null
    const text = lastAssistant ? assistantTextOfEvent(lastAssistant) : ''
    if (reason === 'completed') return { status: 'done', text }
    if (reason === 'error') {
      return {
        status: 'error',
        message: lastEnd.data?.reason?.error?.message ?? 'El turno terminó con error en DSH',
      }
    }
    if (reason === 'aborted' || reason === 'interrupted' || reason === 'forked') {
      return { status: 'cancelled' }
    }
    if (reason === 'blocked') return { status: 'waiting-input' }
    if (reason === 'max-tokens') return { status: 'done', text }
    return { status: 'done', text }
  }
  return null
}


function publicTask(task) {
  return {
    taskId: task.taskId,
    sessionId: task.sessionId,
    status: task.status,
    prompt: task.prompt,
    cwd: task.cwd,
    preset: task.preset,
    permission: task.permission,
    workers: task.workers,
    client: task.client,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    turns: task.turns,
    result: task.result,
    error: task.error,
  }
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new BridgeHttpError(413, 'body/too-large', 'Cuerpo mayor a 1 MB')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new BridgeHttpError(400, 'body/invalid', 'El cuerpo JSON debe ser un objeto')
    }
    return parsed
  } catch (error) {
    if (error instanceof BridgeHttpError) throw error
    throw new BridgeHttpError(400, 'body/invalid-json', 'JSON inválido en el cuerpo')
  }
}

/** Construye el puente: servidor HTTP, estado de tareas y ciclo de vida. */
function createBridge(ctx, settings) {
  const tasks = new Map()
  let server = null
  let listening = false
  let closed = false
  let token = null
  let lastSeq = 0
  let actualPort = settings.port
  let startedAt = now()
  let pollTimer = null
  let pollBusy = false

  const paths = {
    dir: settings.bridgeDir,
    token: join(settings.bridgeDir, 'token'),
    state: join(settings.bridgeDir, 'state.json'),
    events: join(settings.bridgeDir, 'events.jsonl'),
    cursor: join(settings.bridgeDir, 'cursor.json'),
    tasks: join(settings.bridgeDir, 'tasks.json'),
  }

  async function ensureBridgeDir() {
    await mkdir(paths.dir, { recursive: true })
  }

  let saveTimer = null
  let saveChain = Promise.resolve()

  /**
   * Escribe tasks.json (las MAX_PERSISTED_TASKS más recientes) de forma atómica:
   * archivo temporal + rename. Las escrituras se encadenan para no solaparse.
   */
  function persistNow() {
    const payload = toJson({
      version: 1,
      savedAt: now(),
      tasks: [...tasks.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, MAX_PERSISTED_TASKS),
    })
    saveChain = saveChain.then(async () => {
      const tmp = `${paths.tasks}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
      try {
        await ensureBridgeDir()
        await writeFile(tmp, payload, 'utf8')
        await rename(tmp, paths.tasks)
      } catch (error) {
        log('no se pudo escribir tasks.json:', error)
        await rm(tmp, { force: true }).catch(() => {})
      }
    })
    return saveChain
  }

  /** Debounce corto: agrupa cambios de estado seguidos en una sola escritura. */
  function scheduleSave() {
    if (saveTimer) return
    saveTimer = setTimeout(() => {
      saveTimer = null
      persistNow().catch((error) => log('persistNow falló:', error))
    }, SAVE_DEBOUNCE_MS)
    if (typeof saveTimer.unref === 'function') saveTimer.unref()
  }

  function isPersistedTask(value) {
    return (
      value !== null &&
      typeof value === 'object' &&
      typeof value.taskId === 'string' &&
      TASK_ID_RE.test(value.taskId) &&
      typeof value.sessionId === 'string' &&
      value.sessionId.length > 0 &&
      TASK_STATUSES.has(value.status) &&
      typeof value.createdAt === 'number'
    )
  }

  /** Repuebla el Map desde tasks.json (máximo MAX_PERSISTED_TASKS, las más recientes). */
  async function loadTasks() {
    let parsed
    try {
      parsed = JSON.parse(await readFile(paths.tasks, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') log('tasks.json ilegible, se ignora:', error.message)
      return 0
    }
    const list = Array.isArray(parsed?.tasks) ? parsed.tasks : []
    const restored = list
      .filter(isPersistedTask)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_PERSISTED_TASKS)
    for (const task of restored) {
      // 'queued' no lo sondea el poller: al recargar lo tratamos como en curso para que settle() lo reevalúe.
      if (task.status === 'queued') task.status = 'running'
      tasks.set(task.taskId, task)
    }
    return restored.length
  }

  async function loadToken() {
    await ensureBridgeDir()
    try {
      const existing = (await readFile(paths.token, 'utf8')).trim()
      if (/^[0-9a-f]{64}$/.test(existing)) return existing
    } catch {}
    const fresh = randomBytes(32).toString('hex')
    await writeFile(paths.token, fresh + '\n', { encoding: 'utf8', mode: 0o600 })
    log('token creado en', paths.token)
    return fresh
  }

  async function loadEventsSeq() {
    try {
      const text = await readFile(paths.events, 'utf8')
      const lines = text.split('\n').filter((line) => line.trim().length > 0)
      let max = 0
      for (const line of lines) {
        try {
          const event = JSON.parse(line)
          if (typeof event.seq === 'number' && event.seq > max) max = event.seq
        } catch {}
      }
      return max
    } catch {
      return 0
    }
  }

  function authorized(req) {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const prefix = 'Bearer '
    if (!header.startsWith(prefix)) return false
    const provided = header.slice(prefix.length).trim()
    if (provided.length !== token.length) return false
    try {
      return timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(token, 'utf8'))
    } catch {
      return false
    }
  }

  function sendJson(res, status, payload) {
    if (res.writableEnded) return
    const body = toJson(payload)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Dsh-Bridge': VERSION,
    })
    res.end(body)
  }

  function sendError(res, error) {
    if (error instanceof BridgeHttpError) {
      sendJson(res, error.status, { error: { code: error.code, message: error.message } })
      return
    }
    log('error no controlado:', error)
    sendJson(res, 500, {
      error: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
    })
  }

  function touch(task) {
    task.updatedAt = now()
  }

  async function appendEvent(kind, task, summary) {
    lastSeq += 1
    const event = {
      seq: lastSeq,
      kind,
      taskId: task.taskId,
      sessionId: task.sessionId,
      summary: String(summary ?? '').slice(0, 2000),
      at: now(),
    }
    try {
      await appendFile(paths.events, toJson(event) + '\n', 'utf8')
    } catch (error) {
      log('no se pudo escribir events.jsonl:', error)
    }
    return event
  }

  async function stateOf(sessionId, signal) {
    try {
      return await ctx.sessionController.state({ sessionId }, signal ?? new AbortController().signal)
    } catch (error) {
      log('state() falló para', sessionId, error)
      return null
    }
  }

  async function finalize(task, status, text, errorMessage) {
    if (FINAL_STATUSES.has(task.status)) return task
    task.status = status
    touch(task)
    task.completedAt = task.updatedAt
    task.followupAt = undefined
    task.lastResultText = undefined
    if (status === 'done') {
      const summary = (text ?? '').trim()
      task.result = { text: summary.slice(0, 200000) }
      if (summary.length > 200000) task.result.truncated = true
      await appendEvent('done', task, summary.slice(0, 2000) || '(sin texto final)')
    } else if (status === 'error') {
      task.error = { message: String(errorMessage ?? 'error desconocido').slice(0, 4000) }
      await appendEvent('error', task, task.error.message)
    } else if (status === 'cancelled') {
      await appendEvent('cancelled', task, 'Tarea cancelada')
    }
    scheduleSave()
    return task
  }

  /** Comprueba si la sesión ya terminó y, si sí, cierra la tarea. */
  async function markWaiting(task, detail) {
    if (task.status !== 'waiting-input') {
      task.status = 'waiting-input'
      touch(task)
      scheduleSave()
    }
    if (!task.waitingNotified) {
      task.waitingNotified = true
      await appendEvent('waiting-input', task, 'DSH pide aprobación/pregunta en su GUI' + (detail ? ': ' + detail : ''))
    }
    return task
  }

  /**
   * Texto válido para cerrar la tarea: vacío si es el resultado del turno anterior
   * (tras un seguimiento, lastAssistantText puede devolverlo antes que el turno nuevo).
   */
  function freshText(task, text) {
    if (text === null || text === undefined) return ''
    if (task.followupAt !== undefined && text === task.lastResultText) return ''
    return text
  }

  /**
   * Cierre SIN evidencia durable (fallbacks de state()/list()): tras un seguimiento no vale si el
   * texto es igual al resultado anterior o si aún no pasó FOLLOWUP_GRACE_MS desde followupAt.
   */
  function nonDurableCloseIsStale(task, text) {
    if (task.followupAt === undefined) return false
    if (text !== null && text === task.lastResultText) return true
    return now() - task.followupAt < FOLLOWUP_GRACE_MS
  }

  /** Comprueba si la sesión ya terminó (evidencia durable primero) y cierra la tarea. */
  async function settle(task) {
    if (FINAL_STATUSES.has(task.status)) return task
    if (task.status === 'queued') return task
    const state = await stateOf(task.sessionId)
    const pendingInput = Array.isArray(state?.pendingInput) ? state.pendingInput : []
    if (pendingInput.length > 0) return markWaiting(task, pendingInput.join(', '))

    const tail = await readTail(ctx, task.sessionId)
    const verdict = evaluateTail(task, tail)
    if (verdict) {
      if (verdict.status === 'done') {
        // Evidencia durable: turn/end con turn >= task.turns, así que el turno es el nuevo.
        const text =
          verdict.text && verdict.text.length > 0 ? verdict.text : freshText(task, lastAssistantText(ctx, task.sessionId))
        return finalize(task, 'done', text)
      }
      if (verdict.status === 'error') return finalize(task, 'error', null, verdict.message)
      if (verdict.status === 'cancelled') return finalize(task, 'cancelled', null, null)
      if (verdict.status === 'waiting-input') return markWaiting(task, 'turn/end blocked')
    }

    if (state === null) {
      // Builds sin sessionController.state(): la fila de list() da la señal viva.
      const row = await liveRowOf(ctx, task.sessionId)
      if (row === null) {
        if (now() - task.createdAt > 60000) {
          return finalize(task, 'error', null, 'La sesión de DSH ya no está viva')
        }
        return task
      }
      if (row.running === true || row.agentAvailable === true) {
        if (task.status === 'waiting-input') {
          task.status = 'running'
          scheduleSave()
        }
        task.seenLive = true
        touch(task)
        return task
      }
      if (task.seenLive === true) {
        const liveText = lastAssistantText(ctx, task.sessionId)
        if (liveText !== null && !nonDurableCloseIsStale(task, liveText)) return finalize(task, 'done', liveText)
      }
      return task
    }

    const queue = Array.isArray(state.queue) ? state.queue : []
    if (state.running || state.active || queue.length > 0) {
      if (task.status === 'waiting-input') {
        task.status = 'running'
        scheduleSave()
      }
      touch(task)
      return task
    }
    // Fallback si la lectura durable no está disponible: último mensaje vivo del asistente.
    const text = lastAssistantText(ctx, task.sessionId)
    if (text !== null && !nonDurableCloseIsStale(task, text)) return finalize(task, 'done', text)
    return task
  }

  async function pollOnce() {
    if (pollBusy || closed) return
    pollBusy = true
    try {
      for (const task of tasks.values()) {
        if (FINAL_STATUSES.has(task.status) || task.status === 'queued') continue
        try {
          await settle(task)
        } catch (error) {
          log('settle falló:', task.taskId, error)
        }
        if (!FINAL_STATUSES.has(task.status) && now() - task.createdAt > settings.maxTaskMs) {
          await finalize(task, 'error', null, 'Tiempo máximo de la tarea excedido')
        }
      }
    } finally {
      pollBusy = false
    }
  }

  function runningCount() {
    let count = 0
    for (const task of tasks.values()) {
      if (task.status === 'running' || task.status === 'waiting-input' || task.status === 'queued') count += 1
    }
    return count
  }

  async function checkCwd(cwd) {
    const target = cwd ?? settings.defaultCwd ?? process.cwd()
    if (typeof target !== 'string' || target.length === 0) {
      throw new BridgeHttpError(400, 'cwd/invalid', 'Falta cwd y no hay defaultCwd configurado')
    }
    if (!/^[a-zA-Z]:[\\/]/.test(target) && !target.startsWith('\\\\')) {
      throw new BridgeHttpError(400, 'cwd/not-absolute', `El cwd debe ser una ruta absoluta: ${target}`)
    }
    try {
      const info = await stat(target)
      if (!info.isDirectory()) throw new Error('no es un directorio')
    } catch (error) {
      throw new BridgeHttpError(400, 'cwd/not-found', `El cwd no existe o no es un directorio: ${target}`)
    }
    return target
  }

  async function createTask(body) {
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (prompt.length === 0) throw new BridgeHttpError(400, 'prompt/missing', 'Falta prompt')
    if (prompt.length > PROMPT_MAX) {
      throw new BridgeHttpError(400, 'prompt/too-long', `prompt mayor a ${PROMPT_MAX} caracteres`)
    }
    // Permiso EFECTIVO: el de la peticion si viene, si no el de la config. Se valida antes de crear la sesion.
    const requestedPermission =
      typeof body.permission === 'string' && body.permission.length > 0 ? body.permission : null
    const permission = requestedPermission ?? settings.permission
    if (permission === 'danger-full-access' && settings.allowFullAccess !== true) {
      const fromConfig = requestedPermission === null
      throw new BridgeHttpError(
        403,
        'permission/forbidden',
        fromConfig
          ? 'danger-full-access viene de la config del plugin (permission) y requiere tambien allowFullAccess: true en la config de claude-bridge'
          : 'danger-full-access requiere habilitarlo en el plugin: allowFullAccess: true en la config de claude-bridge',
      )
    }
    if (runningCount() >= settings.maxConcurrent) {
      throw new BridgeHttpError(
        409,
        'tasks/too-many-running',
        `Ya hay ${settings.maxConcurrent} tareas en curso. Espera o cancela alguna.`,
      )
    }
    const cwd = await checkCwd(typeof body.cwd === 'string' ? body.cwd : null)
    const preset =
      (typeof body.preset === 'string' && body.preset.length > 0 ? body.preset : null) ?? settings.agentPreset
    const workers = body.workers === false ? false : true
    const client = typeof body.client === 'string' && body.client.length > 0 ? body.client : 'claude-code'

    const created = await ctx.sessionController.create({
      cwd,
      ...(preset ? { agentPreset: preset } : {}),
    })
    const sessionId = created.sessionId
    if (!sessionId) throw new BridgeHttpError(500, 'session/create-failed', 'create() no devolvió sessionId')

    if (permission) {
      const presets = ctx.get('permissionPresets')
      const session = ctx.sessions.get(sessionId)
      if (presets && session) {
        try {
          presets.set(session, permission)
        } catch (error) {
          log('no se pudo aplicar permission preset', permission, error)
        }
      }
    }

    const task = {
      taskId: taskId(),
      sessionId,
      status: 'queued',
      prompt,
      cwd,
      preset: preset ?? null,
      permission: permission ?? null,
      workers,
      client,
      createdAt: now(),
      updatedAt: now(),
      completedAt: undefined,
      turns: 1,
      seenLive: false,
      result: undefined,
      error: undefined,
      waitingNotified: false,
    }
    tasks.set(task.taskId, task)
    scheduleSave()

    try {
      await ctx.sessionController.prompt({
        requestId: requestId(),
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text: prompt }],
        clientTimeZone: settings.clientTimeZone,
      }, new AbortController().signal)
    } catch (error) {
      await finalize(task, 'error', null, 'No se pudo admitir el prompt: ' + (error instanceof Error ? error.message : String(error)))
      throw new BridgeHttpError(502, 'prompt/rejected', task.error.message)
    }

    task.status = 'running'
    touch(task)
    scheduleSave()
    log('tarea creada', task.taskId, '→', sessionId, 'cwd=', cwd)
    return task
  }

  async function waitTask(task, body) {
    let timeoutMs = Number.isFinite(body.timeoutMs) ? Number(body.timeoutMs) : 25000
    timeoutMs = Math.max(1000, Math.min(120000, Math.trunc(timeoutMs)))
    if (task.status === 'waiting-input') return task
    const deadline = now() + timeoutMs
    if (!FINAL_STATUSES.has(task.status)) await settle(task)
    while (!FINAL_STATUSES.has(task.status) && now() < deadline) {
      const remaining = Math.max(1500, Math.min(timeoutMs, deadline - now()))
      let result
      if (typeof ctx.sessionController.wait !== 'function') {
        // DSH 0.2.x no expone wait(): sondeamos la cola durable y la fila viva.
        const nap = Math.max(250, Math.min(1000, deadline - now()))
        await new Promise((resolve) => setTimeout(resolve, nap))
        await settle(task)
        if (!FINAL_STATUSES.has(task.status) && now() >= deadline) break
        continue
      }
      try {
        result = await ctx.sessionController.wait({
          sessionId: task.sessionId,
          timeoutMs: remaining,
          maxMessages: 200,
        }, new AbortController().signal)
      } catch (error) {
        log('wait() falló:', error)
        break
      }
      if (result && result.reason === 'input-required') {
        task.status = 'waiting-input'
        touch(task)
        scheduleSave()
        if (!task.waitingNotified) {
          task.waitingNotified = true
          await appendEvent('waiting-input', task, 'DSH pide aprobación/pregunta en su GUI')
        }
        break
      }
      await settle(task)
      if (!FINAL_STATUSES.has(task.status) && result && result.reason === 'idle') {
        // Deja margen a que el turno cierre del todo antes de volver a mirar.
        await new Promise((resolve) => setTimeout(resolve, 300))
        await settle(task)
        if (FINAL_STATUSES.has(task.status)) break
      }
      if (!FINAL_STATUSES.has(task.status) && result && result.reason === 'timeout') {
        if (now() < deadline) continue
        break
      }
    }
    return task
  }

  async function sendFollowup(task, body) {
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (text.length === 0) throw new BridgeHttpError(400, 'message/missing', 'Falta text')
    if (text.length > PROMPT_MAX) {
      throw new BridgeHttpError(400, 'message/too-long', `text mayor a ${PROMPT_MAX} caracteres`)
    }
    if (FINAL_STATUSES.has(task.status) && task.status !== 'done') {
      throw new BridgeHttpError(409, 'task/closed', `La tarea está en estado ${task.status} y no admite seguimiento`)
    }
    // Resultado del turno anterior: settle() no debe cerrar la tarea con él como si fuera el nuevo.
    const previousText = typeof task.result?.text === 'string' ? task.result.text : null
    await ctx.sessionController.prompt({
      requestId: requestId(),
      sessionId: task.sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: settings.clientTimeZone,
    }, new AbortController().signal)
    task.status = 'running'
    task.followupAt = now()
    task.lastResultText = previousText
    task.completedAt = undefined
    task.error = undefined
    task.waitingNotified = false
    task.turns = (task.turns ?? 0) + 1
    touch(task)
    scheduleSave()
    return task
  }

  async function cancelTask(task) {
    if (FINAL_STATUSES.has(task.status)) return task
    try {
      await ctx.sessionController.cancel({ sessionId: task.sessionId })
    } catch (error) {
      log('cancel() falló:', error)
    }
    return finalize(task, 'cancelled', null, null)
  }

  async function readEvents(since) {
    let events = []
    try {
      const text = await readFile(paths.events, 'utf8')
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          const event = JSON.parse(line)
          if (typeof event.seq === 'number' && event.seq > since) events.push(event)
        } catch {}
      }
    } catch {}
    events.sort((a, b) => a.seq - b.seq)
    return events
  }

  async function readCursor() {
    try {
      const parsed = JSON.parse(await readFile(paths.cursor, 'utf8'))
      return typeof parsed.ackedSeq === 'number' ? parsed.ackedSeq : 0
    } catch {
      return 0
    }
  }

  async function writeCursor(seq) {
    const current = await readCursor()
    const next = Math.max(current, Math.floor(Number(seq) || 0))
    await writeFile(paths.cursor, toJson({ ackedSeq: next }), 'utf8')
    return next
  }

  function findTask(id) {
    const task = tasks.get(id)
    if (!task) throw new BridgeHttpError(404, 'task/not-found', `No existe la tarea ${id}`)
    return task
  }

  async function route(req, res) {
    if (!authorized(req)) {
      sendJson(res, 401, { error: { code: 'auth/invalid-token', message: 'Token inválido o ausente' } })
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const pathname = url.pathname
    const method = req.method ?? 'GET'

    if (method === 'GET' && pathname === '/v1/health') {
      const counts = { total: tasks.size, running: 0, done: 0, error: 0 }
      for (const task of tasks.values()) {
        if (task.status === 'done') counts.done += 1
        else if (task.status === 'error') counts.error += 1
        else if (task.status === 'running' || task.status === 'waiting-input' || task.status === 'queued') counts.running += 1
      }
      sendJson(res, 200, {
        ok: true,
        version: VERSION,
        pid: process.pid,
        port: actualPort,
        startedAt,
        tasks: counts,
      })
      return
    }

    if (method === 'POST' && pathname === '/v1/tasks') {
      const task = await createTask(await readBody(req))
      sendJson(res, 201, publicTask(task))
      return
    }

    if (method === 'GET' && pathname === '/v1/tasks') {
      const list = [...tasks.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 100)
        .map(publicTask)
      sendJson(res, 200, { tasks: list })
      return
    }

    const match = /^\/v1\/tasks\/([A-Za-z0-9_-]+)(?:\/(wait|messages|cancel))?$/.exec(pathname)
    if (match) {
      const id = match[1]
      const action = match[2]
      if (method === 'GET' && action === undefined) {
        sendJson(res, 200, publicTask(findTask(id)))
        return
      }
      if (method === 'POST' && action === 'wait') {
        const task = await waitTask(findTask(id), await readBody(req))
        sendJson(res, 200, publicTask(task))
        return
      }
      if (method === 'POST' && action === 'messages') {
        const task = await sendFollowup(findTask(id), await readBody(req))
        sendJson(res, 200, publicTask(task))
        return
      }
      if (method === 'POST' && action === 'cancel') {
        const task = await cancelTask(findTask(id))
        sendJson(res, 200, publicTask(task))
        return
      }
      throw new BridgeHttpError(405, 'method/not-allowed', `${method} no permitido en ${pathname}`)
    }

    if (method === 'GET' && pathname === '/v1/_diag') {
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId) throw new BridgeHttpError(400, 'sessionId/missing', 'Falta sessionId')
      const live = ctx.sessions.get(sessionId)
      const state = await stateOf(sessionId)
      const tail = await readTail(ctx, sessionId)
      let stateError = null
      if (state === null && typeof ctx.sessionController.state === 'function') {
        try {
          await ctx.sessionController.state({ sessionId }, new AbortController().signal)
        } catch (error) {
          stateError = error instanceof Error ? error.message : String(error)
        }
      }
      const api = {}
      for (const name of [
        'create', 'prompt', 'wait', 'state', 'events', 'inspect', 'list', 'page', 'follow',
        'projections', 'liveProjections', 'cancel', 'updateQueue', 'attachment', 'fork', 'rename',
      ]) {
        api[name] = typeof ctx.sessionController?.[name]
      }
      sendJson(res, 200, {
        live: Boolean(live),
        api,
        stateError,
        state,
        row: await liveRowOf(ctx, sessionId),
        tailTypes: (tail ?? []).map((event) => ({
          type: event.type,
          turn: event.data?.turn,
          reason: event.data?.reason?.kind,
        })),
        lastAssistant: tail ? evaluateTail({ turns: 1 }, tail) : null,
        liveLastAssistant: lastAssistantText(ctx, sessionId),
      })
      return
    }

    if (method === 'GET' && pathname === '/v1/events') {
      const sinceRaw = url.searchParams.get('since')
      const since = Number.parseInt(sinceRaw ?? '0', 10)
      const events = await readEvents(Number.isFinite(since) ? since : 0)
      sendJson(res, 200, { events, lastSeq })
      return
    }

    if (method === 'POST' && pathname === '/v1/events/ack') {
      const body = await readBody(req)
      const ackedSeq = await writeCursor(body.seq)
      sendJson(res, 200, { ackedSeq })
      return
    }

    throw new BridgeHttpError(404, 'route/not-found', `Ruta desconocida: ${method} ${pathname}`)
  }

  async function listen(candidatePorts) {
    for (const candidate of candidatePorts) {
      const result = await new Promise((resolve) => {
        const srv = http.createServer((req, res) => {
          route(req, res).catch((error) => sendError(res, error))
        })
        srv.on('error', (error) => resolve({ error }))
        srv.listen(candidate, settings.host, () => resolve({ server: srv }))
      })
      if (result.server) return { server: result.server, port: candidate }
      if (String(result.error?.code) !== 'EADDRINUSE') throw result.error
      log('puerto ocupado, probando siguiente:', candidate)
    }
    throw new Error(`No hay puerto libre entre ${candidatePorts[0]} y ${candidatePorts[candidatePorts.length - 1]}`)
  }

  async function start() {
    token = await loadToken()
    lastSeq = await loadEventsSeq()
    const restored = await loadTasks()
    if (restored > 0) log(`tareas restauradas desde tasks.json: ${restored}`)
    const candidatePorts = []
    for (let i = 0; i < 10; i += 1) candidatePorts.push(settings.port + i)
    const listened = await listen(candidatePorts)
    server = listened.server
    actualPort = listened.port
    listening = true
    startedAt = now()
    await writeFile(
      paths.state,
      toJson({ version: 1, host: settings.host, port: actualPort, pid: process.pid, startedAt }),
      'utf8',
    )
    pollTimer = setInterval(() => {
      pollOnce().catch((error) => log('poller:', error))
    }, 3000)
    if (typeof pollTimer.unref === 'function') pollTimer.unref()
    log(`escuchando en http://${settings.host}:${actualPort} (cwd default: ${settings.defaultCwd ?? process.cwd()})`)
  }

  async function close() {
    if (closed) return
    closed = true
    if (pollTimer) clearInterval(pollTimer)
    pollTimer = null
    if (server) {
      await new Promise((resolve) => server.close(() => resolve()))
      server = null
    }
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    await persistNow()
    listening = false
    try {
      await rm(paths.state, { force: true })
    } catch (error) {
      log('no se pudo borrar state.json:', error)
    }
    log('puente detenido')
  }

  /** Instala una tarea ya creada por fuera (no usado; reservado para pruebas). */
  function adopt(task) {
    tasks.set(task.taskId, task)
    scheduleSave()
    return task
  }

  return {
    start,
    close,
    adopt,
    get port() {
      return actualPort
    },
    get listening() {
      return listening
    },
    get taskCount() {
      return tasks.size
    },
  }
}

/**
 * Activa el puente dentro del Host de DSH.
 * @param ctx - contexto Cordis con sessionController y sessions.
 * @param config - fila del perfil: { port, host, bridgeDir, defaultCwd, agentPreset, permission, maxConcurrent, clientTimeZone }.
 */
export function apply(ctx, config) {
  const settings = readSettings(config)
  let bridge = null

  ctx.effect(() => {
    bridge = createBridge(ctx, settings)
    bridge.start().catch((error) => {
      log('no se pudo arrancar el puente:', error)
    })
    return async () => {
      await bridge?.close()
    }
  })
}
