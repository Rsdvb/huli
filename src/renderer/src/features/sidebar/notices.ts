import { useEffect, useState, useSyncExternalStore } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { AgentId } from '@shared/thread'
import { updateCardLabel, type UpdateCard } from '@renderer/features/updates/card-model'
import { useUpdates } from '@renderer/features/updates/use-updates'
import { i18n } from '@renderer/lib/i18n'
import { readJson, writeJson } from '@renderer/lib/storage'
import { useAgentsStore } from '@renderer/stores/agents'

/** What the footer's notices show, each empty while it has nothing to say. */
export interface Notices {
  /** The agents that need sign-in, by name. */
  signIn: string[]
  /** Huli: the same agents, by id, so one notice opens its agent's page. */
  signInIds?: AgentId[]
  /** The one update card, for Kettu and the harnesses alike. */
  update: UpdateCard | null
}

/** What the collapsed sidebar's toggle says of the notices it hides. */
export interface NoticeSummary {
  /** Each notice's words, in the footer's order. */
  labels: string[]
  /** The notices in one sentence, which lists them. */
  name: string
}

/** "Codex needs you to sign in", or how many agents do. */
export function signInLabel(names: string[]): string {
  return names.length === 1
    ? i18n.t('sidebar:footer.signInOne', { name: names[0] })
    : i18n.t('sidebar:footer.signInMany', { count: names.length })
}

/** The notices' words and their sentence; null while no notice shows. */
export function noticeSummary({ signIn, update }: Notices): NoticeSummary | null {
  const labels = [
    signIn.length > 0 ? signInLabel(signIn) : null,
    update ? updateCardLabel(update) : null,
  ].filter((label) => label !== null)
  if (labels.length === 0) return null
  return {
    labels,
    name: i18n.t('sidebar:footer.noticesName', {
      list: labels.join(i18n.t('sidebar:footer.listSeparator')),
    }),
  }
}

/** Huli: how long an agent's sign-in notice shows before it folds away. */
export const SIGN_IN_NOTICE_MS = 30 * 60_000
const SIGN_IN_SEEN_KEY = 'notices.signInSeen'

// Huli: when each agent's sign-in notice first showed, kept across restarts.
let seenCache: Record<string, number> | null = null
const seenListeners = new Set<() => void>()

function seenNotices(): Record<string, number> {
  seenCache ??= readJson<Record<string, number>>(SIGN_IN_SEEN_KEY, {})
  return seenCache
}

function subscribeSeen(listener: () => void): () => void {
  seenListeners.add(listener)
  return () => {
    seenListeners.delete(listener)
  }
}

/**
 * Notes the agents whose notice shows now, a new one from now; agents signed in since drop out, so
 * their next notice shows its full time.
 */
function noteSeen(ids: string[]): void {
  const seen = seenNotices()
  const at = Date.now()
  const next: Record<string, number> = {}
  for (const id of ids) next[id] = seen[id] ?? at
  const same = Object.keys(seen).length === ids.length && ids.every((id) => seen[id] === next[id])
  if (same) return
  seenCache = next
  writeJson(SIGN_IN_SEEN_KEY, next)
  for (const listener of seenListeners) listener()
}

/**
 * Huli: the agents of `ids` whose sign-in notice is still fresh. Each shows for SIGN_IN_NOTICE_MS
 * from when it first appeared, across restarts, and again once the agent was signed in and needs
 * sign-in anew; its agent page and New session still say it.
 */
function useFreshSignIns(ids: AgentId[]): AgentId[] {
  const key = ids.join(',')
  const seen = useSyncExternalStore(subscribeSeen, seenNotices)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => noteSeen(key ? key.split(',') : []), [key])
  // Folds each away when its time is up.
  useEffect(() => {
    const ends = (key ? key.split(',') : [])
      .map((id) => seen[id])
      .filter((at) => at !== undefined)
      .map((at) => at + SIGN_IN_NOTICE_MS)
      .filter((end) => end > now)
    if (ends.length === 0) return
    const timer = setTimeout(() => setNow(Date.now()), Math.min(...ends) - now + 50)
    return () => clearTimeout(timer)
  }, [key, seen, now])
  return ids.filter((id) => seen[id] === undefined || now - seen[id] < SIGN_IN_NOTICE_MS)
}

/** The sign-in and update notices, from the agents and the updater, and their summary. */
export function useNotices(): Notices & {
  signInIds: AgentId[]
  summary: NoticeSummary | null
} {
  const required = useAgentsStore(
    useShallow((s) =>
      s.order.filter(
        (id) =>
          s.byId[id]?.registered !== false &&
          !s.byId[id]?.disabled &&
          s.byId[id]?.signIn === 'required',
      ),
    ),
  )
  const signInIds = useFreshSignIns(required)
  const signIn = useAgentsStore(useShallow((s) => signInIds.map((id) => s.byId[id]?.name ?? id)))
  const notices: Notices = { signIn, update: useUpdates().card }
  return { ...notices, signInIds, summary: noticeSummary(notices) }
}
