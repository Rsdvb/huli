// The parts of the git panel, as the desktop's branch popover lays them out: the branch with how far
// it is from its upstream and Pull and Push, the commits a pull brings, the pull request with its
// checks, the uncommitted files, the branch's own commits, and the folder it is checked out in.

import { useEffect, useState, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import type {
  ChangeStatus,
  ChangedFile,
  CheckRun,
  CommitDetails,
  CommitSummary,
  GitStatus,
  GitTools,
  LogCommit,
  PullRequest,
} from '@shared/git'
import type { HostLink } from '@shared/remote/link'
import { call, errorText } from '../../git'
import {
  branchLabel,
  HINT_TONE,
  hintText,
  isLinkedWorktree,
  OPERATION_TEXT,
  planSync,
  pullRequestHead,
  pushTargetOf,
  reasonText,
  RUNNING_TEXT,
  type GitKind,
  type SyncButton,
} from '../../gitRules'
import { ago } from '../../sessions'
import { ContextMenu } from '../../ui/ContextMenu'
import type { MenuNode } from '../../ui/menu'
import { showNotice } from '../../ui/NoticeBar'
import { copyText, haptic } from '../../ui/session/feedback'
import { baseName, dirName, durationText, elapsedText } from '../../ui/session/format'
import { GI, PR_STATE_TEXT, PrMark, usePrColor } from '../../ui/session/gitIcons'
import { FileMark, G, Icon } from '../../ui/session/icons'
import { MONO, useSessionTokens } from '../../ui/session/palette'
import { Counts } from '../../ui/session/TurnChanges'
import { openUrl } from '../../system/openUrl'

export function Card(props: { children: ReactNode; flush?: boolean }) {
  const { s } = useSessionTokens()
  return (
    <View style={[styles.card, props.flush && styles.flush, { backgroundColor: s.dockCard }]}>
      {props.children}
    </View>
  )
}

export function PartHead(props: { title: string; children?: ReactNode }) {
  const { c } = useSessionTokens()
  return (
    <View style={styles.partHead}>
      <Text style={[styles.partTitle, { color: c.textSecondary }]}>{props.title}</Text>
      {props.children}
    </View>
  )
}

/** A small capsule button of the panel; `filled` for the step that comes next. */
export function PillButton(props: {
  label: string
  icon?: Parameters<typeof Icon>[0]['icon']
  onPress(): void
  filled?: boolean
  busy?: boolean
  disabled?: boolean
  danger?: boolean
  accessibilityHint?: string
}) {
  const { c } = useSessionTokens()
  const off = props.disabled || props.busy
  const fg = props.filled ? c.onAccent : props.danger ? c.danger : c.text
  return (
    <Pressable
      onPress={props.onPress}
      disabled={off}
      hitSlop={4}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: !!off, busy: !!props.busy }}
      {...(props.accessibilityHint ? { accessibilityHint: props.accessibilityHint } : {})}
      style={({ pressed }) => [
        styles.pill,
        {
          backgroundColor: props.filled ? c.accent : c.fillStrong,
          opacity: props.disabled && !props.busy ? 0.4 : pressed ? 0.6 : 1,
        },
      ]}
    >
      {props.busy ? (
        <ActivityIndicator size="small" color={fg} />
      ) : props.icon ? (
        <Icon icon={props.icon} size={14} color={fg} weight="semibold" />
      ) : null}
      <Text style={[styles.pillText, { color: fg }]} numberOfLines={1}>
        {props.label}
      </Text>
    </Pressable>
  )
}

const SYNC_LABEL: Record<SyncButton['kind'], string> = {
  fetch: '抓取',
  pull: '拉取',
  push: '推送',
  publishBranch: '推送',
  publishRepo: '发布…',
}

function fetchedText(status: GitStatus): string {
  if (!status.remote) return '没有远程仓库'
  return status.lastFetchedAt ? `${ago(status.lastFetchedAt)}抓取` : '从未抓取'
}

/** The branch, where it stands against its upstream, Pull and Push, and why one cannot run. */
export function SyncCard(props: {
  status: GitStatus
  gh: GitTools['gh']['state'] | null
  running: GitKind | null
  onSwitch(): void
  onPull(): void
  onPush(button: SyncButton): void
}) {
  const { c, s } = useSessionTokens()
  const { status, running } = props
  const { head, upstream, defaultBranch } = status
  const plan = planSync(status, props.gh)
  const fetched = running === 'fetch' ? '正在获取…' : fetchedText(status)
  const fromBase = defaultBranch && head.branch !== defaultBranch
  const warning = plan.hint && HINT_TONE[plan.hint] === 'warning' && !running
  const busyKind = (button: SyncButton): boolean =>
    button.kind === 'pull'
      ? running === 'pull'
      : running === 'push' || running === 'publishBranch' || running === 'publishRepo'

  return (
    <Card>
      <Pressable
        onPress={props.onSwitch}
        accessibilityRole="button"
        accessibilityLabel={`分支 ${branchLabel(status)}`}
        accessibilityHint="切换分支"
        style={({ pressed }) => [styles.branchRow, { opacity: pressed ? 0.55 : 1 }]}
      >
        <Icon icon={head.detached ? G.commit : G.branch} size={16} color={c.textSecondary} />
        <Text style={[styles.branch, { color: c.text }]} numberOfLines={1}>
          {branchLabel(status)}
        </Text>
        <Icon icon={G.upDown} size={11} color={c.textTertiary} weight="semibold" />
      </Pressable>
      <Text style={[styles.sub, { color: c.textTertiary }]} numberOfLines={1}>
        {fromBase ? `来自 ${defaultBranch} · ${fetched}` : fetched}
        {status.stale ? ' · 可能不是最新' : ''}
      </Text>
      {status.operation ? (
        <View style={[styles.opChip, { backgroundColor: s.warningSoft }]}>
          <Icon icon={G.warning} size={13} color={c.warning} />
          <Text style={[styles.opText, { color: c.text }]}>
            {OPERATION_TEXT[status.operation.kind]}
            {status.operation.step
              ? ` ${status.operation.step[0]}/${status.operation.step[1]}`
              : ''}
          </Text>
        </View>
      ) : null}
      <View style={styles.syncRow}>
        <View style={[styles.counts, { backgroundColor: c.fill }]}>
          {head.detached ? (
            <Text style={[styles.countText, { color: c.textSecondary }]}>HEAD 已分离</Text>
          ) : !head.oid ? (
            <Text style={[styles.countText, { color: c.textSecondary }]}>尚无提交</Text>
          ) : upstream ? (
            <Text style={[styles.countText, { color: c.textSecondary }]} numberOfLines={1}>
              <Text style={{ color: c.text, fontWeight: '600' }}>{upstream.ahead}</Text> 领先
              {'   '}
              <Text style={{ color: c.text, fontWeight: '600' }}>{upstream.behind}</Text> 落后
            </Text>
          ) : (
            <Text style={[styles.countText, { color: c.textSecondary }]}>未发布</Text>
          )}
        </View>
        {[plan.pull, plan.push].map((button) => (
          <PillButton
            key={button === plan.pull ? 'pull' : 'push'}
            label={SYNC_LABEL[button.kind]}
            icon={button.kind === 'pull' ? GI.pull : G.push}
            filled={button.enabled && button.next}
            busy={busyKind(button)}
            disabled={!button.enabled || running !== null}
            {...(button.reason ? { accessibilityHint: reasonText(button.reason, status) } : {})}
            onPress={() => (button.kind === 'pull' ? props.onPull() : props.onPush(button))}
          />
        ))}
      </View>
      {running ? (
        <View style={styles.hint}>
          <ActivityIndicator size="small" color={c.textTertiary} />
          <Text style={[styles.hintText, { color: c.textSecondary }]}>
            {RUNNING_TEXT[running]}…
          </Text>
        </View>
      ) : warning && plan.hint ? (
        <View style={styles.hint}>
          <Icon icon={G.warning} size={13} color={c.warning} />
          <Text style={[styles.hintText, { color: c.textSecondary }]}>
            {hintText(plan.hint, status)}
          </Text>
        </View>
      ) : !plan.push.enabled && plan.push.reason && plan.push.reason !== 'nothingToPush' ? (
        <Text style={[styles.hintText, { color: c.textTertiary }]}>
          {reasonText(plan.push.reason, status)}
        </Text>
      ) : plan.hint === 'upToDate' ||
        plan.hint === 'publishBranch' ||
        plan.hint === 'publishRepo' ? (
        <Text style={[styles.hintText, { color: c.textTertiary }]}>
          {hintText(plan.hint, status)}
        </Text>
      ) : !plan.pull.enabled && plan.pull.reason ? (
        // A greyed 拉取 says why, as a greyed 推送 does above.
        <Text style={[styles.hintText, { color: c.textTertiary }]}>
          {reasonText(plan.pull.reason, status)}
        </Text>
      ) : null}
    </Card>
  )
}

/** The commits a pull would bring from the upstream, read while it is open. */
export function IncomingPart(props: { link: HostLink; status: GitStatus }) {
  const { c } = useSessionTokens()
  const { link, status } = props
  const behind = status.upstream?.behind ?? 0
  const [open, setOpen] = useState(false)
  const [commits, setCommits] = useState<LogCommit[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const key = `${status.upstream?.name}:${behind}:${status.updatedAt}`
  useEffect(() => {
    if (!open || behind === 0) return
    let live = true
    setError(null)
    call(link, 'git.incoming', { projectPath: status.projectPath, from: 'upstream' }).then(
      (list) => live && setCommits(list),
      (e: unknown) => live && setError(errorText(e, '读不到提交')),
    )
    return () => {
      live = false
    }
    // `key` says when the upstream moved.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, link, status.projectPath, key])
  if (behind === 0) return null
  return (
    <Card>
      <Pressable
        onPress={() => {
          haptic.tap()
          setOpen((was) => !was)
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={styles.partHead}
      >
        <Icon icon={GI.pull} size={14} color={c.tint} />
        <Text style={[styles.partTitle, { color: c.text, flex: 1 }]}>{behind} 个提交待拉取</Text>
        <Icon icon={open ? G.down : G.right} size={12} color={c.textTertiary} />
      </Pressable>
      {open ? (
        error ? (
          <Text style={[styles.hintText, { color: c.danger }]}>{error}</Text>
        ) : !commits ? (
          <ActivityIndicator color={c.textSecondary} style={styles.loading} />
        ) : (
          commits.map((commit) => (
            <View key={commit.oid} style={styles.commitRow}>
              <Text style={[styles.oid, { color: c.textTertiary }]}>{commit.oid.slice(0, 7)}</Text>
              <Text style={[styles.subject, { color: c.text }]} numberOfLines={1}>
                {commit.subject}
              </Text>
              <Text style={[styles.when, { color: c.textTertiary }]} numberOfLines={1}>
                {commit.authorName} · {ago(commit.authoredAt)}
              </Text>
            </View>
          ))
        )
      ) : null}
    </Card>
  )
}

function waitingFor(pr: PullRequest): string | null {
  if (pr.state === 'draft') return '草稿'
  if (pr.mergeable === 'conflicting') return `与 ${pr.base} 有冲突`
  if (pr.checks.state === 'failing') return '检查未通过'
  if (pr.review === 'review_required') return '等待审查'
  if (pr.review === 'approved') return '已批准'
  if (pr.review === 'changes_requested') return '请求更改'
  if (pr.checks.state === 'pending') return '等待检查'
  return pr.mergeable === 'clean' ? '可以合并' : null
}

function CheckRow(props: { run: CheckRun }) {
  const { c } = useSessionTokens()
  const { run } = props
  const icon =
    run.outcome === 'passed' ? (
      <Icon icon={G.check} size={13} color={c.success} weight="bold" />
    ) : run.outcome === 'failed' ? (
      <Icon icon={G.close} size={13} color={c.danger} weight="bold" />
    ) : run.startedAt === null ? (
      <Icon icon={GI.queued} size={13} color={c.textTertiary} />
    ) : (
      <ActivityIndicator size="small" color={c.textTertiary} style={styles.runSpin} />
    )
  const took =
    run.outcome === 'pending'
      ? run.startedAt
        ? elapsedText(Date.now() - run.startedAt)
        : '排队中'
      : run.startedAt && run.completedAt
        ? durationText(run.completedAt - run.startedAt)
        : null
  const url = run.url
  return (
    <Pressable
      disabled={!url}
      onPress={() => url && openUrl(url)}
      style={({ pressed }) => [styles.checkRow, { opacity: pressed ? 0.55 : 1 }]}
    >
      <View style={styles.checkIcon}>{icon}</View>
      <Text style={[styles.checkName, { color: c.textSecondary }]} numberOfLines={1}>
        {run.name}
      </Text>
      {took ? <Text style={[styles.when, { color: c.textTertiary }]}>{took}</Text> : null}
    </Pressable>
  )
}

/** The branch's pull request with its checks, or how to get one; only for a GitHub remote. */
export function PrPart(props: {
  status: GitStatus
  pr: PullRequest | null
  loading: boolean
  error: string | null
  gh: GitTools['gh']['state'] | null
  onRetry(): void
  onCreate(): void
}) {
  const { c } = useSessionTokens()
  const prColor = usePrColor()
  const { status, pr } = props
  const github = status.remote?.github
  if (!github) return null

  if (pr) {
    const done = pr.state === 'merged' || pr.state === 'closed'
    const { checks } = pr
    const total = checks.passed + checks.failed + checks.pending
    const note = done
      ? `${ago(pr.mergedAt ?? pr.closedAt ?? pr.updatedAt)}${pr.state === 'merged' ? '合并' : '关闭'}`
      : waitingFor(pr)
    const color = prColor(pr.state)
    return (
      <Card>
        <View style={styles.partHead}>
          <Text style={[styles.partTitle, { color: c.textSecondary, flex: 1 }]}>拉取请求</Text>
          <View style={[styles.stateBadge, { borderColor: color }]}>
            <PrMark state={pr.state} size={11} />
            <Text style={[styles.stateText, { color }]}>{PR_STATE_TEXT[pr.state]}</Text>
          </View>
        </View>
        <Pressable
          onPress={() => openUrl(pr.url)}
          accessibilityRole="link"
          style={({ pressed }) => ({ opacity: pressed ? 0.55 : 1 })}
        >
          <Text style={[styles.prTitle, { color: c.text }]} numberOfLines={3}>
            <Text style={{ color: c.textTertiary, fontWeight: '400' }}>#{pr.number} </Text>
            {pr.title}
          </Text>
        </Pressable>
        {total > 0 ? (
          <>
            <View style={styles.segments}>
              {checks.runs.map((run, i) => (
                <View
                  key={`${i}:${run.name}`}
                  style={[
                    styles.segment,
                    {
                      backgroundColor:
                        run.outcome === 'passed'
                          ? c.success
                          : run.outcome === 'failed'
                            ? c.danger
                            : c.fillStrong,
                    },
                  ]}
                />
              ))}
            </View>
            <Text style={[styles.hintText, { color: c.textTertiary }]}>
              {total} 项检查通过 {checks.passed} 项
            </Text>
            {checks.runs.map((run, i) => (
              <CheckRow key={`${i}:${run.name}`} run={run} />
            ))}
          </>
        ) : null}
        <View style={styles.prFoot}>
          <PillButton label="在 GitHub 上打开" icon={G.link} onPress={() => openUrl(pr.url)} />
          {note ? (
            <Text
              style={[
                styles.hintText,
                styles.flex,
                {
                  color: pr.mergeable === 'conflicting' && !done ? c.danger : c.textTertiary,
                  textAlign: 'right',
                },
              ]}
              numberOfLines={2}
            >
              {note}
            </Text>
          ) : null}
        </View>
      </Card>
    )
  }

  if (props.loading && !props.error) {
    return (
      <Card>
        <PartHead title="拉取请求" />
        <ActivityIndicator color={c.textSecondary} style={styles.loading} />
      </Card>
    )
  }

  const head = pullRequestHead(status)
  const target = pushTargetOf(status)
  const compare =
    head !== null && status.defaultBranch !== null
      ? `https://github.com/${github.owner}/${github.repo}/compare/${encodeURIComponent(status.defaultBranch)}...${head
          .split(':')
          .map(encodeURIComponent)
          .join(':')}?expand=1`
      : null

  let line: string
  let action: ReactNode = null
  if (props.error) {
    line = '无法加载这个 Pull Request。'
    action = <PillButton label="重试" icon={G.retry} onPress={props.onRetry} />
  } else if (props.gh === 'not-installed') {
    line = '安装 GitHub CLI 后即可查看和创建 Pull Request。'
    if (compare) {
      action = (
        <PillButton label="在 GitHub 上打开" icon={G.link} onPress={() => openUrl(compare)} />
      )
    }
  } else if (props.gh === 'signed-out') {
    line = '登录 GitHub CLI 后即可查看 Pull Request：gh auth login'
    action = (
      <PillButton
        label="复制命令"
        icon={G.copy}
        onPress={() =>
          void copyText('gh auth login').then(() => showNotice({ text: '已复制', tone: 'success' }))
        }
      />
    )
  } else if (!target || target.setUpstream) {
    if (status.head.detached || !status.head.branch || !target) return null
    line = '发布此分支后才能创建 Pull Request。'
  } else if (head === null) {
    return null
  } else {
    line = '没有 Pull Request'
    action = <PillButton label="创建 Pull Request…" icon={GI.pr} onPress={props.onCreate} />
  }
  return (
    <Card>
      <PartHead title="拉取请求" />
      <View style={styles.prLine}>
        <Text style={[styles.hintText, styles.flex, { color: c.textSecondary }]}>{line}</Text>
        {action}
      </View>
    </Card>
  )
}

/** A new file reads as added whether or not it is staged, as the desktop's badge says. */
const LETTERS: Record<ChangeStatus, string> = {
  added: 'A',
  untracked: 'A',
  modified: 'M',
  renamed: 'R',
  copied: 'C',
  typechange: 'T',
  deleted: 'D',
  conflicted: '!',
}

const STATUS_TEXT: Record<ChangeStatus, string> = {
  added: '新增',
  untracked: '新文件',
  modified: '修改',
  typechange: '类型改变',
  renamed: '重命名',
  copied: '复制',
  deleted: '删除',
  conflicted: '冲突',
}

function ChangeBadge(props: { status: ChangeStatus }) {
  const { c, s } = useSessionTokens()
  const tone =
    props.status === 'added' || props.status === 'untracked'
      ? { color: c.added, bg: c.addedBg }
      : props.status === 'deleted' || props.status === 'conflicted'
        ? { color: c.removed, bg: c.removedBg }
        : { color: c.warning, bg: s.warningSoft }
  return (
    <View style={[styles.mark, { backgroundColor: tone.bg }]}>
      <Text style={[styles.markText, { color: tone.color }]}>{LETTERS[props.status]}</Text>
    </View>
  )
}

interface FileRowProps {
  file: ChangedFile
  first: boolean
  last: boolean
  onPress(): void
  /** What its long press offers. */
  menu?: MenuNode[]
  nested?: boolean
}

export function FileRow(props: FileRowProps) {
  return (
    <ContextMenu items={props.menu ?? []} title={props.file.path}>
      {(longPress) => <FileRowBody {...props} longPress={longPress} />}
    </ContextMenu>
  )
}

function FileRowBody(props: FileRowProps & { longPress: (() => void) | undefined }) {
  const { c, s } = useSessionTokens()
  const { file } = props
  const dir = dirName(file.path)
  const counted = file.insertions !== null && file.deletions !== null
  return (
    <Pressable
      onPress={props.onPress}
      {...(props.longPress ? { onLongPress: props.longPress, delayLongPress: 350 } : {})}
      accessibilityRole="button"
      accessibilityLabel={`${STATUS_TEXT[file.status]} ${file.path}`}
      {...(props.menu?.length ? { accessibilityHint: '长按查看更多操作' } : {})}
      style={({ pressed }) => [
        styles.file,
        props.nested && styles.nestedFile,
        {
          backgroundColor: pressed ? c.fill : s.dockCard,
          borderTopLeftRadius: props.first ? 16 : 0,
          borderTopRightRadius: props.first ? 16 : 0,
          borderBottomLeftRadius: props.last ? 16 : 0,
          borderBottomRightRadius: props.last ? 16 : 0,
        },
      ]}
    >
      <FileMark path={file.path} size={props.nested ? 15 : 17} />
      <View style={styles.flex}>
        <Text
          style={[
            styles.name,
            {
              color: c.text,
              textDecorationLine: file.status === 'deleted' ? 'line-through' : 'none',
            },
          ]}
          numberOfLines={1}
        >
          {baseName(file.path)}
        </Text>
        {dir || file.oldPath ? (
          <Text
            style={[styles.dir, { color: c.textTertiary }]}
            numberOfLines={1}
            ellipsizeMode="head"
          >
            {file.oldPath ? `${file.oldPath} → ` : ''}
            {dir}
          </Text>
        ) : null}
      </View>
      {counted && (file.insertions || file.deletions) ? (
        <Counts insertions={file.insertions!} deletions={file.deletions!} />
      ) : null}
      <ChangeBadge status={file.status} />
      <Icon icon={G.right} size={12} color={c.textTertiary} weight="semibold" />
    </Pressable>
  )
}

export function Separator() {
  const { c, s } = useSessionTokens()
  return (
    <View style={{ backgroundColor: s.dockCard }}>
      <View style={[styles.separator, { backgroundColor: c.border }]} />
    </View>
  )
}

const COMMITS_SHOWN = 5

/** The commits on this branch and not on the default one, oldest first; each opens to its files. */
export function CommitsPart(props: { link: HostLink; status: GitStatus; sessionId: string }) {
  const { c } = useSessionTokens()
  const { status } = props
  const [all, setAll] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const commits = status.commits
  if (commits.length === 0) return null
  const shown = (all ? commits : commits.slice(0, COMMITS_SHOWN)).slice().reverse()
  return (
    <Card>
      <PartHead title="此分支上">
        <Text style={[styles.hintText, { color: c.textTertiary }]}>{commits.length} 个提交</Text>
      </PartHead>
      {shown.length < commits.length ? (
        <Pressable onPress={() => setAll(true)} accessibilityRole="button" style={styles.more}>
          <Text style={[styles.hintText, { color: c.tint }]}>
            还有 {commits.length - shown.length} 个
          </Text>
        </Pressable>
      ) : null}
      {shown.map((commit) => (
        <CommitRow
          key={commit.oid}
          link={props.link}
          status={status}
          sessionId={props.sessionId}
          commit={commit}
          open={open === commit.oid}
          onToggle={() => {
            haptic.tap()
            setOpen((was) => (was === commit.oid ? null : commit.oid))
          }}
        />
      ))}
    </Card>
  )
}

function CommitRow(props: {
  link: HostLink
  status: GitStatus
  sessionId: string
  commit: CommitSummary
  open: boolean
  onToggle(): void
}) {
  const { c, s } = useSessionTokens()
  const { commit, status } = props
  const [details, setDetails] = useState<CommitDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!props.open || details) return
    let live = true
    call(props.link, 'git.commit', { projectPath: status.projectPath, oid: commit.oid }).then(
      (read) => live && setDetails(read),
      (e: unknown) => live && setError(errorText(e, '读不到这个提交')),
    )
    return () => {
      live = false
    }
  }, [props.open, details, props.link, status.projectPath, commit.oid])
  const github = status.remote?.github
  const commitUrl =
    github && commit.pushed
      ? `https://github.com/${github.owner}/${github.repo}/commit/${commit.oid}`
      : null
  const menu: MenuNode[] = [
    {
      key: 'copy',
      label: '复制提交 ID',
      icon: 'doc.on.doc',
      onPress: () =>
        void copyText(commit.oid).then(() =>
          showNotice({ text: '已复制提交 ID', tone: 'success' }),
        ),
    },
    ...(commitUrl
      ? [
          {
            key: 'github',
            label: '在 GitHub 上打开',
            icon: 'link' as const,
            onPress: () => openUrl(commitUrl),
          },
        ]
      : []),
  ]
  return (
    <View>
      <ContextMenu items={menu} title={commit.subject}>
        {(longPress) => (
          <Pressable
            onPress={props.onToggle}
            {...(longPress ? { onLongPress: longPress } : {})}
            accessibilityRole="button"
            accessibilityState={{ expanded: props.open }}
            accessibilityHint="长按查看更多操作"
            style={({ pressed }) => [
              styles.commitRow,
              { backgroundColor: s.dockCard, opacity: pressed ? 0.55 : 1 },
            ]}
          >
            <Text style={[styles.oid, { color: c.textTertiary }]}>{commit.oid.slice(0, 7)}</Text>
            <Text style={[styles.subject, { color: c.text }]} numberOfLines={1}>
              {commit.subject}
            </Text>
            <Text style={[styles.when, { color: c.textTertiary }]}>{ago(commit.authoredAt)}</Text>
          </Pressable>
        )}
      </ContextMenu>
      {props.open ? (
        <View style={styles.commitFiles}>
          {details ? (
            <>
              {details.body ? (
                <Text selectable style={[styles.hintText, { color: c.textSecondary }]}>
                  {details.body}
                </Text>
              ) : null}
              <Text style={[styles.when, { color: c.textTertiary }]}>{details.authorName}</Text>
              {details.files.map((file, i) => (
                <FileRow
                  key={file.path}
                  nested
                  file={file}
                  first={i === 0}
                  last={i === details.files.length - 1}
                  onPress={() =>
                    router.push({
                      pathname: '/diff',
                      params: {
                        id: props.sessionId,
                        path: file.path,
                        ref: commit.oid,
                        ...(file.oldPath ? { oldPath: file.oldPath } : {}),
                      },
                    })
                  }
                />
              ))}
              {commitUrl ? (
                <PillButton
                  label="在 GitHub 上打开"
                  icon={G.link}
                  onPress={() => openUrl(commitUrl)}
                />
              ) : null}
            </>
          ) : error ? (
            <Text style={[styles.hintText, { color: c.danger }]}>{error}</Text>
          ) : (
            <ActivityIndicator color={c.textSecondary} style={styles.loading} />
          )}
        </View>
      ) : null}
    </View>
  )
}

/** The folder the branch is checked out in; its long press offers to copy it. */
export function FolderFooter(props: { status: GitStatus }) {
  const { c } = useSessionTokens()
  const repo = props.status.repo
  if (!repo) return null
  const linked = isLinkedWorktree(repo.gitDir)
  const root = repo.root
  return (
    <ContextMenu
      items={[
        {
          key: 'copy',
          label: '复制路径',
          icon: 'doc.on.doc',
          onPress: () =>
            void copyText(root).then(() => showNotice({ text: '已复制', tone: 'success' })),
        },
      ]}
    >
      {(longPress) => (
        <Pressable
          {...(longPress ? { onLongPress: longPress } : {})}
          accessibilityRole="text"
          accessibilityLabel={root}
          accessibilityHint="长按复制路径"
          style={[styles.footer, { backgroundColor: c.bg }]}
        >
          <Icon icon={linked ? G.fork : G.folderOpen} size={13} color={c.textTertiary} />
          <Text style={[styles.path, { color: c.textTertiary }]} numberOfLines={2}>
            {root}
          </Text>
        </Pressable>
      )}
    </ContextMenu>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  card: { borderRadius: 16, padding: 14, gap: 8, marginBottom: 12 },
  flush: { padding: 0 },
  partHead: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 24 },
  partTitle: { fontSize: 13, fontWeight: '600' },
  branchRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  branch: { fontSize: 18, fontWeight: '600', flexShrink: 1 },
  sub: { fontSize: 13, marginLeft: 24, marginTop: -4 },
  opChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  opText: { fontSize: 13, fontWeight: '500' },
  syncRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  counts: {
    flex: 1,
    height: 34,
    borderRadius: 10,
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  countText: { fontSize: 13, fontVariant: ['tabular-nums'] },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 34,
    paddingHorizontal: 13,
    borderRadius: 999,
  },
  pillText: { fontSize: 14, fontWeight: '600' },
  hint: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  hintText: { fontSize: 13, lineHeight: 18 },
  loading: { paddingVertical: 10 },
  commitRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 34 },
  oid: { fontFamily: MONO, fontSize: 12 },
  subject: { flex: 1, fontSize: 14 },
  when: { fontSize: 12, fontVariant: ['tabular-nums'], flexShrink: 0, maxWidth: 140 },
  commitFiles: { paddingLeft: 12, paddingBottom: 8, gap: 6 },
  more: { minHeight: 28, justifyContent: 'center' },
  stateBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 8,
    height: 22,
  },
  stateText: { fontSize: 12, fontWeight: '600' },
  prTitle: { fontSize: 15, lineHeight: 21, fontWeight: '600' },
  segments: { flexDirection: 'row', gap: 3, marginTop: 2 },
  segment: { flex: 1, height: 4, borderRadius: 2 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 28 },
  checkIcon: { width: 16, alignItems: 'center' },
  runSpin: { transform: [{ scale: 0.6 }], width: 13, height: 13 },
  checkName: { flex: 1, fontSize: 13 },
  prFoot: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 },
  prLine: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  file: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingHorizontal: 14,
    minHeight: 58,
  },
  nestedFile: { minHeight: 46, paddingHorizontal: 10 },
  name: { fontSize: 15, lineHeight: 20, fontWeight: '500' },
  dir: { fontSize: 12, lineHeight: 16, marginTop: 1 },
  mark: { width: 20, height: 20, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  markText: { fontSize: 11, fontWeight: '700' },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 46 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 4,
    paddingTop: 4,
  },
  path: { flex: 1, fontFamily: MONO, fontSize: 11.5, lineHeight: 16 },
})
