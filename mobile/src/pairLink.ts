// A pairing code that came in as a link, huli://pair#<code>, held until the pairing screen takes it:
// the system may open the link before that screen is up.

let pending: string | null = null
const listeners = new Set<(text: string) => void>()

/** The pairing text of a huli://pair link, or null when the path is not one. */
export function pairingFromPath(path: string): string | null {
  const local = path.replace(/^huli:\/\//, '/').replace(/^\/+/, '/')
  if (!local.startsWith('/pair#')) return null
  const code = local.slice('/pair#'.length)
  return code ? `https://huli.invalid/pair#${code}` : null
}

export function offerPairing(text: string): void {
  pending = text
  for (const listener of listeners) listener(text)
}

/** The code waiting for the pairing screen, which it takes. */
export function takePairing(): string | null {
  const text = pending
  pending = null
  return text
}

export function onPairing(listener: (text: string) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
