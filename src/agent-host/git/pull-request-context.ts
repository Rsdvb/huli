// What a model is shown to write a pull request: the messages of the branch's commits and the
// files it changes against its base.

import type { ChangedFile } from '@shared/git'
import { clipDiff, DIFF_CHARS } from './commit-context'
import { expectOk, GIT_TIMEOUT_MS, type Exec } from './exec'
import { parseNameStatus, parseNumstat, withLineCounts } from './parse'

/** The newest commits read at most; a longer branch is told apart by its files. */
const COMMITS = 30

export interface PullRequestContext {
  branch: string
  base: string
  /** The branch's commits, oldest first. */
  commits: { subject: string; body: string }[]
  files: ChangedFile[]
  /** Huli: the branch's diff against its base, cut at DIFF_CHARS; absent unless asked for. */
  diff?: string
}

/**
 * Reads what `baseRef`..HEAD holds, which the caller has checked is a branch or remote name and
 * so never an option. Huli: `diff` reads the branch's diff too.
 */
export async function readPullRequestContext(
  exec: Exec,
  cwd: string,
  request: { branch: string; base: string; baseRef: string; diff?: boolean },
): Promise<PullRequestContext> {
  const run = (args: string[]) => exec('git', args, { cwd, timeoutMs: GIT_TIMEOUT_MS })
  const [log, names, numbers, diff] = await Promise.all([
    run([
      'log',
      '-n',
      String(COMMITS),
      '--reverse',
      '--no-show-signature',
      '--encoding=UTF-8',
      '--format=%s%x1f%b%x1e',
      `${request.baseRef}..HEAD`,
      '--',
    ]),
    run(['diff', '--no-ext-diff', '-z', '-M', '--name-status', `${request.baseRef}...HEAD`, '--']),
    run(['diff', '--no-ext-diff', '-z', '-M', '--numstat', `${request.baseRef}...HEAD`, '--']),
    request.diff
      ? run(['diff', '--no-ext-diff', '--no-color', '-M', `${request.baseRef}...HEAD`, '--'])
      : null,
  ])
  const commits = expectOk('git log', log)
    .stdout.split('\x1e')
    .map((record) => {
      const [subject = '', body = ''] = record.split('\x1f')
      return { subject: subject.trim(), body: body.trim() }
    })
    .filter((commit) => commit.subject !== '')
  const files = withLineCounts(
    parseNameStatus(expectOk('git diff', names).stdout),
    parseNumstat(expectOk('git diff', numbers).stdout),
  )
  // A diff git fails to give is left out; the commits and files still say what changed.
  const shown =
    diff && diff.failure === null && diff.code === 0 ? clipDiff(diff.stdout, DIFF_CHARS) : ''
  return {
    branch: request.branch,
    base: request.base,
    commits,
    files,
    ...(shown === '' ? {} : { diff: shown }),
  }
}
