// Huli: 搬到另一台电脑… in a session's menu: the dialog's state and the moves main runs, which
// main tells every window of as they go (shared/session-move.ts). The window only asks main;
// main alone talks to the hosts about a move.

import { create } from 'zustand'
import type { SessionSummary } from '@shared/agent-host'
import type { MoveHost, MovePreviewResult, MoveProgress } from '@shared/session-move'
import { hostOfSession } from '@renderer/stores/sessions'
import { onHost } from '@renderer/lib/host-paths'
import { switchHost } from '@renderer/stores/host-switch'
import { openSession, THIS_COMPUTER, useViewStore } from '@renderer/stores/view'

interface MoveStore {
  /** The session the dialog moves; null while it is closed. */
  summary: SessionSummary | null
  /** The latest of each move main runs or ran this run, by move id. */
  moves: Record<string, MoveProgress>
}

export const useMoveStore = create<MoveStore>()(() => ({ summary: null, moves: {} }))

let listening = false

/** Hears main's moves from the first time a window needs them; events only, never polled. */
function listen(): void {
  const api = window.kettu.moves
  if (listening || !api) return
  listening = true
  api.onProgress((progress) => {
    useMoveStore.setState((s) => ({ moves: { ...s.moves, [progress.moveId]: progress } }))
  })
  void api.list().then((moves) => {
    useMoveStore.setState((s) => ({
      moves: { ...Object.fromEntries(moves.map((move) => [move.moveId, move])), ...s.moves },
    }))
  })
}

/** Whether this window can move sessions: the desktop app's, which has main. */
export function canMove(): boolean {
  return typeof window.kettu.moves?.start === 'function'
}

/** Opens the dialog for the session, as its menu's 搬到另一台电脑… does. */
export function askMove(summary: SessionSummary): void {
  listen()
  useMoveStore.setState({ summary })
}

export function closeMove(): void {
  useMoveStore.setState({ summary: null })
}

export function previewMove(summary: SessionSummary, target: MoveHost): Promise<MovePreviewResult> {
  return window.kettu.moves!.preview(hostOfSession(summary), summary.id, target)
}

export function startMove(summary: SessionSummary, target: MoveHost): Promise<string> {
  listen()
  return window.kettu.moves!.start(hostOfSession(summary), summary.id, target)
}

/** The session main moved there, shown in its host's projects. */
export function openMoved(host: MoveHost, sessionId: string, projectPath: string): void {
  const { hostFilter } = useViewStore.getState()
  const wanted = host ?? THIS_COMPUTER
  if (hostFilter !== null && hostFilter !== wanted) switchHost(wanted, false)
  openSession(sessionId, onHost(host, projectPath))
}
