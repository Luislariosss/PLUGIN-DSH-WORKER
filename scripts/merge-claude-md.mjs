#!/usr/bin/env node
/**
 * Añade/quita el bloque gestionado del puente en ~/.claude/CLAUDE.md.
 * (Se hace con Node para que los acentos se escriban en UTF-8 sin BOM, sin depender de
 *  la codificación con la que Windows PowerShell lea el .ps1.)
 *
 * Uso:
 *   node scripts/merge-claude-md.mjs install
 *   node scripts/merge-claude-md.mjs uninstall
 */
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

const mode = process.argv[2] === 'uninstall' ? 'uninstall' : 'install'
const mdPath = process.env.DSH_CLAUDE_MD ?? path.join(os.homedir(), '.claude', 'CLAUDE.md')
// Ruta absoluta del repo donde vive este script (…/scripts/merge-claude-md.mjs → …/).
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const START = '<!-- dsh-bridge:start -->'
const END = '<!-- dsh-bridge:end -->'

const BLOCK = `${START}
## Delegar trabajo a DeepSeek Harness (DSH)

Tienes el MCP \`dsh-bridge\` conectado. DeepSeek Harness es otro agente del usuario (este repo:
\`${repoRoot}\`) que ejecuta trabajo en sesiones reales de DSH con sus workers (Agent Teams).

- Cuando Luis diga "pásalo a DSH", "delega esto", "que lo haga DeepSeek", "usa tus workers",
  usa \`dsh_delegate\` con una tarea autosuficiente (contexto, criterio de terminado, qué
  devolver) y el \`cwd\` absoluto correcto.
- \`dsh_delegate\` espera el resultado (wait_seconds, 600 s por defecto) y te lo devuelve; úsalo
  como entrada para seguir tú.
- Para trabajo largo: \`wait_seconds: 0\` y luego \`dsh_watch\` (con el task_id o sin él) para
  **monitorearlo activamente**: se queda bloqueada hasta que DSH entregue y te despierta con
  la entrega. Al expirar, vuelve a llamar a \`dsh_watch\` en vez de terminar la sesión con
  trabajo en curso. Los avisos también llegan solos por hooks (\`dsh_inbox\` los lista).
- No delegues secretos ni credenciales: DSH ejecuta con su propio sandbox y sus propias
  aprobaciones.
${END}`

async function readText(p) {
  try {
    const raw = await readFile(p, 'utf8')
    return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

async function main() {
  await mkdir(path.dirname(mdPath), { recursive: true })
  const current = await readText(mdPath)
  if (current !== null) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    await copyFile(mdPath, `${mdPath}.bak-${stamp}`)
  }

  let next
  if (mode === 'install') {
    if (current !== null && current.includes(START) && current.includes(END)) {
      const pattern = new RegExp(START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      next = current.replace(pattern, BLOCK)
    } else {
      const prefix = current ? current.replace(/\s+$/, '') + '\r\n\r\n' : ''
      next = prefix + BLOCK + '\r\n'
    }
  } else {
    if (current === null || !current.includes(START) || !current.includes(END)) {
      console.log(JSON.stringify({ ok: true, mode, mdPath, changed: false }))
      return
    }
    const pattern = new RegExp(START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    next = current.replace(pattern, '').replace(/\s+$/, '') + '\r\n'
  }

  await writeFile(mdPath, Buffer.from(next, 'utf8'))
  console.log(JSON.stringify({ ok: true, mode, mdPath, changed: true }))
}

main().catch((error) => {
  console.error('merge-claude-md:', error)
  process.exit(1)
})
