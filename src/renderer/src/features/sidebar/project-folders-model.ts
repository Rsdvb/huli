import { create } from 'zustand'

interface Shown {
  id: number
  path: string
}

let nextId = 1

/** Huli: the project whose folders are open; a menu opens them and closes before they show. */
export const useProjectFolders = create<{ shown: Shown | null }>(() => ({ shown: null }))

export function openProjectFolders(projectPath: string): void {
  useProjectFolders.setState({ shown: { id: nextId++, path: projectPath } })
}
