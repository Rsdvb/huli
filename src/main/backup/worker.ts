// Huli: entry of the backup's utility process, which main starts for one request and ends once it
// answered. It runs below normal priority, so a backup gives way to the agents and the window.

import os from 'node:os'
import { startHostLog, writeLog } from '@shared/log/process-log'
import type { BackupReply, BackupRequest } from './protocol'
import { inspectBackup, restoreBackup } from './restore'
import { BackupFailure, runBackup } from './run'

startHostLog('backup')
try {
  os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL)
} catch (error) {
  writeLog('warn', 'backup', `Could not lower the priority: ${(error as Error).message}`)
}

const port = process.parentPort
const post = (reply: BackupReply): void => port.postMessage(reply)

// At most one report a second, and the last one always.
function throttled(phase: Extract<BackupReply, { type: 'progress' }>['phase']) {
  let last = 0
  return (done: number, total: number): void => {
    const now = Date.now()
    if (now - last < 1000 && done < total) return
    last = now
    post({ type: 'progress', phase, done, total })
  }
}

async function run(request: BackupRequest): Promise<unknown> {
  switch (request.op) {
    case 'backup': {
      const done = await runBackup({ ...request.job, progress: throttled('backup') })
      writeLog(
        'info',
        'backup',
        `Wrote ${done.file}: ${done.files} files, ${done.bytes} bytes in ${done.durationMs} ms` +
          (done.pruned.length > 0 ? `; removed ${done.pruned.join(', ')}` : ''),
      )
      return done
    }
    case 'inspect': {
      const { manifest, files, bytes } = await inspectBackup(request.file)
      return { created: manifest.created, app: manifest.app, files, bytes }
    }
    case 'restore': {
      const phases = {
        check: throttled('check'),
        safety: throttled('safety'),
        swap: throttled('swap'),
      }
      const done = await restoreBackup({
        ...request.job,
        progress: (phase, done, total) => phases[phase](done, total),
      })
      writeLog(
        'info',
        'backup',
        `Restored ${done.manifest.files.length} files from ${request.job.file}; the data it replaced is in ${done.safety.file}`,
      )
      return { files: done.manifest.files.length, safety: done.safety.file }
    }
  }
}

port.once('message', ({ data }) => {
  const request = data as BackupRequest
  writeLog('info', 'backup', `Started: ${request.op}`)
  run(request).then(
    (value) => post({ type: 'result', value }),
    (error: unknown) => {
      const failure =
        error instanceof BackupFailure
          ? error
          : new BackupFailure('failed', (error as Error)?.message ?? String(error))
      writeLog('error', 'backup', `${request.op} failed (${failure.problem}): ${failure.message}`)
      post({ type: 'error', problem: failure.problem, message: failure.message })
    },
  )
})
