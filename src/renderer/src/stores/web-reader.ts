// Huli: this computer's Moli for background web reading, as Settings shows it: read once when a
// row that shows it mounts, then kept by `webReader.changed`, which only this computer's windows
// hear. Huli's own; see tools/huli/README.md (Background web reading).

import { create } from 'zustand'
import type { WebReaderStatus } from '@shared/web-reader'
import { errorMessage, hostAt } from '@renderer/lib/host'
import { useSettingsStore } from './settings'

interface WebReaderState {
  status: WebReaderStatus | null
  /** Why the last read or action failed, until the next one. */
  error: string | null
}

export const useWebReaderStore = create<WebReaderState>()(() => ({ status: null, error: null }))

export function receiveWebReader(status: WebReaderStatus): void {
  useWebReaderStore.setState({ status })
}

let loading: Promise<void> | null = null
/** The user stopped the download, whose rejection is then no error to show. */
let stopping = false

/** Reads the status unless it is known; the events keep it after. */
export function loadWebReader(): Promise<void> {
  if (useWebReaderStore.getState().status) return Promise.resolve()
  loading ??= hostAt(null, 'webReader.status', undefined)
    .then(receiveWebReader, (error: unknown) => {
      useWebReaderStore.setState({ error: errorMessage(error) })
    })
    .finally(() => {
      loading = null
    })
  return loading
}

/**
 * Turns the feature on, which the host takes as the go for the download, and waits for it: the
 * user saw its size in the dialog first.
 */
export async function downloadWebReader(): Promise<void> {
  useWebReaderStore.setState({ error: null })
  stopping = false
  try {
    await useSettingsStore.getState().update({ features: { webReader: true } })
    receiveWebReader(await hostAt(null, 'webReader.install', undefined))
  } catch (error) {
    if (!stopping) useWebReaderStore.setState({ error: errorMessage(error) })
  }
}

export function stopWebReaderDownload(): void {
  stopping = true
  void hostAt(null, 'webReader.cancel', undefined).catch(() => {})
}

/** Removes Moli and turns the feature off, so agents are no longer offered it. */
export async function removeWebReader(): Promise<void> {
  useWebReaderStore.setState({ error: null })
  try {
    receiveWebReader(await hostAt(null, 'webReader.remove', undefined))
    await useSettingsStore.getState().update({ features: { webReader: false } })
  } catch (error) {
    useWebReaderStore.setState({ error: errorMessage(error) })
  }
}
