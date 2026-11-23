// The sessions whose notifications are muted. A computer that keeps a session's mute
// (`SessionSummary.muted`) holds it for every device: its finished turns and its agent's notes
// notify none of them, approvals and questions still do. An older computer keeps none, so the phone
// keeps its own list for it, as before: what arrives for one of those shows in the list without a
// sound or a banner, here while the app is open and in the notification extension otherwise (it
// reads the list the iOS platform shares with it). A session of that list on a computer that keeps
// mutes moves to the computer once it answers, and leaves the list then.

import { useSyncExternalStore } from 'react'
import * as SecureStore from 'expo-secure-store'
import type { SessionSummary } from '@shared/agent-host'
import type { HostLink } from '@shared/remote/link'

const ITEM = 'huli.muted'

let muted = new Set<string>()
let loaded = false
const listeners = new Set<() => void>()
const waiters: (() => void)[] = []

function emit(): void {
  for (const listener of listeners) listener()
}

void SecureStore.getItemAsync(ITEM)
  .then((text) => {
    const list = text ? (JSON.parse(text) as unknown) : []
    if (Array.isArray(list)) muted = new Set(list.filter((id) => typeof id === 'string'))
  })
  .catch(() => {})
  .finally(() => {
    loaded = true
    emit()
    for (const waiter of waiters.splice(0)) waiter()
  })

/** Whether the phone's own list mutes the session, as for a computer that keeps no mutes. */
export function isMuted(sessionId: string | null | undefined): boolean {
  return !!sessionId && muted.has(sessionId)
}

/** Whether the session is muted, by its computer or by the phone's own list. */
export function sessionMuted(
  sessionId: string,
  summary: Pick<SessionSummary, 'muted'> | undefined,
): boolean {
  return summary?.muted === true || muted.has(sessionId)
}

export function mutedIds(): string[] {
  return [...muted]
}

/** Called once the list was read, and on each change. */
export function onMutedChange(listener: () => void): () => void {
  listeners.add(listener)
  if (loaded) listener()
  return () => listeners.delete(listener)
}

/** Shown at once; a list that could not be kept goes back to what it was, and the call fails. */
async function keep(next: Set<string>): Promise<void> {
  const was = muted
  muted = next
  emit()
  try {
    await SecureStore.setItemAsync(ITEM, JSON.stringify([...next]))
  } catch (error) {
    if (muted === next) {
      muted = was
      emit()
    }
    throw error
  }
}

export async function setMuted(sessionId: string, on: boolean): Promise<void> {
  if (on === muted.has(sessionId)) return
  const next = new Set(muted)
  if (on) next.add(sessionId)
  else next.delete(sessionId)
  await keep(next)
}

/**
 * Mutes or unmutes the session where it is kept: on its computer when that keeps mutes, which
 * also takes it off the phone's own list, else on the phone.
 */
export async function muteSession(
  link: HostLink | null,
  summary: Pick<SessionSummary, 'id' | 'muted'>,
  on: boolean,
): Promise<void> {
  if (summary.muted === undefined) return setMuted(summary.id, on)
  // Away from its computer, a mute waits on the phone's list, which moves it there once it answers.
  if (!link) {
    if (on) return setMuted(summary.id, true)
    throw new Error('Not connected to the computer')
  }
  await link.request('sessions.setMuted', { sessionId: summary.id, muted: on })
  if (muted.has(summary.id)) await setMuted(summary.id, false).catch(() => {})
}

/**
 * Moves the sessions of the phone's own list that a computer lists, and that keeps mutes, to that
 * computer, so its other devices see them muted too; each leaves the list once the computer has
 * it. Nothing runs when the list is empty.
 */
export async function liftMuted(
  link: HostLink,
  sessions: readonly Pick<SessionSummary, 'id' | 'muted'>[],
): Promise<void> {
  if (!loaded) await new Promise<void>((resolve) => waiters.push(resolve))
  if (muted.size === 0) return
  const lifted: string[] = []
  for (const summary of sessions) {
    if (summary.muted === undefined || !muted.has(summary.id)) continue
    try {
      if (!summary.muted) {
        await link.request('sessions.setMuted', { sessionId: summary.id, muted: true })
      }
      lifted.push(summary.id)
    } catch {
      // It stays on the phone's list, which the next sync tries again.
    }
  }
  if (lifted.length === 0) return
  const next = new Set(muted)
  for (const id of lifted) next.delete(id)
  await keep(next).catch(() => {})
}

/** What the menu's 静音通知 or 取消静音 says under it: what the mute keeps quiet, and where. */
export function muteHint(
  summary: Pick<SessionSummary, 'muted'> | undefined,
  on: boolean,
): string | undefined {
  if (summary?.muted === undefined) return on ? undefined : '只在这台手机上：通知不响铃、不弹出'
  return on ? '现在只提醒批准和提问' : '回复完成和 Agent 通知不再提醒，批准和提问照常'
}

/** Whether the phone's own list mutes the session, kept current. */
export function useMuted(sessionId: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => muted.has(sessionId),
  )
}
