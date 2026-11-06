#!/usr/bin/env node
/**
 * Fusiona los hooks del puente en ~/.claude/settings.json SIN romper el resto de la
 * configuración (hace backup y conserva la forma de array de Claude Code).
 *
 * Uso:
 *   node scripts/merge-claude-settings.mjs install  <ruta absoluta a mcp/notify.mjs>
 *   node scripts/merge-claude-settings.mjs uninstall
 */
import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const mode = process.argv[2] === 'uninstall' ? 'uninstall' : 'install'
const notifyPath = process.argv[3]
if (mode === 'install' && (!notifyPath || !notifyPath.toLowerCase().endsWith('notify.mjs'))) {
  console.error('Falta la ruta absoluta a mcp/notify.mjs')
  process.exit(2)
}

const settingsPath = process.env.DSH_CLAUDE_SETTINGS ?? path.join(os.homedir(), '.claude', 'settings.json')
const HOOK_MARKER = '--dsh-bridge-hook'
const INSTALL_EVENTS = ['UserPromptSubmit']
const CLEAN_EVENTS = ['UserPromptSubmit', 'Stop'] // Stop: hooks de versiones anteriores
const hookCommand = mode === 'install' ? `node "${notifyPath}" ${HOOK_MARKER}` : null
const allowRule = 'mcp__dsh-bridge'

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isOurHandler(handler) {
  const command = String(handler?.command ?? '')
  if (command.includes(HOOK_MARKER)) return true
  // Instalaciones previas sin marcador
  return (
    command.includes('notify.mjs') &&
    (command.includes('dsh-claude-bridge') || command.includes('PLUGIN-DSH-WORKER'))
  )
}

/** Quita nuestros handlers de un evento y devuelve los grupos restantes. */
function stripOurs(groups) {
  const kept = []
  for (const group of groups) {
    const handlers = Array.isArray(group?.hooks) ? group.hooks : []
    const filtered = handlers.filter((handler) => !isOurHandler(handler))
    if (filtered.length === handlers.length) kept.push(group)
    else if (filtered.length > 0) kept.push({ ...group, hooks: filtered })
  }
  return kept
}

async function readSettings() {
  try {
    const raw = await readFile(settingsPath, 'utf8')
    const cleaned = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
    if (!cleaned.trim()) return { settings: {}, existed: true, raw }
    return { settings: JSON.parse(cleaned), existed: true, raw }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { settings: {}, existed: false, raw: '' }
    throw error
  }
}

async function main() {
  const { settings, existed } = await readSettings()
  if (!isPlainObject(settings)) throw new Error('settings.json no contiene un objeto JSON')
  await mkdir(path.dirname(settingsPath), { recursive: true })
  if (existed) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    await copyFile(settingsPath, `${settingsPath}.bak-${stamp}`)
  }

  if (!isPlainObject(settings.hooks)) settings.hooks = {}

  // Limpieza común (también retira el hook viejo de Stop)
  for (const eventName of CLEAN_EVENTS) {
    const groups = Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : []
    const kept = stripOurs(groups)
    if (kept.length > 0) settings.hooks[eventName] = kept
    else delete settings.hooks[eventName]
  }

  if (mode === 'install') {
    for (const eventName of INSTALL_EVENTS) {
      const groups = Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : []
      groups.push({ hooks: [{ type: 'command', command: hookCommand, timeout: 15 }] })
      settings.hooks[eventName] = groups
    }
    if (!isPlainObject(settings.permissions)) settings.permissions = {}
    const allow = Array.isArray(settings.permissions.allow) ? settings.permissions.allow : []
    if (!allow.includes(allowRule)) allow.push(allowRule)
    settings.permissions.allow = allow
  } else if (Array.isArray(settings.permissions?.allow)) {
    settings.permissions.allow = settings.permissions.allow.filter((rule) => rule !== allowRule)
  }

  if (Object.keys(settings.hooks).length === 0) delete settings.hooks

  const json = JSON.stringify(settings, null, 2) + '\n'
  await writeFile(settingsPath, Buffer.from(json, 'utf8'))
  console.log(
    JSON.stringify({ ok: true, mode, settingsPath, hookCommand, events: INSTALL_EVENTS, allowRule }),
  )
}

main().catch((error) => {
  console.error('merge-claude-settings:', error)
  process.exit(1)
})
