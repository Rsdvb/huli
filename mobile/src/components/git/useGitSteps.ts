// Runs the git panel's writes and says how each went in the notice bar, with the next step as its
// action, as the desktop's steps.ts toasts them; and opens the sheets a step needs first.

import { useRef, useState } from 'react'
import { Alert } from 'react-native'
import type { GitStatus } from '@shared/git'
import type { HostLink } from '@shared/remote/link'
import { runGit, type GitResult } from '../../git'
import {
  failureNote,
  logTitle,
  NEXT_LABEL,
  pushesToDefault,
  pushRequest,
  pushTargetOf,
  successNote,
  type GitRequest,
  type NextStep,
  type ResultNote,
} from '../../gitRules'
import { haptic } from '../../ui/haptics'
import { showNotice } from '../../ui/NoticeBar'

export type GitSheet =
  | { kind: 'commit'; paths: string[] | null }
  | { kind: 'createPr' }
  | { kind: 'publishBranch' }
  | { kind: 'publishRepo' }
  | { kind: 'log'; title: string; log: string }
  | null

export interface GitSteps {
  sheet: GitSheet
  setSheet(sheet: GitSheet): void
  /** Runs a write and says how it went; `quiet` leaves a failure to the caller's sheet. */
  run(request: GitRequest, options?: { quiet?: boolean; noNext?: boolean }): Promise<GitResult>
  /** Push as the Push button does, asking first where it has to. */
  pushNow(after?: GitStatus): void
  /** The failure sentence of a result, for a sheet that shows its own. */
  failureText(request: GitRequest, result: GitResult): string
}

export function useGitSteps(
  link: HostLink,
  folder: string | null,
  status: GitStatus | null,
  hasPr: boolean,
): GitSteps {
  const [sheet, setSheet] = useState<GitSheet>(null)
  const latest = useRef({ status, hasPr })
  latest.current = { status, hasPr }

  const show = (note: ResultNote, request: GitRequest, log: string) => {
    const next = note.next
    showNotice({
      text: note.text,
      tone: note.tone,
      ...(next
        ? { action: { label: NEXT_LABEL[next], onPress: () => runNext(next, request, log) } }
        : {}),
    })
  }

  const run: GitSteps['run'] = async (request, options = {}) => {
    if (!folder) return { ok: false, log: '', busy: false }
    const before = latest.current.status
    const result = await runGit(link, folder, request)
    if (result.ok) {
      haptic.success()
      const note = successNote(request, before, result.operation.status, latest.current.hasPr)
      show(options.noNext ? { ...note, next: null } : note, request, '')
    } else if (!options.quiet) {
      haptic.warning()
      show(failureNote(request, result.log, result.busy), request, result.log)
    }
    return result
  }

  const pushNow = (after?: GitStatus) => {
    const now = after ?? latest.current.status
    if (!now) return
    if (now.push?.kind === 'noRemote') return setSheet({ kind: 'publishRepo' })
    if (pushTargetOf(now)?.setUpstream) return setSheet({ kind: 'publishBranch' })
    const request = pushRequest(now)
    if (!request) return
    if (request.kind === 'push' && pushesToDefault(now, 'push')) {
      const branch = request.branch
      const count = now.upstream?.ahead ?? 0
      Alert.alert(
        `推送到 ${branch}？`,
        count > 0
          ? `${count} 个提交会直接进入默认分支 ${branch}，不经过 Pull Request。`
          : `此分支会直接进入默认分支 ${branch}，不经过 Pull Request。`,
        [
          { text: '取消', style: 'cancel' },
          { text: `推送到 ${branch}`, onPress: () => void run(request) },
        ],
      )
      return
    }
    void run(request)
  }

  const runNext = (next: NextStep, request: GitRequest, log: string) => {
    switch (next) {
      case 'pull':
        void run({ kind: 'pull' })
        return
      case 'push':
        pushNow()
        return
      case 'createPr':
        setSheet({ kind: 'createPr' })
        return
      case 'pullAndRetry':
        void run({ kind: 'pull' }).then((result) => {
          if (result.ok) pushNow(result.operation.status)
        })
        return
      case 'showLog':
        setSheet({ kind: 'log', title: logTitle(request.kind), log })
        return
    }
  }

  return {
    sheet,
    setSheet,
    run,
    pushNow,
    failureText: (request, result) =>
      result.ok ? '' : failureNote(request, result.log, result.busy).text,
  }
}
