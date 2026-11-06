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
const hookCommand = mode === 'install' ? `node "${notifyPath}"` : null
const PRESENT = new Set(['UserPromptSubmit', 'Stop'])
const allowRule = 'mcp__dsh-bridge'

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isOurHandler(handler) {
  const command = String(handler?.command ?? '')
  return command.includes('dsh-claude-bridge') && command.includes('notify.mjs')
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

  if (mode === 'install') {
    for (const eventName of PRESENT) {
      const groups = Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : []
      const already = groups.some(
        (group) => Array.isArray(group?.hooks) && group.hooks.some(isOurHandler),
      )
      if (!already) {
        groups.push({ hooks: [{ type: 'command', command: hookCommand, timeout: 15 }] })
      }
      settings.hooks[eventName] = groups
    }

    if (!isPlainObject(settings.permissions)) settings.permissions = {}
    const allow = Array.isArray(settings.permissions.allow) ? settings.permissions.allow : []
    if (!allow.includes(allowRule)) allow.push(allowRule)
    settings.permissions.allow = allow
  } else {
    for (const eventName of PRESENT) {
      const groups = Array.isArray(settings.hooks[eventName]) ? settings.hooks[eventName] : []
      const keptGroups = []
      for (const group of groups) {
        const handlers = Array.isArray(group?.hooks) ? group.hooks : []
        const filtered = handlers.filter((handler) => !isOurHandler(handler))
        if (filtered.length === handlers.length) keptGroups.push(group)
        else if (filtered.length > 0) keptGroups.push({ ...group, hooks: filtered })
      }
      if (keptGroups.length > 0) settings.hooks[eventName] = keptGroups
      else delete settings.hooks[eventName]
    }
    if (Array.isArray(settings.permissions?.allow)) {
      settings.permissions.allow = settings.permissions.allow.filter((rule) => rule !== allowRule)
    }
  }

  const json = JSON.stringify(settings, null, 2) + '\n'
  await writeFile(settingsPath, Buffer.from(json, 'utf8'))
  console.log(
    JSON.stringify({ ok: true, mode, settingsPath, hookCommand, events: [...PRESENT], allowRule }),
  )
}

main().catch((error) => {
  console.error('merge-claude-settings:', error)
  process.exit(1)
})
