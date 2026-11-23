// Huli: 搬到另一台电脑… in a session's menu: the dialog's state and the moves main runs, which
// main tells every window of as they go (shared/session-move.ts). The window only asks main;
// main alone talks to the hosts about a move.

import { create } from 'zustand'
import type { SessionSummary } from '@shared/agent-host'
import type { MoveHost, MovePreviewResult, MoveProgress } from '@shared/session-move'
import { hostOfSession } from '@renderer/stores/sessions'
import { errorMessage } from '@renderer/lib/host'
import { hostPath, onHost } from '@renderer/lib/host-paths'
import { switchHost } from '@renderer/stores/host-switch'
import { openSession, THIS_COMPUTER, useViewStore } from '@renderer/stores/view'

/** Huli: the project on another computer a session was dropped on in the sidebar. */
export interface MoveDrop {
  host: MoveHost
  /** The project's path as the window names it (`onHost`). */
  projectPath: string
  projectName: string
}

interface MoveStore {
  /** The session the dialog moves; null while it is closed. */
  summary: SessionSummary | null
  /** Huli: the other sessions dropped with it, which move after it, one at a time. */
  more: SessionSummary[]
  /** Huli: the project they were dropped on, whose computer the dialog picks; null from a menu. */
  dropped: MoveDrop | null
  /** The latest of each move main runs or ran this run, by move id. */
  moves: Record<string, MoveProgress>
  /** What main found for the computer picked in the open dialog, or that it is looking. */
  preview: MovePreviewResult | 'loading' | null
}

export const useMoveStore = create<MoveStore>()(() => ({
  summary: null,
  more: [],
  dropped: null,
  moves: {},
  preview: null,
}))

/** The latest pick, so an earlier pick's late answer is dropped. */
let asked = 0

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

/**
 * Opens the dialog for the session, as its menu's 搬到另一台电脑… does; Huli: or for the sessions
 * dropped on another computer's project, with that computer picked.
 */
export function askMove(
  summary: SessionSummary,
  drop: { more: SessionSummary[]; dropped: MoveDrop } | null = null,
): void {
  listen()
  asked++
  useMoveStore.setState({
    summary,
    more: drop?.more ?? [],
    dropped: drop?.dropped ?? null,
    preview: null,
  })
}

/** The move of the session main runs now, if any. */
export function runningMove(sessionId: string): string | null {
  const moves = Object.values(useMoveStore.getState().moves)
  return (
    moves.find((move) => move.sessionId === sessionId && move.state === 'running')?.moveId ?? null
  )
}

export function closeMove(): void {
  asked++
  useMoveStore.setState({ summary: null, more: [], dropped: null, preview: null })
}

/**
 * Asks main what moving the session to `target` would do; the dialog shows the answer. Huli:
 * `project`, one of the host's projects as it writes it, moves it within its own computer.
 */
export function previewMove(
  summary: SessionSummary,
  target: MoveHost,
  project: string | null = null,
): void {
  const ask = ++asked
  const answered = (preview: MovePreviewResult): void => {
    if (ask === asked) useMoveStore.setState({ preview })
  }
  useMoveStore.setState({ preview: 'loading' })
  window.kettu
    .moves!.preview(hostOfSession(summary), summary.id, target, project)
    .then(answered, (e) => answered({ ok: false, reason: null, message: errorMessage(e) }))
}

export function startMove(
  summary: SessionSummary,
  target: MoveHost,
  project: string | null = null,
): Promise<string> {
  listen()
  return window.kettu.moves!.start(hostOfSession(summary), summary.id, target, project)
}

/** Huli: the project a drop moves the sessions into within their own computer, as it writes it. */
export function localProject(summary: SessionSummary, dropped: MoveDrop | null): string | null {
  return dropped && dropped.host === hostOfSession(summary) ? hostPath(dropped.projectPath) : null
}

/** The session main moved there, shown in its host's projects. */
export function openMoved(host: MoveHost, sessionId: string, projectPath: string): void {
  const { hostFilter } = useViewStore.getState()
  const wanted = host ?? THIS_COMPUTER
  if (hostFilter !== null && hostFilter !== wanted) switchHost(wanted, false)
  openSession(sessionId, onHost(host, projectPath))
}
