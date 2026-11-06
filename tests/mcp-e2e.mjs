// Prueba del MCP completo: lanza mcp/server.mjs por stdio y llama tools reales contra DSH.
// Uso: node tests/mcp-e2e.mjs
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import path from 'node:path'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const serverPath = path.join(root, 'mcp', 'server.mjs')
const cwd = process.env.DSH_TEST_CWD ?? path.dirname(root)

const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] })
const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })
const pending = new Map()
let nextId = 1
let failed = 0

function ok(name, extra = '') {
  console.log(`  PASS  ${name}${extra ? ` — ${extra}` : ''}`)
}
function fail(name, detail) {
  failed += 1
  console.log(`  FAIL  ${name} — ${detail}`)
}

rl.on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const resolve = pending.get(message.id)
  if (resolve) {
    pending.delete(message.id)
    resolve(message)
  }
})

function request(method, params, timeoutMs = 240000) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout esperando ${method}`)), timeoutMs)
    pending.set(id, (value) => {
      clearTimeout(timer)
      resolve(value)
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}

async function callTool(name, args) {
  const response = await request('tools/call', { name, arguments: args })
  if (response?.error) throw new Error(`${name}: ${response.error.message}`)
  const text = (response?.result?.content ?? []).map((part) => part.text ?? '').join('\n')
  return { text, isError: response?.result?.isError === true }
}

function kill() {
  child.kill()
}

try {
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'mcp-e2e', version: '1.0.0' },
  })
  ok('initialize', `${init.result.serverInfo.name} ${init.result.serverInfo.version}`)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')

  const delegate = await callTool('dsh_delegate', {
    task: 'Responde SOLO con la palabra exacta MCP_PUENTE_OK, sin usar herramientas.',
    cwd,
    workers: false,
    wait_seconds: 120,
  })
  if (!delegate.isError && delegate.text.includes('MCP_PUENTE_OK')) {
    ok('dsh_delegate terminó con resultado', delegate.text.split('\n').slice(0, 3).join(' | ').slice(0, 160))
  } else {
    fail('dsh_delegate', delegate.text.slice(0, 400))
  }

  const taskId = /task_id:\s*(\S+)/.exec(delegate.text)?.[1]
  if (taskId) {
    const result = await callTool('dsh_result', { task_id: taskId })
    if (!result.isError && result.text.includes('MCP_PUENTE_OK')) ok('dsh_result', taskId)
    else fail('dsh_result', result.text.slice(0, 300))
  } else {
    fail('task_id en respuesta', 'no encontrado')
  }

  const status = await callTool('dsh_status', {})
  if (!status.isError && status.text.includes('Puente DSH')) ok('dsh_status', status.text.split('\n')[0].slice(0, 90))
  else fail('dsh_status', status.text.slice(0, 300))

  const inbox = await callTool('dsh_inbox', { ack: false })
  if (!inbox.isError) ok('dsh_inbox', inbox.text.split('\n')[0].slice(0, 100))
  else fail('dsh_inbox', inbox.text.slice(0, 300))
} catch (error) {
  fail('excepción', String(error))
} finally {
  kill()
}

console.log(failed === 0 ? '\nMCP E2E OK' : `\nMCP E2E con ${failed} fallo(s)`)
process.exitCode = failed === 0 ? 0 : 1
