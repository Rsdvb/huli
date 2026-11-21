// Huli: best of N. One prompt runs on several agents at once, each run a session in a new worktree
// cut from one base, the runs a group; the user compares their changes and keeps one, whose branch
// is merged into the project's own checkout, and may then archive the rest.

import { randomUUID } from 'node:crypto'
import type { SessionSummary } from '@shared/agent-host'
import type { FileDiff } from '@shared/git'
import type { GroupRunStart, KeptRun, RunChanges } from '@shared/session-groups'
import type { AgentId, UserContent } from '@shared/thread'
import { readChangesSince, readFileDiffSince } from '../git/details'
import type { Exec } from '../git/exec'
import { HostError, invalidParams, notFound } from '../errors'
import { t } from '../i18n'
import { fallbackTitle, type SessionManager } from '../sessions'
import type { LogFn, SessionRecord, StoredGroup, WorktreeRecord } from '../storage'
import type { GroupGit, GroupMerge } from './git'

const MAX_TITLE = 200
const LISTED_FILES = 5

type Run = SessionRecord & { group: StoredGroup }

export interface SessionGroupsDeps {
  sessions: SessionManager
  git: GroupGit
  exec: Exec
  /** A record of its own for another run to send; null on a host without attachments. */
  copyAttachment: ((id: string) => UserContent) | null
  releaseAttachments: (ids: string[]) => void
  agentName: (agentId: AgentId) => string
  log: LogFn
}

export class SessionGroups {
  /** Groups whose keep is under way, so a second click does not merge twice. */
  private readonly keeping = new Set<string>()

  constructor(private readonly deps: SessionGroupsDeps) {}

  /**
   * Starts every run at once with the same prompt, each with attachments of its own. The runs that
   * started are a group even when some could not; with none started, the first failure rejects.
   */
  async start(params: {
    projectPath: string
    base: string
    prompt: UserContent[]
    runs: GroupRunStart[]
  }): Promise<{ sessions: SessionSummary[]; failed: { agentId: AgentId; message: string }[] }> {
    const title = (fallbackTitle(params.prompt) ?? t('groups.untitled')).slice(0, MAX_TITLE)
    const group: StoredGroup = { id: randomUUID(), title, size: params.runs.length }
    const prompts = params.runs.map((_, i) =>
      i === 0 ? params.prompt : this.copied(params.prompt),
    )
    const settled = await Promise.allSettled(
      params.runs.map((run, i) =>
        this.deps.sessions.create({
          agentId: run.agentId,
          projectPath: params.projectPath,
          ...(run.options ? { options: run.options } : {}),
          prompt: prompts[i]!,
          worktree: { base: params.base },
          group,
        }),
      ),
    )
    const sessions: SessionSummary[] = []
    const failed: { agentId: AgentId; message: string }[] = []
    let first: unknown = null
    settled.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        sessions.push(result.value)
        return
      }
      first ??= result.reason
      const run = params.runs[i]!
      failed.push({ agentId: run.agentId, message: messageOf(result.reason) })
      if (i > 0) this.deps.releaseAttachments(attachmentIds(prompts[i]!))
    })
    if (sessions.length === 0) throw first
    for (const { agentId, message } of failed) {
      this.deps.log('warn', `A best-of-N run on ${agentId} could not start: ${message}`)
    }
    return { sessions, failed }
  }

  async changes(sessionId: string): Promise<RunChanges> {
    const worktree = this.worktreeOf(this.deps.sessions.groupRun(sessionId))
    const read = await readChangesSince(this.deps.exec, worktree.path, worktree.baseOid)
    let insertions = 0
    let deletions = 0
    for (const file of read.files) {
      insertions += file.insertions ?? 0
      deletions += file.deletions ?? 0
    }
    return {
      files: read.files,
      insertions,
      deletions,
      commits: read.commits,
      truncated: read.truncated,
    }
  }

  fileDiff(sessionId: string, path: string, oldPath: string | null): Promise<FileDiff> {
    const worktree = this.worktreeOf(this.deps.sessions.groupRun(sessionId))
    return readFileDiffSince(this.deps.exec, worktree.path, worktree.baseOid, path, oldPath)
  }

  /**
   * Brings the run's changes into the project's own checkout: what the run had not committed is
   * committed to its branch, which is then merged. Every check comes before anything changes, and
   * a merge that conflicts is undone, so a refusal leaves both checkouts as they were.
   */
  async keep(sessionId: string): Promise<KeptRun> {
    const run = this.deps.sessions.groupRun(sessionId)
    const { git } = this.deps
    const groupId = run.group.id
    if (this.keeping.has(groupId)) throw new HostError('busy', t('groups.keeping'))
    this.keeping.add(groupId)
    try {
      const kept = this.deps.sessions.groupRecords(groupId).find((r) => r.group?.kept)
      if (kept) throw new HostError('conflict', t('groups.alreadyKept'))
      if (working(this.deps.sessions.summary(sessionId))) {
        throw new HostError('busy', t('groups.stillWorking'))
      }
      const worktree = this.worktreeOf(run)
      const main = run.projectPath
      const branch = await git.branch(main)
      if (branch === null) throw new HostError('conflict', t('groups.mainDetached'))
      if (await git.busy(main)) throw new HostError('conflict', t('groups.mainBusy'))
      const changed = await git.trackedChanges(main)
      if (changed.length > 0) {
        throw new HostError(
          'conflict',
          t('groups.mainChanged', { count: changed.length, files: listed(changed) }),
        )
      }
      if ((await git.branch(worktree.path)) !== worktree.branch) {
        throw new HostError('conflict', t('groups.branchMoved', { branch: worktree.branch }))
      }
      const agent = this.deps.agentName(run.agentId)
      // What the run left uncommitted goes on its branch, and back off it should the keep fail.
      const snapshot = (await git.anyChanges(worktree.path))
        ? await git.commitAll(worktree.path, `${run.group.title}\n\nBest of N: ${agent}`)
        : null
      let commit: string
      try {
        if ((await git.commitsSince(main, worktree.baseOid, worktree.branch)) === 0) {
          throw new HostError('conflict', t('groups.nothingToKeep'))
        }
        const merge: GroupMerge = await git.merge(
          main,
          worktree.branch,
          `Keep ${agent}'s run: ${run.group.title}`,
        )
        if (!merge.merged) {
          if (merge.conflicts.length > 0) {
            throw new HostError(
              'conflict',
              t('groups.conflicts', {
                count: merge.conflicts.length,
                files: listed(merge.conflicts),
              }),
            )
          }
          throw new HostError('git_error', t('groups.mergeFailed', { error: merge.error ?? '' }))
        }
        commit = merge.commit
      } catch (error) {
        if (snapshot) {
          await git.uncommit(worktree.path, snapshot).catch((undo: unknown) => {
            this.deps.log('warn', `Could not take back the run's commit: ${messageOf(undo)}`)
          })
        }
        throw error
      }
      this.deps.sessions.markGroupKept(groupId, sessionId)
      this.deps.log('info', `Kept the best-of-N run ${sessionId} into ${branch}`)
      return { commit, branch }
    } finally {
      this.keeping.delete(groupId)
    }
  }

  /**
   * Archives each run, after committing what it had not to its branch and removing its worktree;
   * a run whose changes could not be committed keeps its worktree. Every branch stays.
   */
  async discard(sessionIds: string[]): Promise<void> {
    const runs = sessionIds.map((id) => this.deps.sessions.groupRun(id))
    for (const run of runs) {
      if (run.group.kept === run.id) throw invalidParams(t('groups.keptRun'))
    }
    const failures: string[] = []
    for (const run of runs) {
      try {
        await this.discardOne(run)
      } catch (error) {
        failures.push(messageOf(error))
        this.deps.log(
          'warn',
          `Could not set aside the best-of-N run ${run.id}: ${messageOf(error)}`,
        )
      }
    }
    if (failures.length > 0) {
      throw new HostError('git_error', t('groups.discardFailed', { error: failures[0] }))
    }
  }

  private async discardOne(run: Run): Promise<void> {
    const { sessions, git } = this.deps
    const worktree = run.worktree
    let error: unknown = null
    if (worktree && worktree.path !== '' && worktree.removed === undefined) {
      try {
        await sessions.cancel(run.id).catch(() => {})
        const inspected = await sessions.inspectWorktree(run.id)
        if (inspected.exists && inspected.others.length === 0) {
          if (inspected.uncommitted > 0) {
            const agent = this.deps.agentName(run.agentId)
            await git.commitAll(
              worktree.path,
              `${run.group.title}\n\nBest of N, not kept: ${agent}`,
            )
          }
          const again = await sessions.inspectWorktree(run.id)
          await sessions.removeWorktree(run.id, 'keep', again)
        }
      } catch (caught) {
        error = caught
      }
    }
    await sessions.archive(run.id)
    if (error) throw error
  }

  private copied(prompt: UserContent[]): UserContent[] {
    const copy = this.deps.copyAttachment
    return prompt.map((item) =>
      item.type === 'ref' && item.ref.kind === 'attachment'
        ? copy
          ? copy(item.ref.attachment.id)
          : item
        : item,
    )
  }

  private worktreeOf(run: Run): WorktreeRecord {
    const { worktree } = run
    if (!worktree || worktree.path === '' || worktree.removed !== undefined) {
      throw notFound(t('groups.noWorktree'))
    }
    return worktree
  }
}

function working(summary: SessionSummary): boolean {
  const state = summary.worktree?.state
  return (
    summary.status === 'running' ||
    summary.status === 'awaiting_permission' ||
    summary.status === 'starting' ||
    state === 'creating' ||
    state === 'setup'
  )
}

function attachmentIds(prompt: UserContent[]): string[] {
  return prompt.flatMap((item) =>
    item.type === 'ref' && item.ref.kind === 'attachment' ? [item.ref.attachment.id] : [],
  )
}

function listed(paths: string[]): string {
  const shown = paths.slice(0, LISTED_FILES).join(', ')
  return paths.length > LISTED_FILES ? `${shown}, …` : shown
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
