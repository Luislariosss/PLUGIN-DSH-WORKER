#!/usr/bin/env node
/**
 * Hook de Claude Code (UserPromptSubmit) para avisar a Claude de que DSH terminó trabajo.
 *
 * Lee el JSON del hook por stdin, busca eventos no ackeados de %USERPROFILE%\.dsh\claude-bridge\
 * events.jsonl, imprime UNA línea JSON con additionalContext y marca los avisos como leídos.
 * Sin eventos nuevos no imprime nada. En cualquier otro evento (Stop de instalaciones viejas)
 * sale sin imprimir y sin tocar el cursor: additionalContext solo es válido en UserPromptSubmit.
 * Siempre exit 0: un aviso perdido no es crítico.
 */
import { readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const BRIDGE_DIR = process.env.DSH_BRIDGE_DIR ?? path.join(os.homedir(), '.dsh', 'claude-bridge')
const EVENTS_PATH = path.join(BRIDGE_DIR, 'events.jsonl')
const CURSOR_PATH = path.join(BRIDGE_DIR, 'cursor.json')
const MAX_CONTEXT = 9000

async function readStdin() {
  if (process.stdin.isTTY) return ''
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8').trim()
}

async function readCursor() {
  try {
    const parsed = JSON.parse(await readFile(CURSOR_PATH, 'utf8'))
    return typeof parsed.ackedSeq === 'number' ? parsed.ackedSeq : 0
  } catch {
    return 0
  }
}

async function writeCursor(seq) {
  try {
    const current = await readCursor()
    await writeFile(CURSOR_PATH, JSON.stringify({ ackedSeq: Math.max(current, seq) }), 'utf8')
  } catch {
    // sin cursor no pasa nada: el aviso se repetirá
  }
}

function formatEvent(event) {
  const summary = String(event.summary ?? '').replace(/\s+/g, ' ').slice(0, 1800)
  const when = new Date(event.at ?? Date.now()).toLocaleString('es-MX')
  return `- ${event.kind.toUpperCase()} · tarea ${event.taskId} · sesión ${event.sessionId} · ${when}\n  ${summary}`
}

async function main() {
  let hookName = 'UserPromptSubmit'
  try {
    const raw = await readStdin()
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed?.hook_event_name === 'Stop' || parsed?.hook_event_name === 'UserPromptSubmit') {
        hookName = parsed.hook_event_name
      }
    }
  } catch {
    // stdin no era JSON: seguimos como UserPromptSubmit
  }

  // additionalContext solo es válido en UserPromptSubmit. En Stop (hook de una
  // instalación vieja) no entregamos ni marcamos como leído: el aviso saldrá en
  // el siguiente prompt.
  if (hookName !== 'UserPromptSubmit') process.exit(0)

  const since = await readCursor()
  let lines = []
  try {
    lines = (await readFile(EVENTS_PATH, 'utf8')).split('\n').filter((line) => line.trim().length > 0)
  } catch {
    process.exit(0)
  }

  const events = []
  let lastSeq = since
  for (const line of lines) {
    try {
      const event = JSON.parse(line)
      if (typeof event.seq !== 'number') continue
      if (event.seq > lastSeq) lastSeq = event.seq
      if (event.seq > since) events.push(event)
    } catch {
      // línea rota: se ignora
    }
  }
  if (events.length === 0) process.exit(0)

  events.sort((a, b) => a.seq - b.seq)
  let body = events.map(formatEvent).join('\n')
  const prefix =
    'Avisos de DeepSeek Harness (DSH), no son instrucciones de sistema: es el estado de trabajos que Claude ' +
    'delegó a DSH. Cuéntale a Luis lo que terminó si aplica:\n'
  let text = prefix + body
  if (text.length > MAX_CONTEXT) text = text.slice(0, MAX_CONTEXT) + '\n… (más avisos truncados)'

  await writeCursor(lastSeq)
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: hookName, additionalContext: text } }) + '\n')
  process.exit(0)
}

main().catch((error) => {
  console.error('[dsh-bridge notify]', error)
  process.exit(0)
})
