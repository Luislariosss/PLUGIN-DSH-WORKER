#!/usr/bin/env node
/**
 * Autoprueba del servidor MCP: lanza mcp/server.mjs por stdio, hace initialize + tools/list
 * y verifica que estén los 9 tools y la capacidad del canal de avisos. No necesita DSH ni
 * Claude Code.
 *
 * Uso: node mcp/selftest.mjs
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createInterface } from 'node:readline'

const here = path.dirname(fileURLToPath(import.meta.url))
const serverPath = path.join(here, 'server.mjs')
const EXPECTED = [
  'dsh_cancel',
  'dsh_channel_ack',
  'dsh_delegate',
  'dsh_followup',
  'dsh_inbox',
  'dsh_list',
  'dsh_result',
  'dsh_status',
  'dsh_watch',
]

const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] })
const rl = createInterface({ input: child.stdout, crlfDelay: Infinity })

let step = 0
let failed = false
const pending = new Map()

function send(message) {
  child.stdin.write(JSON.stringify(message) + '\n')
}

function fail(message) {
  failed = true
  console.error('FAIL:', message)
  child.kill()
  process.exitCode = 1
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

function request(message, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    pending.set(message.id, resolve)
    const timer = setTimeout(() => reject(new Error(`timeout esperando ${message.method}`)), timeoutMs)
    pending.set(message.id, (value) => {
      clearTimeout(timer)
      resolve(value)
    })
    send(message)
  })
}

async function main() {
  const init = await request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'selftest', version: '1.0.0' } } })
  if (!init?.result?.serverInfo?.name) return fail('initialize sin serverInfo')
  console.log('initialize OK →', init.result.serverInfo.name, init.result.serverInfo.version, 'protocol', init.result.protocolVersion)
  if (!init.result.capabilities?.experimental?.['claude/channel']) {
    return fail('initialize sin capabilities.experimental["claude/channel"] (aviso push)')
  }
  console.log('aviso push OK → capacidad claude/channel declarada')
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })

  const list = await request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  const names = (list?.result?.tools ?? []).map((tool) => tool.name).sort()
  if (names.length !== EXPECTED.length || EXPECTED.some((name) => !names.includes(name))) {
    return fail(`tools/list devolvió ${JSON.stringify(names)}; esperaba ${JSON.stringify(EXPECTED)}`)
  }
  console.log('tools/list OK →', names.join(', '))

  // tools/call con un nombre inexistente debe devolver error controlado
  const bad = await request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'no_existe', arguments: {} } })
  if (!bad?.error) return fail('tools/call inexistente no devolvió error JSON-RPC')
  console.log('error controlado OK →', bad.error.message)

  step += 1
  child.kill()
  console.log(failed ? 'SELFTEST CON FALLOS' : 'SELFTEST OK')
  process.exitCode = failed ? 1 : 0
}

main().catch((error) => {
  console.error('SELFTEST crash:', error)
  child.kill()
  process.exitCode = 1
})

child.on('exit', (code) => {
  if (!failed && code !== 0 && code !== null) {
    console.error('servidor MCP salió con', code)
    process.exitCode = 1
  }
})
