// Huli: an MCP server's error as the panel shows it. Agents quote the server's address in it, whose
// query may carry a key, so each address's query values and password are masked.

import { maskUrl } from '../agent-sync/mask'

const MAX_ERROR = 400
const ADDRESS = /\bhttps?:\/\/[^\s'"<>`)\]]+/g

/** One line of at most `MAX_ERROR` characters, every address in it masked; null for none. */
export function shownError(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null
  const line = text.replace(/\s+/g, ' ').trim()
  if (line === '') return null
  const masked = line.replace(ADDRESS, (url) => maskUrl(url))
  const points = Array.from(masked)
  return points.length > MAX_ERROR ? `${points.slice(0, MAX_ERROR).join('').trimEnd()}…` : masked
}
