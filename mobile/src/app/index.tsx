// Home: pairing until the phone has a computer, then every session on it, pinned ones first and
// then the ones that need the user. Typing filters by title; searching reads every message.

import { useMemo, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import type { ConversationHit, SearchIndexing, SessionSummary } from '@shared/agent-host'
import type { LinkState } from '@shared/remote/link'
import { useSessionActions } from '../components/SessionActions'
import { UpdateBanner } from '../components/UpdateBanner'
import { useHost } from '../host'
import { PairScreen } from '../screens/PairScreen'
import {
  ago,
  errorText,
  folder,
  listOrder,
  needsYou,
  sessionBadge,
  sessionTitle,
} from '../sessions'
import { useTheme } from '../theme'

type ProjectFilter = { kind: 'all' } | { kind: 'scratch' } | { kind: 'project'; path: string }

interface Search {
  query: string
  state: 'loading' | 'done' | 'error'
  hits: ConversationHit[]
  indexing: SearchIndexing | null
  error: string | null
}

function linkText(state: LinkState): string | null {
  switch (state.kind) {
    case 'connected':
      return null
    case 'connecting':
      return '正在连接电脑…'
    case 'reconnecting':
      return '连接断开，正在重连…'
    case 'stopped':
      return state.reason === 'update_client'
        ? '这个 App 版本太旧，请更新。'
        : state.reason === 'update_host'
          ? '电脑上的 Huli 版本太旧，请先更新电脑端。'
          : '这台手机已被电脑移除。'
  }
}

function matches(filter: ProjectFilter, s: SessionSummary): boolean {
  if (filter.kind === 'all') return true
  if (filter.kind === 'scratch') return s.scratch
  return !s.scratch && s.projectPath === filter.path
}

export default function Home() {
  const theme = useTheme()
  const host = useHost()
  const [refreshing, setRefreshing] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ProjectFilter>({ kind: 'all' })
  const [search, setSearch] = useState<Search | null>(null)
  const actions = useSessionActions('list')

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

  // The projects the listed sessions are in, named as the computer names them.
  const projectChips = useMemo(() => {
    const names = new Map(host.projects.map((p) => [p.path, p.name]))
    const paths = new Map<string, number>()
    let scratch = false
    for (const s of listed) {
      if (s.scratch) scratch = true
      else paths.set(s.projectPath, Math.max(paths.get(s.projectPath) ?? 0, s.updatedAt))
    }
    const chips = [...paths.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([path]) => ({ path, name: names.get(path) ?? folder(path) }))
    return { chips, scratch }
  }, [listed, host.projects])

  const visible = useMemo(() => {
    const words = query.trim().toLowerCase()
    return listed
      .filter((s) => matches(filter, s))
      .filter((s) => !words || sessionTitle(s).toLowerCase().includes(words))
      .sort(listOrder)
  }, [listed, filter, query])

  if (host.phase === 'loading') {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg }]}>
        <ActivityIndicator color={theme.accent} />
      </View>
    )
  }
  if (host.phase === 'pair') {
    return (
      <PairScreen
        notice={host.notice}
        onPaired={(saved, key, paired) => void host.paired(saved, key, paired)}
      />
    )
  }

  const connected = host.state.kind === 'connected'
  const waiting = listed.filter(needsYou).length
  const banner = linkText(host.state)
  const name = host.host?.name ?? '电脑'

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

  const chip = (label: string, on: boolean, onPress: () => void, key: string) => (
    <Pressable
      key={key}
      onPress={onPress}
      style={[
        styles.chip,
        {
          borderColor: on ? theme.accent : theme.line,
          backgroundColor: on ? theme.card : 'transparent',
        },
      ]}
    >
      <Text
        style={{
          color: on ? theme.accent : theme.text,
          fontSize: 13,
          fontWeight: on ? '600' : '400',
        }}
        numberOfLines={1}
      >
        {label}
      </Text>
    </Pressable>
  )

  const showChips = projectChips.chips.length + (projectChips.scratch ? 1 : 0) > 1

  const header = (
    <View>
      <View style={[styles.searchBox, { backgroundColor: theme.card, borderColor: theme.line }]}>
        <Text style={{ color: theme.muted, fontSize: 15 }}>⌕</Text>
        <TextInput
          value={query}
          onChangeText={(text) => {
            setQuery(text)
            if (search && text.trim() !== search.query) setSearch(null)
          }}
          onSubmitEditing={runSearch}
          placeholder="搜索标题，回车搜全文"
          placeholderTextColor={theme.muted}
          returnKeyType="search"
          autoCorrect={false}
          autoCapitalize="none"
          clearButtonMode="while-editing"
          style={[styles.searchInput, { color: theme.text }]}
        />
      </View>
      {showChips && !search && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
        >
          {chip('全部', filter.kind === 'all', () => setFilter({ kind: 'all' }), '__all')}
          {projectChips.chips.map((p) =>
            chip(
              p.name,
              filter.kind === 'project' && filter.path === p.path,
              () => setFilter({ kind: 'project', path: p.path }),
              p.path,
            ),
          )}
          {projectChips.scratch &&
            chip(
              '无项目',
              filter.kind === 'scratch',
              () => setFilter({ kind: 'scratch' }),
              '__scratch',
            )}
        </ScrollView>
      )}
    </View>
  )

  const renderSession = (item: SessionSummary, snippet?: string) => {
    const tag = sessionBadge(item, theme)
    return (
      <Pressable
        onPress={() => router.push(`/session/${item.id}`)}
        onLongPress={() => actions.open(item)}
        delayLongPress={350}
        style={({ pressed }) => [
          styles.row,
          { backgroundColor: theme.card, borderColor: theme.line, opacity: pressed ? 0.7 : 1 },
        ]}
      >
        <View style={styles.rowTop}>
          {item.pinnedAt !== null && (
            <Text style={{ color: theme.accent, fontSize: 12, fontWeight: '700' }}>置顶</Text>
          )}
          <Text style={[styles.title, { color: theme.text }]} numberOfLines={1}>
            {sessionTitle(item)}
          </Text>
          {tag && (
            <View style={[styles.tag, { borderColor: tag.color }]}>
              <Text style={{ color: tag.color, fontSize: 12, fontWeight: '600' }}>{tag.text}</Text>
            </View>
          )}
        </View>
        {snippet ? (
          <Text style={[styles.meta, { color: theme.text }]} numberOfLines={2}>
            {snippet}
          </Text>
        ) : null}
        <Text style={[styles.meta, { color: theme.muted }]} numberOfLines={1}>
          {host.agents.get(item.agentId)?.name ?? item.agentId} ·{' '}
          {item.scratch ? '无项目' : folder(item.projectPath)} · {ago(item.updatedAt)}
          {item.archivedAt !== null ? ' · 已归档' : ''}
        </Text>
        {!snippet && item.plan && item.plan.total > 0 && (
          <Text style={[styles.meta, { color: theme.muted }]} numberOfLines={1}>
            计划 {item.plan.done}/{item.plan.total}
            {item.plan.current ? ` · ${item.plan.current.text}` : ''}
          </Text>
        )}
      </Pressable>
    )
  }

  const archivedLink =
    archivedCount > 0 && !search ? (
      <Pressable
        onPress={() => router.push('/archived')}
        style={({ pressed }) => [styles.archivedLink, { opacity: pressed ? 0.6 : 1 }]}
      >
        <Text style={{ color: theme.muted, fontSize: 14 }}>已归档的会话 · {archivedCount} ›</Text>
      </Pressable>
    ) : undefined

  const emptyList = !connected ? undefined : query.trim() || filter.kind !== 'all' ? (
    <Text style={[styles.empty, { color: theme.muted }]}>
      {query.trim() ? '没有标题匹配的会话。按回车搜索全部对话内容。' : '这个项目里没有会话。'}
    </Text>
  ) : (
    <Text style={[styles.empty, { color: theme.muted }]}>
      电脑上还没有会话。点右上角 ＋ 新建一个。
    </Text>
  )

  const searchEmpty =
    search?.state === 'loading' ? (
      <ActivityIndicator color={theme.accent} style={{ marginTop: 40 }} />
    ) : search?.state === 'error' ? (
      <View style={{ alignItems: 'center', marginTop: 40, gap: 12 }}>
        <Text style={{ color: theme.danger, fontSize: 15 }}>{search.error}</Text>
        <Pressable onPress={runSearch} hitSlop={8}>
          <Text style={{ color: theme.accent, fontSize: 15, fontWeight: '600' }}>重试</Text>
        </Pressable>
      </View>
    ) : (
      <Text style={[styles.empty, { color: theme.muted }]}>没有对话包含「{search?.query}」。</Text>
    )

  const hits = (search?.hits ?? []).flatMap((hit) => {
    const summary = host.sessions.get(hit.sessionId)
    return summary ? [{ hit, summary }] : []
  })

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.hostName, { color: theme.text }]} numberOfLines={1}>
            {name}
          </Text>
          <Text style={{ color: theme.muted, fontSize: 13, marginTop: 2 }}>
            {connected
              ? waiting > 0
                ? `${waiting} 个会话在等你`
                : `${listed.length} 个会话`
              : '未连接'}
          </Text>
        </View>
        <Pressable
          onPress={() => router.push('/usage')}
          disabled={!connected}
          hitSlop={6}
          style={[styles.pill, { borderColor: theme.line, opacity: connected ? 1 : 0.4 }]}
        >
          <Text style={{ color: theme.text, fontSize: 13 }}>用量</Text>
        </Pressable>
        <Pressable
          onPress={() => router.push('/settings')}
          hitSlop={6}
          style={[styles.pill, { borderColor: theme.line }]}
        >
          <Text style={{ color: theme.text, fontSize: 13 }}>设置</Text>
        </Pressable>
        <Pressable
          onPress={() => router.push('/new')}
          disabled={!connected}
          hitSlop={8}
          style={[styles.round, { backgroundColor: theme.accent, opacity: connected ? 1 : 0.4 }]}
        >
          <Text
            style={{ color: theme.accentText, fontSize: 22, lineHeight: 24, fontWeight: '600' }}
          >
            ＋
          </Text>
        </Pressable>
      </View>

      {banner && (
        <View style={[styles.banner, { backgroundColor: theme.card, borderColor: theme.line }]}>
          <Text style={{ color: theme.muted, fontSize: 14 }}>{banner}</Text>
        </View>
      )}
      <UpdateBanner />

      {search ? (
        <FlatList
          data={search.state === 'done' ? hits : []}
          keyExtractor={(row) => row.hit.sessionId}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
          ListHeaderComponent={
            <View>
              {header}
              <View style={styles.searchBar}>
                <Text style={{ color: theme.muted, fontSize: 13, flex: 1 }}>
                  {search.state === 'done'
                    ? `全文搜索：${hits.length} 个会话`
                    : search.state === 'loading'
                      ? '正在搜索…'
                      : '搜索失败'}
                  {search.indexing
                    ? `（索引建立中 ${search.indexing.done}/${search.indexing.total}，结果可能不全）`
                    : ''}
                </Text>
                <Pressable onPress={() => setSearch(null)} hitSlop={8}>
                  <Text style={{ color: theme.accent, fontSize: 13 }}>返回列表</Text>
                </Pressable>
              </View>
            </View>
          }
          ListEmptyComponent={searchEmpty}
          renderItem={({ item }) => renderSession(item.summary, item.hit.snippet)}
        />
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(s) => s.id}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              tintColor={theme.accent}
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
          ListHeaderComponent={header}
          ListEmptyComponent={emptyList}
          ListFooterComponent={archivedLink}
          renderItem={({ item }) => renderSession(item)}
        />
      )}
      {actions.element}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
  },
  hostName: { fontSize: 26, fontWeight: '700' },
  pill: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 11, paddingVertical: 6 },
  round: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  banner: { marginHorizontal: 16, marginBottom: 8, padding: 12, borderRadius: 10, borderWidth: 1 },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    marginTop: 4,
  },
  searchInput: { flex: 1, fontSize: 15, paddingVertical: 9 },
  searchBar: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  chips: { gap: 8, paddingTop: 10 },
  chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 5 },
  row: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14, marginTop: 10 },
  rowTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, fontSize: 16, fontWeight: '600' },
  tag: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  meta: { fontSize: 13, marginTop: 6 },
  empty: { textAlign: 'center', marginTop: 48, fontSize: 15, paddingHorizontal: 24 },
  archivedLink: { alignItems: 'center', paddingVertical: 20 },
})
