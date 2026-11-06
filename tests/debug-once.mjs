// Diagnóstico rápido de una sola tarea: crea, sondea estado y muestra diag cada 3 s.
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const dir = process.env.DSH_BRIDGE_DIR ?? path.join(os.homedir(), '.dsh', 'claude-bridge')
const state = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8'))
const token = (await readFile(path.join(dir, 'token'), 'utf8')).trim()
const base = `http://${state.host}:${state.port}`
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function call(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  })
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = text
  }
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${text.slice(0, 300)}`)
  return json
}

const prompt = process.argv[2] ?? 'Responde SOLO con la palabra PUENTE_OK, sin herramientas.'
const cwd = process.argv[3] ?? 'C:\\Users\\luisl\\Downloads\\SQL'

const task = await call('POST', '/v1/tasks', { prompt, cwd, workers: false, client: 'debug-once' })
console.log('CREATED', JSON.stringify(task))
for (let i = 0; i < 40; i += 1) {
  await sleep(3000)
  const current = await call('GET', `/v1/tasks/${task.taskId}`)
  let diag = null
  try {
    diag = await call('GET', `/v1/_diag?sessionId=${encodeURIComponent(current.sessionId)}`)
  } catch (error) {
    diag = { error: String(error) }
  }
  console.log(
    `[${i}]`,
    'status=' + current.status,
    'result=' + JSON.stringify(current.result?.text?.slice(0, 80) ?? null),
    'error=' + JSON.stringify(current.error ?? null),
    'diag=' + JSON.stringify(diag).slice(0, 700),
  )
  if (['done', 'error', 'cancelled'].includes(current.status)) break
}
