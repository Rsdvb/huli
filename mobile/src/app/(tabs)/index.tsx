// Home: a greeting and what needs the user, then every session on the computer, pinned ones first.
// Search is a page of its own (search.tsx), from the top bar. On a wide window (iPad) the list
// keeps a column on the left and the chosen session opens beside it, in the session screen itself.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Animated, FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import type { SessionSummary } from '@shared/agent-host'
import { useSessionActions } from '../../components/SessionActions'
import { SessionPaneProvider } from '../../components/SessionPane'
import { SessionRow, SessionRowSkeleton, subagentCounts } from '../../components/SessionRow'
import {
  FilterNote,
  inFilter,
  sessionFilterItem,
  TopBar,
  useScrollTopOnTabPress,
  useShell,
} from '../../components/shell'
import { SyncNote } from '../../components/SyncNote'
import { UpdateBanner } from '../../components/UpdateBanner'
import { useHost } from '../../host'
import { linkProblem } from '../../linkInfo'
import { greeting, listOrder, needsYou, withChildWaits } from '../../sessions'
import { EmptyState } from '../../ui/EmptyState'
import { Icon } from '../../ui/Icon'
import { LIST_COLUMN, useWide } from '../../ui/layout'
import { Press } from '../../ui/Press'
import { Screen } from '../../ui/Screen'
import { useCollapsingHeader } from '../../ui/ScrollHeader'
import { SectionHeader } from '../../ui/SectionHeader'
import { computerName } from '../../store'
import { haptic } from '../../ui/haptics'
import { Pill } from '../../ui/Pill'
import { AgentAvatar } from '../../ui/AgentAvatar'
import { radius, space, TAB_BAR_CLEARANCE, type as typeScale, useTokens } from '../../ui/tokens'
import SessionScreen from '../session/[id]'

function isRunning(s: SessionSummary): boolean {
  return s.status === 'running' || s.status === 'starting'
}

/** The agents of some sessions as small overlapping avatars, inside a line of the greeting. */
function Inline(props: { agents: SessionSummary[] }) {
  const { c } = useTokens()
  const ids = [...new Set(props.agents.map((s) => s.agentId))].slice(0, 3)
  return (
    <View style={styles.inline}>
      {ids.map((id, i) => (
        <View
          key={id}
          style={[styles.inlineAvatar, { marginLeft: i === 0 ? 0 : -8, borderColor: c.bg }]}
        >
          <AgentAvatar agentId={id} size={24} />
        </View>
      ))}
    </View>
  )
}

type Item =
  | { kind: 'section'; key: string; title: string; count: number; waiting?: boolean }
  | { kind: 'session'; key: string; session: SessionSummary }

export default function Home() {
  const wide = useWide()
  const { c } = useTokens()
  const host = useHost()
  const [selected, setSelected] = useState<string | null>(null)

  // A session that went away on the computer leaves the pane.
  const gone = selected !== null && host.loaded && !host.sessions.has(selected)
  useEffect(() => {
    if (gone) setSelected(null)
  }, [gone])

  if (!wide) {
    return <SessionList selected={null} onOpen={(id) => router.push(`/session/${id}`)} />
  }
  return (
    <View style={[styles.split, { backgroundColor: c.bg }]}>
      <View style={styles.column}>
        <SessionList selected={selected} onOpen={setSelected} />
      </View>
      <View style={[styles.divider, { backgroundColor: c.border }]} />
      <View style={styles.pane}>
        {selected ? (
          <SessionPaneProvider id={selected} open={setSelected} close={() => setSelected(null)}>
            <SessionScreen key={selected} />
          </SessionPaneProvider>
        ) : (
          <Screen edges={['top']}>
            <View style={styles.placeholder}>
              <EmptyState
                icon="message"
                title="选一个会话"
                message="左边列表里的会话会在这里打开，列表一直留在旁边。"
              />
            </View>
          </Screen>
        )}
      </View>
    </View>
  )
}

function SessionList(props: { selected: string | null; onOpen(id: string): void }) {
  const { c } = useTokens()
  const host = useHost()
  const shell = useShell()
  const header = useCollapsingHeader()
  const insets = useSafeAreaInsets()
  const list = useRef<FlatList<Item>>(null)
  const [refreshing, setRefreshing] = useState(false)
  const actions = useSessionActions('list')
  useScrollTopOnTabPress(
    (offset) => list.current?.scrollToOffset({ offset, animated: true }),
    header,
  )

  // A sub-session's or sub-agent's wait counts on the session the list shows, as on the desktop.
  const listed = useMemo(
    () =>
      [...withChildWaits(host.sessions).values()].filter(
        (s) => s.parentId === null && s.archivedAt === null,
      ),
    [host.sessions],
  )
  const archivedCount = useMemo(
    () =>
      [...host.sessions.values()].filter((s) => s.parentId === null && s.archivedAt !== null)
        .length,
    [host.sessions],
  )
  const projectNames = useMemo(
    () => new Map(host.projects.map((p) => [p.path, p.name])),
    [host.projects],
  )

  const visible = useMemo(
    () => listed.filter((s) => inFilter(shell.filter, sessionFilterItem(s))).sort(listOrder),
    [listed, shell.filter],
  )

  const connected = host.state.kind === 'connected'
  const waiting = listed.filter(needsYou).length
  const runningNow = listed.filter((s) => !needsYou(s) && isRunning(s))
  const subagents = useMemo(() => subagentCounts(host.sessions.values()), [host.sessions])
  const problem = linkProblem(host.state)

  const items = useMemo<Item[]>(() => {
    const needing = visible.filter(needsYou)
    const running = visible.filter((s) => !needsYou(s) && isRunning(s))
    const rest = visible.filter((s) => !needsYou(s) && !isRunning(s))
    const out: Item[] = []
    if (needing.length > 0) {
      out.push({
        kind: 'section',
        key: '__waiting',
        title: '需要你处理',
        count: needing.length,
        waiting: true,
      })
      for (const s of needing) out.push({ kind: 'session', key: s.id, session: s })
    }
    if (running.length > 0) {
      out.push({ kind: 'section', key: '__running', title: '正在运行', count: running.length })
      for (const s of running) out.push({ kind: 'session', key: s.id, session: s })
    }
    if (rest.length > 0) {
      out.push({ kind: 'section', key: '__recent', title: '最近', count: rest.length })
      for (const s of rest) out.push({ kind: 'session', key: s.id, session: s })
    }
    return out
  }, [visible])

  // With the cache's lists the summary still says what they said; the note under it says when.
  const summary =
    !connected && !host.loaded
      ? host.unreachable && host.state.kind !== 'stopped'
        ? `连不上「${computerName(host.host)}」。`
        : problem
      : null
  // Connected, it says what waits and what runs, each with its agents' avatars, as Kettu's does.
  const counts =
    summary === null ? (
      <Text style={[typeScale.lead, { color: c.textSecondary }]}>
        {waiting === 0 && runningNow.length === 0 ? (
          '这里没有需要你处理的。'
        ) : (
          <>
            你有
            {waiting > 0 ? (
              <>
                {' '}
                <Inline agents={listed.filter(needsYou)} />
                <Text style={{ color: c.text }}> {waiting} 个在等你</Text>
              </>
            ) : null}
            {waiting > 0 && runningNow.length > 0 ? '，' : null}
            {runningNow.length > 0 ? (
              <>
                {' '}
                <Inline agents={runningNow} />
                <Text style={{ color: c.text }}> {runningNow.length} 个运行中</Text>
              </>
            ) : null}
            。
          </>
        )}
      </Text>
    ) : (
      <Text style={[typeScale.lead, { color: c.textSecondary }]}>{summary}</Text>
    )

  const top = (
    <View style={styles.top}>
      <View style={styles.greeting} accessibilityRole="header">
        <Text style={[typeScale.lead, { color: c.textSecondary }]}>{greeting()}。</Text>
        {counts}
        {host.loaded ? <SyncNote /> : null}
      </View>
      <UpdateBanner />
      <FilterNote what="会话" />
    </View>
  )

  const empty = () => {
    if (!host.loaded) {
      if (!connected && host.unreachable && host.state.kind !== 'stopped') return <Unreachable />
      return <SessionRowSkeleton />
    }
    if (shell.filter.kind !== 'all') {
      return (
        <EmptyState
          icon="folder"
          title="这个项目里没有会话"
          action={{ label: '查看全部项目', onPress: () => shell.setFilter({ kind: 'all' }) }}
        />
      )
    }
    return (
      <EmptyState
        icon="message"
        title="还没有会话"
        message="在手机上开一个，电脑上的智能体就会开始干活。"
        action={connected ? { label: '新会话', onPress: () => router.push('/new') } : undefined}
      />
    )
  }

  const footer =
    archivedCount > 0 ? (
      <Press
        onPress={() => router.push('/archived')}
        scale={false}
        accessibilityRole="button"
        style={styles.archived}
      >
        <Icon name="archive" size={18} color={c.textSecondary} />
        <Text style={[typeScale.callout, { color: c.textSecondary, flex: 1 }]}>已归档的会话</Text>
        <Text style={[typeScale.callout, styles.count, { color: c.textTertiary }]}>
          {archivedCount}
        </Text>
        <Icon name="chevronRight" size={13} color={c.textTertiary} weight="semibold" />
      </Press>
    ) : null

  // Sessions new to the list since it first showed come in with an animation; rows the list only
  // mounts again as it scrolls do not.
  const seen = useRef<Set<string> | null>(null)
  const fresh = useRef(new Set<string>())
  const ids = items.flatMap((item) => (item.kind === 'section' ? [] : [item.session.id]))
  if (seen.current === null) {
    if (ids.length > 0) seen.current = new Set(ids)
  } else {
    for (const sid of ids) {
      if (!seen.current.has(sid)) {
        seen.current.add(sid)
        fresh.current.add(sid)
      }
    }
  }
  useEffect(() => {
    fresh.current.clear()
  })

  const renderItem = ({ item }: { item: Item }) => {
    if (item.kind === 'section') {
      return (
        <View style={styles.pad}>
          <SectionHeader
            title={item.title}
            count={item.count}
            color={item.waiting ? c.warning : undefined}
          />
        </View>
      )
    }
    const s = item.session
    return (
      <SessionRow
        session={s}
        subagents={subagents.get(s.id)}
        agentName={host.agents.get(s.agentId)?.name}
        projectName={projectNames.get(s.projectPath)}
        selected={props.selected === s.id}
        appear={fresh.current.has(s.id)}
        onPress={() => props.onOpen(s.id)}
        onLongPress={() => actions.open(s)}
        start={
          connected
            ? {
                label: s.pinnedAt !== null ? '取消置顶' : '置顶',
                icon: s.pinnedAt !== null ? 'unpin' : 'pin',
                color: c.accent,
                onPress: () => actions.togglePin(s),
              }
            : undefined
        }
        end={
          connected
            ? { label: '归档', icon: 'archive', color: c.tint, onPress: () => actions.archive(s) }
            : undefined
        }
      />
    )
  }

  return (
    <Screen>
      <Animated.FlatList
        ref={list}
        data={items}
        extraData={props.selected}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        {...header.scrollProps}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingTop: header.contentTop,
          paddingBottom: insets.bottom + TAB_BAR_CLEARANCE,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={c.textSecondary}
            progressViewOffset={header.height}
            onRefresh={() => {
              setRefreshing(true)
              host.retry()
              void host
                .refresh()
                .catch(() => {})
                .finally(() => setRefreshing(false))
            }}
          />
        }
        ListHeaderComponent={top}
        ListEmptyComponent={empty()}
        ListFooterComponent={footer ?? undefined}
      />
      <TopBar header={header} />
      {actions.element}
    </Screen>
  )
}

const REASONS = [
  '电脑上的 Huli 没开，或者电脑睡着了',
  '手机和电脑不在同一个网络，或者 Tailscale 没连上',
  '电脑上的「设置 › 远程访问」被关掉了',
]

/** Nothing cached and no link for a while: why that may be, and a way to try again. */
function Unreachable() {
  const { c } = useTokens()
  const host = useHost()
  const several = host.computers.length > 1
  return (
    <View style={styles.pad}>
      <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
        <View style={[styles.badge, { backgroundColor: c.fill }]}>
          <Icon name="wifi" size={24} color={c.textSecondary} />
        </View>
        <Text style={[typeScale.headline, { color: c.text }]}>
          连不上「{computerName(host.host)}」
        </Text>
        <Text style={[typeScale.footnote, { color: c.textSecondary }]}>可能是：</Text>
        {REASONS.map((reason) => (
          <View key={reason} style={styles.reason}>
            <Text style={[typeScale.callout, { color: c.textSecondary }]}>·</Text>
            <Text style={[typeScale.callout, styles.flex, { color: c.text }]}>{reason}</Text>
          </View>
        ))}
        <Text style={[typeScale.footnote, { color: c.textTertiary }]}>
          Huli 会在后台继续尝试，连上后这里会自动出现会话。
        </Text>
        <View style={styles.buttons}>
          <Pill
            tone="tint"
            label="重试"
            leading={<Icon name="refresh" size={14} color={c.tint} />}
            onPress={() => {
              haptic.tap()
              host.retry()
            }}
          />
          {several ? (
            <Pill
              tone="fill"
              label="换一台电脑"
              onPress={() => router.push('/settings/computers')}
            />
          ) : null}
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  inline: { flexDirection: 'row', alignItems: 'center', transform: [{ translateY: 5 }] },
  inlineAvatar: { borderWidth: 2, borderRadius: 14 },
  card: {
    marginTop: space.lg,
    padding: space.lg,
    gap: space.sm,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  badge: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xs,
  },
  reason: { flexDirection: 'row', gap: space.sm },
  flex: { flex: 1 },
  buttons: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  split: { flex: 1, flexDirection: 'row' },
  column: { width: LIST_COLUMN },
  divider: { width: StyleSheet.hairlineWidth },
  pane: { flex: 1 },
  placeholder: { flex: 1, justifyContent: 'center' },
  pad: { paddingHorizontal: space.xl },
  top: { paddingHorizontal: space.xl, paddingTop: space.sm },
  greeting: { gap: space.xs, paddingTop: space.md, paddingBottom: space.sm },
  archived: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginTop: space.lg,
    paddingHorizontal: space.xl,
    paddingVertical: space.lg,
  },
  count: { fontVariant: ['tabular-nums'] },
})
