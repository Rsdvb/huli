// What makes an API key the user typed unusable before it is handed to a harness: the host refuses
// it, and the dialogs say so before anything is created or written.

/** What the user typed; `baseUrl` and `model` only for Claude Code. */
export interface ApiKeyInput {
  key: string
  baseUrl?: string
  model?: string
}

export const MAX_KEY_CHARS = 4096
export const MAX_URL_CHARS = 2048
export const MAX_MODEL_CHARS = 256

/**
 * Why the input cannot be written: no key or one with spaces, a provider's address or model for a
 * harness that takes only a key, an address that is not http(s), a model with spaces. Null when
 * it can.
 */
export type ApiKeyProblem = 'key' | 'keyOnly' | 'baseUrl' | 'model'

export function apiKeyProblem(input: ApiKeyInput, allowProvider: boolean): ApiKeyProblem | null {
  const key = input.key.trim()
  if (key.length === 0 || key.length > MAX_KEY_CHARS || /\s/.test(key)) return 'key'
  const baseUrl = input.baseUrl?.trim()
  const model = input.model?.trim()
  if (!allowProvider && (baseUrl || model)) return 'keyOnly'
  if (baseUrl) {
    const url = URL.parse(baseUrl)
    if (baseUrl.length > MAX_URL_CHARS || !url || !['http:', 'https:'].includes(url.protocol)) {
      return 'baseUrl'
    }
  }
  if (model && (model.length > MAX_MODEL_CHARS || /\s/.test(model))) return 'model'
  return null
}
