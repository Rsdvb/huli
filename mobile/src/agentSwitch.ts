// Another agent picked to take a session over with its next message, as the desktop keeps it
// (stores/agent-switch.ts): the agent, the options it will start with as the menus set them, and
// whether it summarizes the conversation first. Kept per session while the app runs, so leaving
// the session and coming back finds the switch still waiting.

import { useSyncExternalStore } from 'react'
import type { HostLink } from '@shared/remote/link'
import type { AgentId } from '@shared/thread'
import { call } from './git'

export interface PendingSwitch {
  agentId: AgentId
  /** The start options set for it, by option id. */
  values: Record<string, string | boolean>
  summarize: boolean
}

const pending = new Map<string, PendingSwitch>()
const listeners = new Set<() => void>()

function publish(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePendingSwitch(sessionId: string): PendingSwitch | null {
  return useSyncExternalStore(subscribe, () => pending.get(sessionId) ?? null)
}

export function setPendingSwitch(sessionId: string, value: PendingSwitch | null): void {
  if (value) pending.set(sessionId, value)
  else pending.delete(sessionId)
  publish()
}

export function updatePendingSwitch(sessionId: string, change: Partial<PendingSwitch>): void {
  const current = pending.get(sessionId)
  if (!current) return
  pending.set(sessionId, { ...current, ...change })
  publish()
}

export function readPendingSwitch(sessionId: string): PendingSwitch | null {
  return pending.get(sessionId) ?? null
}

/** What switching away stops of the session's own agent: its background work, by name. */
export async function backgroundWork(link: HostLink, sessionId: string): Promise<string[]> {
  try {
    const { sessions } = await call(link, 'sessions.runningWork', { sessionIds: [sessionId] })
    return sessions
      .filter((work) => work.sessionId === sessionId)
      .flatMap((work) => [
        ...work.commands.map((name) => `后台命令：${name}`),
        ...work.tasks.map((name) => `后台任务：${name}`),
        ...work.subagents.map((name) => `子 Agent：${name}`),
        ...(work.scheduled > 0 ? [`${work.scheduled} 个定时任务`] : []),
        ...(work.unnamed ? ['后台任务'] : []),
      ])
  } catch {
    // A host that cannot say stops nothing the user was asked about before.
    return []
  }
}
