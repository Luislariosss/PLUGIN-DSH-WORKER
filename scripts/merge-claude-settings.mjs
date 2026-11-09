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
// Reglas por herramienta (nunca el servidor entero: danger-full-access no debe quedar autorizado).
const TOOL_NAMES = [
  'dsh_delegate',
  'dsh_list',
  'dsh_status',
  'dsh_result',
  'dsh_followup',
  'dsh_cancel',
  'dsh_watch',
  'dsh_inbox',
  'dsh_channel_ack',
]
const ALLOW_RULES = TOOL_NAMES.map((tool) => `mcp__dsh-bridge__${tool}`)
// Regla antigua que autorizaba todo el MCP: se quita al instalar (migración) y al desinstalar.
const LEGACY_ALLOW_RULE = 'mcp__dsh-bridge'
// El aviso directo llega por el buzón de la sesión (cross-session messaging). Sin este
// valor, Claude Code retiene el mensaje cuando la sesión corre en bypass permissions.
const INBOUND_KEY = 'crossSessionInbound'
const INBOUND_VALUE = 'accept'

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

  let inbound = { key: INBOUND_KEY, value: null }
  if (mode === 'install') {
    for (const eventName of INSTALL_EVENTS) {
      const groups = Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : []
      groups.push({ hooks: [{ type: 'command', command: hookCommand, timeout: 15 }] })
      settings.hooks[eventName] = groups
    }
    if (!isPlainObject(settings.permissions)) settings.permissions = {}
    const current = Array.isArray(settings.permissions.allow) ? settings.permissions.allow : []
    const allow = current.filter((rule) => rule !== LEGACY_ALLOW_RULE)
    for (const rule of ALLOW_RULES) {
      if (!allow.includes(rule)) allow.push(rule)
    }
    settings.permissions.allow = allow
    // Sin crossSessionInbound=accept, una sesión en bypass permissions retiene los avisos.
    if (settings[INBOUND_KEY] === undefined) {
      settings[INBOUND_KEY] = INBOUND_VALUE
      inbound = { key: INBOUND_KEY, value: INBOUND_VALUE, added: true }
    } else {
      inbound = { key: INBOUND_KEY, value: settings[INBOUND_KEY], added: false }
    }
  } else {
    if (Array.isArray(settings.permissions?.allow)) {
      const removed = new Set([LEGACY_ALLOW_RULE, ...ALLOW_RULES])
      settings.permissions.allow = settings.permissions.allow.filter((rule) => !removed.has(rule))
      if (settings.permissions.allow.length === 0) delete settings.permissions.allow
      if (Object.keys(settings.permissions).length === 0) delete settings.permissions
    }
    // Solo se quita el valor que puso el instalador (el default de Claude Code es ausente).
    if (settings[INBOUND_KEY] === INBOUND_VALUE) {
      delete settings[INBOUND_KEY]
      inbound = { key: INBOUND_KEY, value: null, removed: true }
    }
  }

  if (Object.keys(settings.hooks).length === 0) delete settings.hooks

  const json = JSON.stringify(settings, null, 2) + '\n'
  await writeFile(settingsPath, Buffer.from(json, 'utf8'))
  console.log(
    JSON.stringify({
      ok: true,
      mode,
      settingsPath,
      hookCommand,
      events: INSTALL_EVENTS,
      allowRules: mode === 'install' ? ALLOW_RULES : [],
      removedLegacyRule: LEGACY_ALLOW_RULE,
      inbound,
    }),
  )
}

main().catch((error) => {
  console.error('merge-claude-settings:', error)
  process.exit(1)
})
