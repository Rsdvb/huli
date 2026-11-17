// Home: a greeting and what needs the user, then every session on the computer, pinned ones first.
// Typing in search filters by title; submitting searches every message.

import { useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Animated,
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import type { ConversationHit, SearchIndexing, SessionSummary } from '@shared/agent-host'
import { useSessionActions } from '../../components/SessionActions'
import { SessionRow } from '../../components/SessionRow'
import {
  FilterNote,
  inFilter,
  sessionFilterItem,
  TopBar,
  useScrollTopOnTabPress,
  useShell,
} from '../../components/shell'
import { UpdateBanner } from '../../components/UpdateBanner'
import { useHost } from '../../host'
import { linkProblem } from '../../linkInfo'
import { errorText, greeting, listOrder, needsYou, sessionTitle } from '../../sessions'
import { EmptyState } from '../../ui/EmptyState'
import { Icon } from '../../ui/Icon'
import { Press } from '../../ui/Press'
import { Screen } from '../../ui/Screen'
import { useCollapsingHeader } from '../../ui/ScrollHeader'
import { SectionHeader } from '../../ui/SectionHeader'
import { SkeletonRows } from '../../ui/Skeleton'
import { radius, space, TAB_BAR_CLEARANCE, type as typeScale, useTokens } from '../../ui/tokens'

interface Search {
  query: string
  state: 'loading' | 'done' | 'error'
  hits: ConversationHit[]
  indexing: SearchIndexing | null
  error: string | null
}

type Item =
  | { kind: 'section'; key: string; title: string; count: number; waiting?: boolean }
  | { kind: 'session'; key: string; session: SessionSummary; snippet?: string }

export default function Home() {
  const { c } = useTokens()
  const host = useHost()
  const shell = useShell()
  const header = useCollapsingHeader()
  const insets = useSafeAreaInsets()
  const list = useRef<FlatList<Item>>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<Search | null>(null)
  const actions = useSessionActions('list')
  useScrollTopOnTabPress(
    (offset) => list.current?.scrollToOffset({ offset, animated: true }),
    header,
  )

  const listed = useMemo(
    () => [...host.sessions.values()].filter((s) => s.parentId === null && s.archivedAt === null),
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

  const words = shell.searching ? query.trim().toLowerCase() : ''
  const visible = useMemo(
    () =>
      listed
        .filter((s) => inFilter(shell.filter, sessionFilterItem(s)))
        .filter((s) => !words || sessionTitle(s).toLowerCase().includes(words))
        .sort(listOrder),
    [listed, shell.filter, words],
  )

  const connected = host.state.kind === 'connected'
  const waiting = listed.filter(needsYou).length
  const problem = linkProblem(host.state)

  const runSearch = () => {
    const text = query.trim()
    if (text.length < 2 || !host.link) {
      setSearch(null)
      return
    }
    const asked: Search = { query: text, state: 'loading', hits: [], indexing: null, error: null }
    setSearch(asked)
    void host.link.request('sessions.search', { query: text }).then(
      (answer) => {
        const { hits, indexing } = answer as { hits: ConversationHit[]; indexing?: SearchIndexing }
        setSearch((current) =>
          current?.query === text
            ? { ...asked, state: 'done', hits, indexing: indexing ?? null }
            : current,
        )
      },
      (error: unknown) =>
        setSearch((current) =>
          current?.query === text ? { ...asked, state: 'error', error: errorText(error) } : current,
        ),
    )
  }

  const stopSearching = () => {
    setQuery('')
    setSearch(null)
    shell.setSearching(false)
  }

  const items = useMemo<Item[]>(() => {
    if (search) {
      if (search.state !== 'done') return []
      return search.hits.flatMap((hit) => {
        const session = host.sessions.get(hit.sessionId)
        return session
          ? [{ kind: 'session' as const, key: hit.sessionId, session, snippet: hit.snippet }]
          : []
      })
    }
    const needing = visible.filter(needsYou)
    const rest = visible.filter((s) => !needsYou(s))
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
    if (rest.length > 0) {
      out.push({ kind: 'section', key: '__recent', title: '最近', count: rest.length })
      for (const s of rest) out.push({ kind: 'session', key: s.id, session: s })
    }
    return out
  }, [search, visible, host.sessions])

  const summary = !connected
    ? problem
    : waiting > 0
      ? `${waiting} 个会话在等你。`
      : '这里没有需要你处理的。'

  const searchBar = shell.searching ? (
    <View style={styles.searchRow}>
      <View style={[styles.searchBox, { backgroundColor: c.fill }]}>
        <Icon name="search" size={17} color={c.textSecondary} />
        <TextInput
          autoFocus
          value={query}
          onChangeText={(text) => {
            setQuery(text)
            if (search && text.trim() !== search.query) setSearch(null)
          }}
          onSubmitEditing={runSearch}
          placeholder="搜索标题，回车搜全文"
          placeholderTextColor={c.textTertiary}
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
          style={[typeScale.body, styles.searchInput, { color: c.text }]}
        />
      </View>
      <Press onPress={stopSearching} accessibilityRole="button" hitSlop={8}>
        <Text style={[typeScale.body, { color: c.tint }]}>取消</Text>
      </Press>
    </View>
  ) : null

  const top = (
    <View style={styles.top}>
      {!shell.searching && (
        <View style={styles.greeting} accessibilityRole="header">
          <Text style={[typeScale.lead, { color: c.textSecondary }]}>{greeting()}。</Text>
          <Text
            style={[typeScale.lead, { color: connected && waiting > 0 ? c.text : c.textSecondary }]}
          >
            {summary}
          </Text>
        </View>
      )}
      {searchBar}
      <UpdateBanner />
      <FilterNote what="会话" />
      {search && (
        <View style={styles.searchStatus}>
          <Text style={[typeScale.footnote, { color: c.textSecondary, flex: 1 }]}>
            {search.state === 'done'
              ? `全文搜索：${items.length} 个会话`
              : search.state === 'loading'
                ? '正在搜索…'
                : '搜索失败'}
            {search.indexing
              ? `（索引建立中 ${search.indexing.done}/${search.indexing.total}，结果可能不全）`
              : ''}
          </Text>
          <Press onPress={() => setSearch(null)} hitSlop={8}>
            <Text style={[typeScale.footnote, { color: c.tint }]}>返回列表</Text>
          </Press>
        </View>
      )}
    </View>
  )

  const empty = () => {
    if (search) {
      if (search.state === 'loading') {
        return <ActivityIndicator color={c.textSecondary} style={{ marginTop: space.xxxl }} />
      }
      if (search.state === 'error') {
        return (
          <EmptyState
            tone="error"
            icon="warning"
            title="搜索失败"
            message={search.error ?? undefined}
            action={{ label: '重试', onPress: runSearch }}
          />
        )
      }
      return <EmptyState icon="search" title={`没有对话包含「${search.query}」`} />
    }
    if (!host.loaded)
      return (
        <View style={styles.pad}>
          <SkeletonRows count={7} />
        </View>
      )
    if (words) {
      return (
        <EmptyState
          icon="search"
          title="没有标题匹配的会话"
          message="按回车搜索全部对话内容。"
          action={{ label: '搜索全文', onPress: runSearch }}
        />
      )
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
    archivedCount > 0 && !search ? (
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
        agentName={host.agents.get(s.agentId)?.name}
        projectName={projectNames.get(s.projectPath)}
        snippet={item.snippet}
        onPress={() => router.push(`/session/${s.id}`)}
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
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        {...header.scrollProps}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
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
              host.link?.wake()
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

const styles = StyleSheet.create({
  pad: { paddingHorizontal: space.xl },
  top: { paddingHorizontal: space.xl, paddingTop: space.sm },
  greeting: { gap: space.xs, paddingTop: space.md, paddingBottom: space.sm },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingTop: space.sm },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    height: 44,
  },
  searchInput: { flex: 1, paddingVertical: 0 },
  searchStatus: { flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingTop: space.md },
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
