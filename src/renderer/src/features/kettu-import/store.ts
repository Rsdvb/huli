// Huli: what was found of an official Kettu's sessions on this computer, and an import of them in
// progress. Huli's own; see tools/huli/README.md.

import { create } from 'zustand'
import type { HostEvent } from '@shared/agent-host'
import type { KettuImportResult, KettuImportScan, KettuSession } from '@shared/kettu-import'
import { errorMessage, host } from '@renderer/lib/host'

type Progress = Omit<Extract<HostEvent, { type: 'kettuImport.progress' }>, 'type'>

interface KettuImportState {
  scan: KettuImportScan | null
  scanError: string | null
  scanning: boolean
  running: boolean
  progress: Progress | null
  result: KettuImportResult | null
  runError: string | null
}

export const useKettuImportStore = create<KettuImportState>()(() => ({
  scan: null,
  scanError: null,
  scanning: false,
  running: false,
  progress: null,
  result: null,
  runError: null,
}))

let scanning: Promise<void> | null = null

/** Looks for Kettu's sessions again; a look already out is shared. */
export function scanKettu(): Promise<void> {
  scanning ??= (async () => {
    useKettuImportStore.setState({ scanning: true, scanError: null })
    try {
      useKettuImportStore.setState({ scan: await host('kettuImport.scan', undefined) })
    } catch (error) {
      useKettuImportStore.setState({ scanError: errorMessage(error) })
    } finally {
      useKettuImportStore.setState({ scanning: false })
      scanning = null
    }
  })()
  return scanning
}

/** Imports the sessions by Kettu's ids, then looks again, so what came over shows as imported. */
export async function runKettuImport(sessionIds: string[]): Promise<void> {
  if (useKettuImportStore.getState().running) return
  useKettuImportStore.setState({ running: true, progress: null, result: null, runError: null })
  try {
    const result = await host('kettuImport.run', { sessionIds })
    useKettuImportStore.setState({ result })
  } catch (error) {
    useKettuImportStore.setState({ runError: errorMessage(error) })
  } finally {
    useKettuImportStore.setState({ running: false, progress: null })
  }
  await scanKettu()
}

/** A result shown once is let go when the dialog opens again. */
export function clearKettuResult(): void {
  useKettuImportStore.setState({ result: null, runError: null })
}

/** An import's progress, from this computer's own host only. */
export function receiveKettuImportProgress(event: Progress, hostId: string | null): void {
  if (hostId !== null) return
  const { done, total, title } = event
  useKettuImportStore.setState({ progress: { done, total, title } })
}

/** A top-level session that can come over and has not yet. */
export function importable(session: KettuSession): boolean {
  return session.origin !== 'subagent' && !session.imported && session.skip === null
}

/** What starts selected: every importable session except the archived ones. */
export function defaultSelection(scan: KettuImportScan): Set<string> {
  return new Set(
    scan.sessions.filter((s) => importable(s) && !s.archived).map((session) => session.id),
  )
}
