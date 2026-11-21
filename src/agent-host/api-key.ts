// An API key the user gives an agent, handed to its harness to keep: written into the `env` of
// Claude Code's or Codebuddy Code's settings.json in the agent's folder, or given to
// `codex login --with-api-key`. Kettu keeps no copy and never reads one back; only the keys it
// writes are touched.

import { apiKeyProblem, type ApiKeyInput } from '@shared/api-key'
import { invalidParams } from './errors'
import { t } from './i18n'
import { isObject, readSettings, writeSettings } from './settings-file'

export type { ApiKeyInput }

// The variables Claude Code reads from its settings.json `env`, as its documentation names them.
const CLAUDE_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
] as const

// The variable Codebuddy Code reads its key from in its settings.json `env`.
const CODEBUDDY_KEYS = ['CODEBUDDY_API_KEY'] as const

/**
 * Checks what was typed, so nothing that is not a key, a URL or a model name is written; a refusal
 * says why in the user's language.
 */
export function checkApiKey(input: ApiKeyInput, allowProvider: boolean): ApiKeyInput {
  const problem = apiKeyProblem(input, allowProvider)
  if (problem) throw invalidParams(t(`agent.apiKey.${problem}`))
  const baseUrl = input.baseUrl?.trim()
  const model = input.model?.trim()
  return { key: input.key.trim(), ...(baseUrl ? { baseUrl } : {}), ...(model ? { model } : {}) }
}

/**
 * Sets Claude Code's variables in the settings file, keeping everything else in it. A key for
 * another provider's address goes in ANTHROPIC_AUTH_TOKEN, sent as a bearer token; Anthropic's own
 * in ANTHROPIC_API_KEY.
 */
export async function writeClaudeKey(file: string, input: ApiKeyInput): Promise<void> {
  const settings = await readSettings(file)
  const env = isObject(settings.env) ? { ...settings.env } : {}
  for (const name of CLAUDE_KEYS) delete env[name]
  if (input.baseUrl) {
    env.ANTHROPIC_BASE_URL = input.baseUrl
    env.ANTHROPIC_AUTH_TOKEN = input.key
  } else {
    env.ANTHROPIC_API_KEY = input.key
  }
  if (input.model) env.ANTHROPIC_MODEL = input.model
  await writeSettings(file, { ...settings, env })
}

/** Removes the variables `writeClaudeKey` sets, and `env` too once nothing else is in it. */
export async function clearClaudeKey(file: string): Promise<void> {
  await clearEnvKeys(file, CLAUDE_KEYS, 'Claude Code')
}

const CODEBUDDY = 'Codebuddy Code'

/** Sets Codebuddy Code's key in the settings file, keeping everything else in it. */
export async function writeCodebuddyKey(file: string, input: ApiKeyInput): Promise<void> {
  const settings = await readSettings(file, CODEBUDDY)
  const env = isObject(settings.env) ? { ...settings.env } : {}
  env.CODEBUDDY_API_KEY = input.key
  await writeSettings(file, { ...settings, env })
}

/** Removes the variable `writeCodebuddyKey` sets, and `env` too once nothing else is in it. */
export async function clearCodebuddyKey(file: string): Promise<void> {
  await clearEnvKeys(file, CODEBUDDY_KEYS, CODEBUDDY)
}

async function clearEnvKeys(file: string, names: readonly string[], agent: string): Promise<void> {
  const settings = await readSettings(file, agent)
  if (!isObject(settings.env)) return
  const env = { ...settings.env }
  if (!names.some((name) => name in env)) return
  for (const name of names) delete env[name]
  const next = { ...settings }
  if (Object.keys(env).length > 0) next.env = env
  else delete next.env
  await writeSettings(file, next)
}
