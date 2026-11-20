// Huli: the daily backup's status as main reports it, for Settings › Backup.

import { useEffect } from 'react'
import { create } from 'zustand'
import type { BackupStatus } from '@shared/backup'

interface BackupStore {
  status: BackupStatus | null
}

export const useBackupStore = create<BackupStore>()(() => ({ status: null }))

let following = false

/** Reads the status once and follows it from then on; the web client has no backup. */
export function useFollowBackup(): void {
  useEffect(() => {
    const api = window.kettu.backup
    if (following || !api) return
    following = true
    api.onChanged((status) => useBackupStore.setState({ status }))
    void api.status().then(
      (status) => useBackupStore.setState({ status }),
      (error: unknown) => console.warn('Could not read the backup status', error),
    )
  }, [])
}
