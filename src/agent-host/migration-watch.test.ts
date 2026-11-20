import { describe, expect, it, vi } from 'vitest'
import { watchMigration } from './migration-watch'

describe('the migration the backup waits for', () => {
  it('runs until the database opened and its pictures moved out', async () => {
    vi.useFakeTimers()
    try {
      let left = 2
      let open: (status: 'ok') => void = () => {}
      const reports: boolean[] = []
      watchMigration(
        {
          ready: new Promise((resolve) => (open = resolve)),
          mediaTotals: async () => ({ files: 0, bytes: 0, legacy: left }),
        },
        (running) => reports.push(running),
        1000,
      )
      expect(reports).toEqual([true])
      open('ok')
      await vi.advanceTimersByTimeAsync(0)
      expect(reports).toEqual([true])
      left = 0
      await vi.advanceTimersByTimeAsync(1000)
      expect(reports).toEqual([true, false])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not hold the backup for a database that cannot answer', async () => {
    const reports: boolean[] = []
    watchMigration(
      {
        ready: Promise.resolve('unavailable'),
        mediaTotals: () => Promise.reject(new Error('not open')),
      },
      (running) => reports.push(running),
    )
    await vi.waitFor(() => expect(reports).toEqual([true, false]))
  })
})
