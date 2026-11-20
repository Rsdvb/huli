// Doubao's conversations as `--list --json` gives them, across folders and devices, and a
// conversation's history as `--export` gives it.

import os from 'node:os'
import type { ListedEverywhere } from '../connection'
import { isConversationId } from './args'
import type { ExportedTurn, ListedConversation } from './protocol'

export interface ListingPage {
  conversations: ListedConversation[]
  nextCursor: string | null
}

/** What `--list --json` printed; null for output that is no listing. */
export function parseListing(stdout: string): ListingPage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    return null
  }
  const result = (parsed as { result?: Record<string, unknown> } | null)?.result
  if (result?.type !== 'session_list' || !Array.isArray(result.sessions)) return null
  const conversations = (result.sessions as ListedConversation[]).filter(
    (item) => typeof item?.session_id === 'string' && isConversationId(item.session_id),
  )
  const cursor = result.next_cursor
  return {
    conversations,
    nextCursor:
      typeof cursor === 'string' && cursor !== '' && result.has_more !== false ? cursor : null,
  }
}

/** What Doubao names a conversation until it has written a title for it. */
const UNTITLED: ReadonlySet<string> = new Set(['新对话', 'New chat'])

function titleOf(title: unknown): string | null {
  const text = typeof title === 'string' ? title.trim() : ''
  return text && !UNTITLED.has(text) ? text : null
}

/**
 * A conversation as the import lists it. One made in the Doubao app or on another device names no
 * folder, so it comes under the home folder, where a terminal's `doubao` would run it too.
 */
export function listedConversation(
  item: ListedConversation,
  sessionId: string,
  home: string = os.homedir(),
): ListedEverywhere {
  const updatedAt = typeof item.updated_at === 'string' ? item.updated_at : null
  return {
    sessionId,
    title: titleOf(item.title),
    updatedAt,
    createdAt: null,
    cwd: typeof item.cwd === 'string' && item.cwd !== '' ? item.cwd : home,
    subagent: false,
    // The listing leaves out empty conversations.
    prompted: true,
  }
}

/** What `--export` printed: each turn's question and answer; null for output that is none. */
export function parseExport(stdout: string): ExportedTurn[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  return parsed.filter((turn): turn is ExportedTurn => typeof turn === 'object' && turn !== null)
}
