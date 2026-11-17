// The worktree a session works in, as the desktop shows it above its composer and in its menus:
// the branch and folder, how its preparation goes (with the setup command's output, Retry and
// Skip), and what removing it would lose, as `worktrees.inspect` reads it.

import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import type { SessionWorktree, WorktreeFailure, WorktreeInspection } from '@shared/git'
import { call, errorText } from '../../git'
import { useLink } from '../../host'
import { BottomSheet } from '../../ui/BottomSheet'
import { ContextMenu } from '../../ui/ContextMenu'
import { copyText, haptic } from '../../ui/session/feedback'
import { G, Icon } from '../../ui/session/icons'
import { MONO, useSessionTokens } from '../../ui/session/palette'
import { showNotice } from '../../ui/NoticeBar'

const POLL_MS = 2000
const FAILURE_LINES = 6

interface SetupLog {
  log: string | null
  error: string | null
}

/** The setup output, read while `active`, and while `live` every 2 s from where the last ended. */
export function useSetupLog(sessionId: string, active: boolean, live: boolean): SetupLog {
  const link = useLink()
  const [state, setState] = useState<SetupLog>({ log: null, error: null })
  useEffect(() => {
    if (!active) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let log: string | null = null
    let end: number | undefined
    const read = () => {
      call(link, 'worktrees.setupLog', {
        sessionId,
        ...(end === undefined ? {} : { from: end }),
      }).then(
        (got) => {
          if (stopped) return
          log = log !== null && end !== undefined && got.start === end ? log + got.log : got.log
          end = got.end
          setState({ log, error: null })
        },
        (error: unknown) =>
          !stopped && setState((s) => ({ ...s, error: errorText(error, '读不到输出') })),
      )
      if (live) timer = setTimeout(read, POLL_MS)
    }
    read()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [link, sessionId, active, live])
  return state
}

function lastLines(text: string, count: number): string {
  return text.trimEnd().split(/\r?\n/).slice(-count).join('\n')
}

function failureText(failure: WorktreeFailure): string {
  if (failure.stage === 'copy') return '复制本地文件失败。'
  return failure.exitCode === null
    ? '初始化命令没跑完就被结束了。'
    : `初始化命令退出，退出码 ${failure.exitCode}。`
}

/** Retry and Skip of a worktree's setup, with their busy state and error. */
function useSetupActions(sessionId: string) {
  const link = useLink()
  const [busy, setBusy] = useState<'retry' | 'skip' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = (action: 'retry' | 'skip') => {
    setBusy(action)
    setError(null)
    haptic.tap()
    const request =
      action === 'retry'
        ? call(link, 'worktrees.retrySetup', { sessionId })
        : call(link, 'worktrees.skipSetup', { sessionId })
    request.catch((e: unknown) => setError(errorText(e, '没能完成'))).finally(() => setBusy(null))
  }
  return { busy, error, run }
}

function SmallButton(props: {
  label: string
  onPress(): void
  busy?: boolean
  disabled?: boolean
  filled?: boolean
}) {
  const { c } = useSessionTokens()
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled || props.busy}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!(props.disabled || props.busy), busy: !!props.busy }}
      style={({ pressed }) => [
        styles.small,
        {
          backgroundColor: props.filled ? c.accent : c.fillStrong,
          opacity: props.disabled ? 0.4 : pressed ? 0.6 : 1,
        },
      ]}
    >
      {props.busy ? (
        <ActivityIndicator size="small" color={props.filled ? c.onAccent : c.textSecondary} />
      ) : null}
      <Text style={[styles.smallText, { color: props.filled ? c.onAccent : c.text }]}>
        {props.label}
      </Text>
    </Pressable>
  )
}

/** The setup command's whole output. */
export function SetupOutputSheet(props: { sessionId: string; visible: boolean; onClose(): void }) {
  const { c, s } = useSessionTokens()
  const { log, error } = useSetupLog(props.sessionId, props.visible, props.visible)
  return (
    <BottomSheet visible={props.visible} onClose={props.onClose} title="worktree 准备的输出">
      {error ? (
        <Text style={[styles.body, { color: c.danger }]}>没能读取输出：{error}</Text>
      ) : log === null ? (
        <ActivityIndicator color={c.textSecondary} style={{ paddingVertical: 24 }} />
      ) : (
        <ScrollView
          horizontal={false}
          style={[styles.log, { backgroundColor: s.code, borderColor: s.codeBorder }]}
          nestedScrollEnabled
        >
          <Text selectable style={[styles.logText, { color: c.text }]}>
            {log.trim() === '' ? '还没有输出。' : log}
          </Text>
        </ScrollView>
      )}
    </BottomSheet>
  )
}

/** Above a session's composer while its worktree is not ready; null otherwise. */
export function WorktreeLine(props: { sessionId: string; worktree: SessionWorktree }) {
  const { c, s } = useSessionTokens()
  const { state, branch } = props.worktree
  const preparing = state === 'creating' || state === 'setup'
  const { log } = useSetupLog(props.sessionId, state === 'setup', state === 'setup')
  const actions = useSetupActions(props.sessionId)
  const open = () => router.push({ pathname: '/changes/[id]', params: { id: props.sessionId } })
  if (preparing) {
    const last = log ? lastLines(log, 1).trim() : ''
    return (
      <View style={[styles.line, { backgroundColor: s.dockCard }]} accessibilityRole="summary">
        <ActivityIndicator size="small" color={c.textSecondary} />
        <Text style={[styles.lineText, { color: c.textSecondary }]}>
          {state === 'creating' ? '正在建 worktree…' : '正在准备 worktree…'}
        </Text>
        <Text style={[styles.lineLog, { color: c.textTertiary }]} numberOfLines={1}>
          {actions.error ?? last}
        </Text>
        {state === 'setup' ? (
          <SmallButton
            label="跳过并继续"
            busy={actions.busy === 'skip'}
            onPress={() => actions.run('skip')}
          />
        ) : null}
      </View>
    )
  }
  if (state === 'setup-failed') {
    return (
      <Pressable
        onPress={open}
        accessibilityRole="button"
        style={[styles.line, { backgroundColor: s.dangerSoft }]}
      >
        <Icon icon={G.error} size={15} color={c.danger} />
        <Text style={[styles.lineText, { color: c.text, flex: 1 }]} numberOfLines={1}>
          worktree 没能准备好
        </Text>
        <SmallButton
          label="重试"
          filled
          busy={actions.busy === 'retry'}
          disabled={actions.busy !== null}
          onPress={() => actions.run('retry')}
        />
        <Icon icon={G.right} size={12} color={c.textTertiary} />
      </Pressable>
    )
  }
  if (state === 'missing' || state === 'removed') {
    return (
      <View style={[styles.line, { backgroundColor: s.dockCard }]}>
        <Icon icon={G.info} size={14} color={c.tint} />
        <Text style={[styles.lineText, { color: c.textSecondary, flex: 1 }]}>
          {state === 'missing'
            ? `worktree 的文件夹在 Huli 之外被删掉了。发下一条消息时会按分支 ${branch} 重建。`
            : `worktree 的文件夹已删除。发下一条消息时会按分支 ${branch} 重建。`}
        </Text>
      </View>
    )
  }
  if (state === 'gone') {
    return (
      <View style={[styles.line, { backgroundColor: s.dockCard }]}>
        <Icon icon={G.info} size={14} color={c.textTertiary} />
        <Text style={[styles.lineText, { color: c.textSecondary, flex: 1 }]}>
          这个会话的 worktree 和分支都已删除，不能再继续对话。
        </Text>
      </View>
    )
  }
  return null
}

const STATE_TEXT: Record<SessionWorktree['state'], string> = {
  creating: '正在建 worktree…',
  setup: '正在准备 worktree…',
  'setup-failed': 'worktree 没能准备好',
  ready: '就绪',
  missing: '文件夹在 Huli 之外被删掉了',
  removed: '文件夹已删除',
  gone: 'worktree 和分支都已删除',
}

/** The changes screen's worktree part: where, how it stands, and what removing it would lose. */
export function WorktreeCard(props: { sessionId: string; worktree: SessionWorktree }) {
  const { c, s } = useSessionTokens()
  const link = useLink()
  const { worktree, sessionId } = props
  const [outputOpen, setOutputOpen] = useState(false)
  const actions = useSetupActions(sessionId)
  const failed = worktree.state === 'setup-failed'
  const preparing = worktree.state === 'creating' || worktree.state === 'setup'
  const { log } = useSetupLog(sessionId, worktree.state === 'setup', worktree.state === 'setup')
  const [inspection, setInspection] = useState<(WorktreeInspection & { others: string[] }) | null>(
    null,
  )
  const [inspectError, setInspectError] = useState<string | null>(null)
  const live = worktree.state !== 'removed' && worktree.state !== 'gone'

  useEffect(() => {
    if (!live || preparing) return
    let alive = true
    setInspectError(null)
    call(link, 'worktrees.inspect', { sessionId }).then(
      (read) => alive && setInspection(read),
      (error: unknown) => alive && setInspectError(errorText(error, '没能检查 worktree')),
    )
    return () => {
      alive = false
    }
  }, [link, sessionId, live, preparing, worktree.state])

  const detail =
    failed && worktree.failure?.message ? lastLines(worktree.failure.message, FAILURE_LINES) : ''
  const facts: string[] = []
  if (inspection) {
    if (inspection.uncommitted > 0) facts.push(`${inspection.uncommitted} 个未提交的文件`)
    if (inspection.unpushed > 0) facts.push(`${inspection.unpushed} 个提交还没推送`)
    if (inspection.merged) facts.push(`它的改动已经在 ${worktree.base} 里了。`)
    if (inspection.others.length > 0) facts.push(`还有 ${inspection.others.length} 个会话在用它`)
  }

  return (
    <View style={[styles.card, { backgroundColor: s.dockCard }]}>
      <View style={styles.head}>
        <Icon icon={G.fork} size={15} color={c.tint} />
        <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>
          在分支 {worktree.branch} 的 worktree 里工作
        </Text>
      </View>
      <ContextMenu
        items={[
          {
            key: 'copy',
            label: '复制路径',
            icon: 'doc.on.doc',
            onPress: () =>
              void copyText(worktree.path).then(() =>
                showNotice({ text: '已复制', tone: 'success' }),
              ),
          },
        ]}
      >
        {(longPress) => (
          <Pressable
            {...(longPress ? { onLongPress: longPress } : {})}
            accessibilityHint="长按复制路径"
            style={{ backgroundColor: s.dockCard }}
          >
            <Text style={[styles.path, { color: c.textTertiary }]} numberOfLines={2}>
              {worktree.path}
            </Text>
          </Pressable>
        )}
      </ContextMenu>
      <View style={styles.stateRow}>
        {preparing ? <ActivityIndicator size="small" color={c.textSecondary} /> : null}
        <Text
          style={[styles.body, { color: failed ? c.danger : c.textSecondary, flexShrink: 1 }]}
          numberOfLines={2}
        >
          {STATE_TEXT[worktree.state]}
          {worktree.base ? ` · 基于 ${worktree.base}` : ''}
        </Text>
      </View>
      {preparing && log ? (
        <Text style={[styles.logLine, { color: c.textTertiary }]} numberOfLines={1}>
          {lastLines(log, 1).trim()}
        </Text>
      ) : null}
      {failed ? (
        <Text style={[styles.body, { color: c.textSecondary }]}>
          {worktree.failure ? `${failureText(worktree.failure)} ` : ''}
          第一条消息会等 worktree 准备好再发给 Agent。
        </Text>
      ) : null}
      {detail ? (
        <View style={[styles.detail, { backgroundColor: s.code, borderColor: s.codeBorder }]}>
          <Text selectable style={[styles.logText, { color: c.textSecondary }]}>
            {detail}
          </Text>
        </View>
      ) : null}
      {facts.length > 0 ? (
        <Text style={[styles.body, { color: c.textSecondary }]}>{facts.join(' · ')}</Text>
      ) : inspectError ? (
        <Text style={[styles.body, { color: c.danger }]}>没能检查 worktree：{inspectError}</Text>
      ) : null}
      {failed || preparing || worktree.state === 'ready' ? (
        <View style={styles.buttons}>
          {failed ? (
            <SmallButton
              label="重试"
              filled
              busy={actions.busy === 'retry'}
              disabled={actions.busy !== null}
              onPress={() => actions.run('retry')}
            />
          ) : null}
          {failed || worktree.state === 'setup' ? (
            <SmallButton
              label="跳过并继续"
              busy={actions.busy === 'skip'}
              disabled={actions.busy !== null}
              onPress={() => actions.run('skip')}
            />
          ) : null}
          <SmallButton label="查看输出" onPress={() => setOutputOpen(true)} />
        </View>
      ) : null}
      {actions.error ? (
        <Text style={[styles.body, { color: c.danger }]}>{actions.error}</Text>
      ) : null}
      <SetupOutputSheet
        sessionId={sessionId}
        visible={outputOpen}
        onClose={() => setOutputOpen(false)}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  card: { borderRadius: 16, padding: 14, gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 15, fontWeight: '600', flexShrink: 1 },
  path: { fontFamily: MONO, fontSize: 11.5, lineHeight: 16 },
  stateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  body: { fontSize: 13, lineHeight: 18 },
  logLine: { fontFamily: MONO, fontSize: 11.5 },
  detail: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, padding: 10 },
  log: { maxHeight: 420, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, padding: 10 },
  logText: { fontFamily: MONO, fontSize: 12, lineHeight: 17 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 2 },
  small: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 32,
    paddingHorizontal: 14,
    borderRadius: 999,
  },
  smallText: { fontSize: 13.5, fontWeight: '600' },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minHeight: 40,
  },
  lineText: { fontSize: 13, fontWeight: '500' },
  lineLog: { flex: 1, fontFamily: MONO, fontSize: 11.5 },
})

export { SmallButton }
