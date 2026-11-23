// Huli: Add project's Clone from Git and New empty project: which dialog is open, for which host,
// and the progress of the clones this window started, from their `projects.cloneProgress` events.

import { create } from 'zustand'
import type { CloneProgress } from '@shared/project-create'

export type NewProjectKind = 'clone' | 'empty'

export interface NewProjectDialog {
  kind: NewProjectKind
  /** The host the project is made on, null being this computer. */
  hostId: string | null
  /** Takes the new project's path, as the window names it; New session in it when absent. */
  onDone?: (projectPath: string) => void
}

interface NewProjectState {
  dialog: NewProjectDialog | null
  /** Each clone this window runs, by id; absent once it ended. */
  clones: Record<string, CloneProgress | null>
}

export const useNewProjectStore = create<NewProjectState>(() => ({ dialog: null, clones: {} }))

export function openNewProject(dialog: NewProjectDialog): void {
  useNewProjectStore.setState({ dialog })
}

export function closeNewProject(): void {
  useNewProjectStore.setState({ dialog: null })
}

/** A clone this window starts, whose progress the store keeps from now on. */
export function cloneStarted(cloneId: string): void {
  useNewProjectStore.setState((state) => ({ clones: { ...state.clones, [cloneId]: null } }))
}

export function cloneEnded(cloneId: string): void {
  useNewProjectStore.setState((state) => {
    if (!(cloneId in state.clones)) return state
    const clones = { ...state.clones }
    delete clones[cloneId]
    return { clones }
  })
}

/** `projects.cloneProgress`: one of this window's clones moved on; another's is not kept. */
export function receiveCloneProgress(progress: CloneProgress): void {
  useNewProjectStore.setState((state) =>
    progress.cloneId in state.clones
      ? { clones: { ...state.clones, [progress.cloneId]: progress } }
      : state,
  )
}
