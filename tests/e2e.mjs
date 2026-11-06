// Prueba end-to-end del puente: usa SOLO el HTTP del plugin (no MCP).
// Uso: node tests/e2e.mjs
// Requiere: DSH Desktop abierto con el plugin @local/dsh-claude-bridge cargado.
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const dir = process.env.DSH_BRIDGE_DIR ?? path.join(os.homedir(), '.dsh', 'claude-bridge')
const statePath = path.join(dir, 'state.json')
const tokenPath = path.join(dir, 'token')
const eventsPath = path.join(dir, 'events.jsonl')

let failures = 0
function ok(name, extra = '') {
  console.log(`  PASS  ${name}${extra ? ` — ${extra}` : ''}`)
}
function fail(name, detail) {
  failures += 1
  console.log(`  FAIL  ${name} — ${detail}`)
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

let state
let token
let base

async function call(method, url, body, timeout = 40000) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  const text = await response.text()
  let json
  try {
    json = text ? JSON.parse(text) : undefined
  } catch {
    json = undefined
  }
  if (!response.ok) {
    throw new Error(`${method} ${url} → HTTP ${response.status}: ${text.slice(0, 400)}`)
  }
  return json
}

async function waitTask(taskId, timeoutMs = 240000) {
  const deadline = Date.now() + timeoutMs
  let task
  while (Date.now() < deadline) {
    task = await call('POST', `/v1/tasks/${taskId}/wait`, { timeoutMs: 25000 }, 40000)
    if (['done', 'error', 'cancelled', 'waiting-input'].includes(task.status)) return task
    await sleep(500)
  }
  return task
}

async function main() {
  console.log(`bridge dir: ${dir}`)

  // 1. state.json + token
  try {
    state = JSON.parse(await readFile(statePath, 'utf8'))
    token = (await readFile(tokenPath, 'utf8')).trim()
    base = `http://${state.host}:${state.port}`
    ok('state.json y token legibles', `${base} pid=${state.pid}`)
  } catch (error) {
    fail('state.json/token', String(error))
    console.log('\nAbre DeepSeek Harness (plugin dsh-claude-bridge) y vuelve a intentar.')
    process.exitCode = 1; return
  }

  // 2. health
  try {
    const health = await call('GET', '/v1/health')
    ok('GET /v1/health', `ok=${health.ok} version=${health.version ?? '?'}`)
  } catch (error) {
    fail('GET /v1/health', String(error))
    process.exitCode = 1; return
  }

  // 3. crear tarea y esperar resultado
  const cwd = path.dirname(process.cwd())
  let task
  try {
    task = await call('POST', '/v1/tasks', {
      prompt: 'Responde SOLO con la palabra exacta PUENTE_OK, sin usar herramientas ni explicar nada.',
      cwd,
      workers: false,
      client: 'e2e-test',
    })
    ok('POST /v1/tasks', `task=${task.taskId} session=${task.sessionId} status=${task.status}`)
  } catch (error) {
    fail('POST /v1/tasks', String(error))
    process.exitCode = 1; return
  }

  try {
    task = await waitTask(task.taskId)
    if (task.status === 'done' && task.result?.text?.includes('PUENTE_OK')) {
      ok('tarea terminada con resultado', JSON.stringify(task.result.text.slice(0, 120)))
    } else {
      fail('resultado de la tarea', `status=${task.status} result=${JSON.stringify(task.result)} error=${JSON.stringify(task.error)}`)
    }
  } catch (error) {
    fail('wait de la tarea', String(error))
  }

  // 4. evento de finalización
  try {
    const events = await call('GET', '/v1/events?since=0')
    const found = (events.events ?? []).find((event) => event.taskId === task.taskId && event.kind === 'done')
    if (found) ok('evento done en events.jsonl', `seq=${found.seq}`)
    else fail('evento done', `no aparece en ${eventsPath}: ${JSON.stringify(events).slice(0, 300)}`)
  } catch (error) {
    fail('GET /v1/events', String(error))
  }

  // 5. follow-up en el mismo hilo
  try {
    const followed = await call('POST', `/v1/tasks/${task.taskId}/messages`, {
      text: 'Responde SOLO con la palabra exacta SEGUNDO_OK, sin herramientas.',
    })
    if (followed.status === 'running' || followed.status === 'done') ok('POST /v1/tasks/:id/messages', `status=${followed.status}`)
    else fail('follow-up', `status=${followed.status}`)
    const finalTask = await waitTask(task.taskId)
    if (finalTask.status === 'done' && finalTask.result?.text?.includes('SEGUNDO_OK')) {
      ok('follow-up terminado', JSON.stringify(finalTask.result.text.slice(0, 120)))
    } else {
      fail('follow-up resultado', `status=${finalTask.status} result=${JSON.stringify(finalTask.result)}`)
    }
  } catch (error) {
    fail('follow-up', String(error))
  }

  // 6. 404 para tarea inexistente
  try {
    await call('GET', '/v1/tasks/tsk_inexistente')
    fail('404 de tarea inexistente', 'devolvió 200')
  } catch (error) {
    if (String(error).includes('HTTP 404')) ok('404 de tarea inexistente')
    else fail('404 de tarea inexistente', String(error))
  }

  console.log(failures === 0 ? '\nE2E OK' : `\nE2E con ${failures} fallo(s)`)
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((error) => {
  console.error('E2E crash:', error)
  process.exitCode = 1; return
})
