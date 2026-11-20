// The chips under a session's header, as the desktop's top bar carries them: the parent a
// sub-session goes back to, the routine or task it runs for, the worktree it works in, and its
// pull requests with their state.

import { useEffect, useState, type ReactNode } from 'react'
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import type { SessionSummary } from '@shared/agent-host'
import { call } from '../git'
import { useConnected, useLink, useSession } from '../host'
import { sessionTitle } from '../sessions'
import { sessionPullRequests, topPrState } from '../sessionMenu'
import { TapMenu } from '../ui/ContextMenu'
import { GlassCapsule } from '../ui/Glass'
import type { MenuNode } from '../ui/menu'
import { showNotice } from '../ui/NoticeBar'
import { AgentGlyph, G, Icon } from '../ui/session/icons'
import { GI, PrMark } from '../ui/session/gitIcons'
import { useSessionTokens } from '../ui/session/palette'

export const CHIPS_HEIGHT = 40

/** Whether the session has any chip to show, for the room the conversation leaves under them. */
export function hasChips(summary: SessionSummary | undefined, parentKnown: boolean): boolean {
  if (!summary) return false
  return (
    (summary.parentId !== null && parentKnown) ||
    !!summary.routine ||
    !!summary.task ||
    !!summary.worktree ||
    sessionPullRequests(summary).length > 0
  )
}

function Chip(props: { children: ReactNode; label: string; onPress?: () => void }) {
  return (
    <Pressable
      onPress={props.onPress}
      disabled={!props.onPress}
      accessibilityRole={props.onPress ? 'button' : 'text'}
      accessibilityLabel={props.label}
      hitSlop={CHIP_SLOP}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <GlassCapsule height={30} style={styles.chip}>
        {props.children}
      </GlassCapsule>
    </Pressable>
  )
}

/** The chip's 30pt capsule takes touches over 44pt, short of the chip beside it. */
const CHIP_SLOP = { top: 7, bottom: 7, left: 3, right: 3 }

/** Names read before, so a chip coming back, or a session opened again, names at once. */
const names = new Map<string, string>()

/**
 * A name read from the computer, for a chip that names what the session runs for. A read made
 * while the computer was away is made again once it connects, rather than leave the chip generic.
 */
function useName(read: (() => Promise<string | null>) | null, key: string | null): string | null {
  const connected = useConnected()
  const [name, setName] = useState<string | null>(key ? (names.get(key) ?? null) : null)
  useEffect(() => {
    setName(key ? (names.get(key) ?? null) : null)
    if (!read || !key || !connected) return
    let live = true
    read().then(
      (got) => {
        if (got) names.set(key, got)
        if (live) setName(got)
      },
      () => {},
    )
    return () => {
      live = false
    }
    // `key` names what `read` reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, connected])
  return name
}

/** Opens a pull request's page, saying so when the phone cannot. */
function openPage(url: string): void {
  Linking.openURL(url).catch(() =>
    showNotice({ text: '打不开这个 Pull Request 的网页。', tone: 'warning' }),
  )
}

export function SessionChips(props: {
  summary: SessionSummary
  top: number
  onOpenSession(id: string): void
}) {
  const { c } = useSessionTokens()
  const link = useLink()
  const { summary } = props
  const parent = useSession(summary.parentId)
  const prs = sessionPullRequests(summary)
  const routineId = summary.routine?.routineId ?? null
  const taskId = summary.task?.taskId ?? null
  const routine = useName(
    routineId
      ? () =>
          call(link, 'routines.list', undefined).then(
            (list) => list.routines.find((r) => r.id === routineId)?.name ?? null,
          )
      : null,
    routineId && `routine:${routineId}`,
  )
  const task = useName(
    taskId ? () => call(link, 'tasks.get', { taskId }).then((view) => view.title) : null,
    taskId && `task:${taskId}`,
  )

  if (!hasChips(summary, !!parent)) return null
  // One pull request opens at a tap; several make the chip a menu of them.
  const prMenu: MenuNode[] =
    prs.length > 1
      ? prs.slice(0, 6).map((pr) => ({
          key: pr.url,
          label: `${pr.repo}#${pr.number}`,
          icon: 'arrow.triangle.pull',
          onPress: () => openPage(pr.url),
        }))
      : []
  const failing = prs.some((pr) => pr.failing)

  return (
    <View pointerEvents="box-none" style={[styles.dock, { top: props.top }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        keyboardShouldPersistTaps="handled"
      >
        {parent ? (
          <Chip
            label={`返回 ${sessionTitle(parent)}`}
            onPress={() => props.onOpenSession(parent.id)}
          >
            <Icon icon={G.back} size={12} color={c.textSecondary} weight="semibold" />
            {parent.origin === 'subagent' ? (
              <Icon icon={G.subagent} size={13} color={c.textSecondary} />
            ) : (
              <AgentGlyph agentId={parent.agentId} size={13} />
            )}
            <Text style={[styles.text, { color: c.text }]} numberOfLines={1}>
              {sessionTitle(parent)}
            </Text>
          </Chip>
        ) : null}
        {summary.routine ? (
          <Chip
            label={`定时任务 ${routine ?? ''}`}
            onPress={() => router.push(`/routine/${summary.routine!.routineId}`)}
          >
            <Icon icon={GI.routine} size={13} color={c.textSecondary} />
            <Text style={[styles.text, { color: c.text }]} numberOfLines={1}>
              {routine ?? '定时任务'}
            </Text>
          </Chip>
        ) : null}
        {summary.task ? (
          <Chip
            label={`任务 ${task ?? ''}`}
            onPress={() => router.push({ pathname: '/task/[id]', params: { id: taskId! } })}
          >
            <Icon icon={GI.task} size={13} color={c.textSecondary} />
            <Text style={[styles.text, { color: c.text }]} numberOfLines={1}>
              {task ?? '任务'}
            </Text>
          </Chip>
        ) : null}
        {summary.worktree ? (
          <Chip
            label={`在分支 ${summary.worktree.branch} 的 worktree 里工作`}
            onPress={() => router.push({ pathname: '/changes/[id]', params: { id: summary.id } })}
          >
            <Icon icon={G.fork} size={13} color={c.tint} />
            <Text style={[styles.text, { color: c.text }]} numberOfLines={1}>
              {summary.worktree.branch}
            </Text>
          </Chip>
        ) : null}
        {prs.length > 0 ? (
          <TapMenu items={prMenu} title="Pull Request">
            {(open) => (
              <Chip
                label={`${prs.length} 个 Pull Request${failing ? '，检查失败' : ''}`}
                onPress={open ?? (() => openPage(prs[0]!.url))}
              >
                <PrMark state={topPrState(prs)} size={13} failing={failing} />
                <Text style={[styles.text, { color: c.text }]}>
                  {prs.length === 1 ? `#${prs[0]!.number}` : prs.length}
                </Text>
              </Chip>
            )}
          </TapMenu>
        ) : null}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  // Over the header's scroll edge, which reaches under the chips.
  dock: { position: 'absolute', left: 0, right: 0, zIndex: 11 },
  row: { paddingHorizontal: 12, gap: 6, paddingVertical: 4 },
  chip: { paddingHorizontal: 11, gap: 5, maxWidth: 220 },
  text: { fontSize: 13, fontWeight: '500', flexShrink: 1 },
})
