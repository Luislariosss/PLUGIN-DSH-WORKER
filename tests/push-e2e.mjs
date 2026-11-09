// Prueba del aviso directo DSH → Claude Code sin Claude Code ni DSH:
// levanta un plugin falso por HTTP, un buzón falso (named pipe) y lanza mcp/server.mjs por
// stdio. Comprueba los dos transportes:
//   1. buzón de la sesión (cross-session messaging): auth + {type:'user',message:{…}}
//   2. canal MCP notifications/claude/channel (fallback)
// y la semántica de acuse (dsh_channel_ack), backlog y tareas entregadas inline por
// dsh_delegate.
//
// Uso: node tests/push-e2e.mjs   (fuera del sandbox de DSH: necesita crear procesos y pipes)
import { spawn } from 'node:child_process'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createPipeServer } from 'node:net'
import { createInterface } from 'node:readline'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const serverPath = path.join(root, 'mcp', 'server.mjs')
const POLL_MS = 200

let failed = 0
const children = []
function ok(name, extra = '') {
  console.log(`  PASS  ${name}${extra ? ` — ${extra}` : ''}`)
}
function fail(name, detail) {
  failed += 1
  console.log(`  FAIL  ${name} — ${detail}`)
}

// ── Plugin falso (HTTP) ───────────────────────────────────────────────────────
const bridge = {
  token: randomBytes(32).toString('hex'),
  events: [],
  lastSeq: 2, // backlog: dos avisos viejos que no deben empujarse al arrancar
  ackedSeq: 0,
  tasks: new Map(),
  eventRequests: 0,
}
bridge.events.push(
  { seq: 1, kind: 'done', taskId: 'tsk_aaaaaaaaaaaa', sessionId: 'session-vieja-1', summary: 'backlog uno', at: Date.now() - 120000 },
  { seq: 2, kind: 'done', taskId: 'tsk_bbbbbbbbbbbb', sessionId: 'session-vieja-2', summary: 'backlog dos', at: Date.now() - 60000 },
)

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

const fakePlugin = createHttpServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${bridge.token}`) {
    return json(res, 401, { error: { code: 'auth/invalid-token', message: 'Token inválido o ausente' } })
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const method = req.method ?? 'GET'
  if (method === 'GET' && url.pathname === '/v1/health') {
    return json(res, 200, { ok: true, version: '1.0.0', pid: process.pid, port: bridge.port, startedAt: Date.now(), tasks: { total: bridge.tasks.size, running: 0, done: bridge.events.length, error: 0 } })
  }
  if (method === 'GET' && url.pathname === '/v1/events') {
    bridge.eventRequests += 1
    const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10) || 0
    return json(res, 200, { events: bridge.events.filter((event) => event.seq > since), lastSeq: bridge.lastSeq })
  }
  if (method === 'POST' && url.pathname === '/v1/events/ack') {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      try {
        const parsed = JSON.parse(raw || '{}')
        bridge.ackedSeq = Math.max(bridge.ackedSeq, Math.floor(Number(parsed.seq) || 0))
        json(res, 200, { ackedSeq: bridge.ackedSeq })
      } catch {
        json(res, 400, { error: { code: 'body/invalid', message: 'JSON inválido' } })
      }
    })
    return
  }
  if (method === 'POST' && url.pathname === '/v1/tasks') {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      const task = {
        taskId: 'tsk_' + randomBytes(6).toString('hex'),
        sessionId: 'session-' + randomBytes(4).toString('hex'),
        status: 'running',
        prompt: 'prueba',
        cwd: root,
        preset: null,
        permission: null,
        workers: true,
        client: 'claude-code',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        turns: 1,
      }
      bridge.tasks.set(task.taskId, task)
      json(res, 201, task)
    })
    return
  }
  const taskMatch = /^\/v1\/tasks\/([A-Za-z0-9_-]+)(?:\/(wait|messages|cancel))?$/.exec(url.pathname)
  if (taskMatch) {
    const task = bridge.tasks.get(taskMatch[1])
    if (!task) return json(res, 404, { error: { code: 'task/not-found', message: 'No existe' } })
    if (method === 'GET' && taskMatch[2] === undefined) return json(res, 200, task)
    if (method === 'POST' && taskMatch[2] === 'wait') {
      task.status = 'done'
      task.result = { text: 'LISTO_DESDE_FAKE_DSH' }
      task.completedAt = Date.now()
      return json(res, 200, task)
    }
    if (method === 'POST' && (taskMatch[2] === 'cancel' || taskMatch[2] === 'messages')) return json(res, 200, task)
  }
  json(res, 404, { error: { code: 'route/not-found', message: `Ruta desconocida: ${method} ${url.pathname}` } })
})
await new Promise((resolve) => fakePlugin.listen(0, '127.0.0.1', resolve))
bridge.port = fakePlugin.address().port

// ── Buzón falso (named pipe / unix socket) ───────────────────────────────────
const pipeName =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\dsh-bridge-test-${process.pid}-${randomBytes(4).toString('hex')}`
    : path.join(os.tmpdir(), `dsh-bridge-test-${process.pid}-${randomBytes(4).toString('hex')}.sock`)
const inbox = { token: randomBytes(16).toString('hex'), received: [], connections: 0 }
const fakeInbox = createPipeServer((socket) => {
  inbox.connections += 1
  let buffer = ''
  socket.setEncoding('utf8')
  socket.on('data', (chunk) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (line) {
        try {
          inbox.received.push(JSON.parse(line))
        } catch {
          inbox.received.push({ raw: line })
        }
      }
      newline = buffer.indexOf('\n')
    }
  })
})
await new Promise((resolve, reject) => {
  fakeInbox.once('error', reject)
  fakeInbox.listen(pipeName, resolve)
})

// ── Carpeta del puente ───────────────────────────────────────────────────────
const bridgeDir = await mkdtemp(path.join(os.tmpdir(), 'dsh-push-'))
await writeFile(path.join(bridgeDir, 'token'), bridge.token + '\n', 'utf8')
await writeFile(
  path.join(bridgeDir, 'state.json'),
  JSON.stringify({ version: 1, host: '127.0.0.1', port: bridge.port, pid: process.pid, startedAt: Date.now() }),
  'utf8',
)

function baseEnv() {
  const env = { ...process.env, DSH_BRIDGE_DIR: bridgeDir, DSH_BRIDGE_CHANNEL_POLL_MS: String(POLL_MS) }
  // El test no debe hablar con el buzón real de la sesión desde la que se lance.
  delete env.CLAUDE_CODE_MESSAGING_SOCKET
  delete env.CLAUDE_CODE_MESSAGING_TOKEN
  delete env.CLAUDE_CODE_SESSION_ID
  delete env.CLAUDE_PID
  delete env.CLAUDE_CONFIG_DIR
  return env
}

/** Lanza mcp/server.mjs y devuelve helpers para hablarle por stdio. */
function startMcp(extraEnv) {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...baseEnv(), ...extraEnv },
  })
  children.push(child)
  const state = { pending: new Map(), notifications: [], nextId: 1 }
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
  rl.on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.method === 'notifications/claude/channel') {
      state.notifications.push(message)
      return
    }
    const resolve = state.pending.get(message.id)
    if (resolve) {
      state.pending.delete(message.id)
      resolve(message)
    }
  })
  function request(method, params, timeoutMs = 15000) {
    const id = state.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout esperando ${method}`)), timeoutMs)
      state.pending.set(id, (value) => {
        clearTimeout(timer)
        resolve(value)
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }
  async function callTool(name, args) {
    const response = await request('tools/call', { name, arguments: args })
    if (response?.error) throw new Error(`${name}: ${response.error.message}`)
    return {
      text: (response?.result?.content ?? []).map((part) => part.text ?? '').join('\n'),
      isError: response?.result?.isError === true,
    }
  }
  async function initialize() {
    const init = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'push-e2e', version: '1.0.0' },
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
    return init
  }
  return { child, state, request, callTool, initialize }
}

async function waitFor(predicate, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  fail(label, `no ocurrió en ${timeoutMs} ms`)
  return false
}

function addEvent(kind, taskId, summary) {
  bridge.lastSeq += 1
  const event = { seq: bridge.lastSeq, kind, taskId, sessionId: 'session-' + randomBytes(3).toString('hex'), summary, at: Date.now() }
  bridge.events.push(event)
  return event
}

try {
  // ── Fase 1: buzón de la sesión (push real) ─────────────────────────────────
  console.log('Fase 1 · buzón de la sesión')
  const mcp1 = startMcp({
    CLAUDE_CODE_MESSAGING_SOCKET: pipeName,
    CLAUDE_CODE_MESSAGING_TOKEN: inbox.token,
  })
  const init1 = await mcp1.initialize()
  if (init1?.result?.capabilities?.experimental?.['claude/channel']) ok('initialize declara claude/channel (fallback)')
  else fail('initialize declara claude/channel (fallback)', JSON.stringify(init1?.result?.capabilities))
  if (String(init1?.result?.instructions ?? '').includes('dsh_channel_ack')) ok('instructions menciona dsh_channel_ack')
  else fail('instructions menciona dsh_channel_ack', String(init1?.result?.instructions ?? '').slice(0, 120))

  await waitFor(() => bridge.eventRequests > 0, 'sincronización inicial del canal')
  await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4))
  if (inbox.received.length === 0 && mcp1.state.notifications.length === 0) ok('no empuja el backlog del arranque')
  else fail('no empuja el backlog del arranque', JSON.stringify({ inbox: inbox.received.length, canal: mcp1.state.notifications.length }))

  const live = addEvent('done', 'tsk_cccccccccccc', 'Resumen de la tarea terminada')
  await waitFor(() => inbox.received.length >= 2, 'mensaje en el buzón')
  const auth = inbox.received[0]
  const user = inbox.received[1]
  if (auth?.type === 'auth' && auth.token === inbox.token) ok('buzón: primera línea = auth con el token de la sesión')
  else fail('buzón: primera línea = auth con el token de la sesión', JSON.stringify(auth))
  if (user?.type === 'user' && user?.message?.role === 'user' && String(user?.message?.content ?? '').includes('DSH terminó la tarea')) {
    ok('buzón: mensaje {type:user,message:{role:user,content}}')
  } else {
    fail('buzón: mensaje {type:user,message:{role:user,content}}', JSON.stringify(user).slice(0, 300))
  }
  if (String(user?.message?.content ?? '').includes(`seq=${live.seq}`) && String(user?.message?.content ?? '').includes(live.taskId)) {
    ok('mensaje con task_id y seq')
  } else {
    fail('mensaje con task_id y seq', String(user?.message?.content ?? '').slice(0, 200))
  }
  if (mcp1.state.notifications.length === 0) ok('con buzón no manda además el canal MCP')
  else fail('con buzón no manda además el canal MCP', `${mcp1.state.notifications.length} notificación(es)`)

  const ack1 = await mcp1.callTool('dsh_channel_ack', { seq: live.seq })
  if (!ack1.isError && bridge.ackedSeq === live.seq) ok('dsh_channel_ack avanza el cursor', `ackedSeq=${bridge.ackedSeq}`)
  else fail('dsh_channel_ack avanza el cursor', `ackedSeq=${bridge.ackedSeq} · ${ack1.text}`)
  mcp1.child.kill()
  await new Promise((resolve) => setTimeout(resolve, 300))

  // ── Fase 2: sin buzón → canal MCP (fallback) ───────────────────────────────
  console.log('Fase 2 · sin buzón: canal MCP')
  const mcp2 = startMcp({})
  await mcp2.initialize()
  await waitFor(() => bridge.eventRequests > 1, 'sincronización inicial del canal (fase 2)')
  await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4))

  const fallback = addEvent('error', 'tsk_dddddddddddd', 'Falló el fake')
  await waitFor(() => mcp2.state.notifications.length >= 1, 'notificación de canal MCP')
  const params = mcp2.state.notifications[0]?.params
  if (params?.meta?.seq === String(fallback.seq)) ok('canal MCP: meta.seq correcto', params.meta.seq)
  else fail('canal MCP: meta.seq correcto', JSON.stringify(params?.meta))
  if (params?.meta?.task_id === fallback.taskId && String(params?.content ?? '').includes('DSH falló en la tarea')) {
    ok('canal MCP: contenido y task_id')
  } else {
    fail('canal MCP: contenido y task_id', String(params?.content ?? '').slice(0, 160))
  }

  // Tarea cuyo resultado vuelve en dsh_delegate: se confirma sin despertar a Claude.
  const delegate = await mcp2.callTool('dsh_delegate', { task: 'prueba inline', wait_seconds: 30 })
  const inlineTaskId = /task_id:\s*(\S+)/.exec(delegate.text)?.[1]
  if (delegate.text.includes('LISTO_DESDE_FAKE_DSH')) ok('dsh_delegate devolvió el resultado', inlineTaskId ?? '')
  else fail('dsh_delegate devolvió el resultado', delegate.text.slice(0, 200))
  const before = mcp2.state.notifications.length
  const inlineEvent = addEvent('done', inlineTaskId, 'resultado ya entregado en la tool')
  await waitFor(() => bridge.ackedSeq >= inlineEvent.seq, 'auto-ack de la tarea entregada inline')
  await new Promise((resolve) => setTimeout(resolve, POLL_MS * 3))
  if (mcp2.state.notifications.length === before) ok('no empuja la tarea ya entregada con dsh_delegate')
  else fail('no empuja la tarea ya entregada con dsh_delegate', `${mcp2.state.notifications.length - before} notificación(es) de más`)

  // Una misma tarea puede volver a cerrar tras un follow-up: ese cierre sí debe avisar.
  const followup = await mcp2.callTool('dsh_followup', { task_id: inlineTaskId, message: 'otra vuelta' })
  if (!followup.isError) ok('dsh_followup aceptado')
  else fail('dsh_followup aceptado', followup.text.slice(0, 200))
  const beforeFollow = mcp2.state.notifications.length
  addEvent('done', inlineTaskId, 'nuevo cierre tras follow-up')
  await waitFor(() => mcp2.state.notifications.length > beforeFollow, 'aviso del cierre tras follow-up')
  if (mcp2.state.notifications.length > beforeFollow) ok('tras follow-up sí empuja el nuevo cierre')
  else fail('tras follow-up sí empuja el nuevo cierre', 'sin notificación')

  const list = await mcp2.request('tools/list', {})
  const names = (list?.result?.tools ?? []).map((tool) => tool.name)
  if (names.includes('dsh_channel_ack') && names.length === 9) ok('tools/list incluye dsh_channel_ack (9 tools)', names.join(', '))
  else fail('tools/list incluye dsh_channel_ack (9 tools)', names.join(', '))
  mcp2.child.kill()
} catch (error) {
  fail('excepción', String(error))
} finally {
  for (const child of children) {
    try {
      child.kill()
    } catch {}
  }
  const closeWithTimeout = (server) =>
    Promise.race([
      new Promise((resolve) => server.close(() => resolve())),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ])
  await closeWithTimeout(fakeInbox)
  await closeWithTimeout(fakePlugin)
  await rm(bridgeDir, { recursive: true, force: true }).catch(() => {})
}

console.log(failed === 0 ? '\nPUSH E2E OK' : `\nPUSH E2E con ${failed} fallo(s)`)
process.exit(failed === 0 ? 0 : 1)
