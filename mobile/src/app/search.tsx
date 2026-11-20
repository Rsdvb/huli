// Search, from the top bar of every tab and from huli://search?q=: one field over the active
// computer's sessions, the words in their conversations, its projects and its Artifacts. Titles,
// projects and Artifacts filter here as the user types; return asks the computer to search every
// conversation (`sessions.search`), or, while it cannot be reached, the conversations this phone
// has cached.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router, useLocalSearchParams } from 'expo-router'
import { FlashList, type ListRenderItem } from '@shopify/flash-list'
import type { ArtifactSummary } from '@shared/artifacts'
import type { ConversationHit, SearchIndexing, SessionSummary } from '@shared/agent-host'
import { artifactKind, KIND_ICON, KIND_TEXT, openArtifact } from '../artifacts'
import { artifactMenu } from '../components/ArtifactCard'
import { ArtifactSheet, confirmDelete } from '../components/ArtifactSheet'
import { useSessionActions } from '../components/SessionActions'
import { openInPane } from '../components/SessionPane'
import { useShell } from '../components/shell'
import {
  useActiveHost,
  useAgents,
  useConnected,
  useMaybeLink,
  useProjects,
  useSessions,
} from '../host'
import {
  clearSearches,
  forgetSearch,
  isScope,
  longEnough,
  matches,
  rememberSearch,
  SCOPES,
  searchCachedThreads,
  splitMatches,
  useRecentSearches,
  wordsOf,
  type SearchScope,
} from '../search'
import { errorText, folder, listTime, sessionTitle } from '../sessions'
import { computerName } from '../store'
import { AgentAvatar } from '../ui/AgentAvatar'
import { ContextMenu } from '../ui/ContextMenu'
import { offlineMenu } from '../ui/menu'
import { EmptyState } from '../ui/EmptyState'
import { haptic } from '../ui/haptics'
import { useWide } from '../ui/layout'
import { Icon, type IconName } from '../ui/Icon'
import { Press } from '../ui/Press'
import { Screen } from '../ui/Screen'
import { SegmentedControl } from '../ui/SegmentedControl'
import { FONT_SCALE, radius, space, type as typeScale, useTokens } from '../ui/tokens'

/** Results per group under 全部, before 查看全部. */
const PREVIEW = 4

interface ContentSearch {
  query: string
  state: 'loading' | 'done' | 'error'
  hits: { sessionId: string; snippet: string; role: 'user' | 'agent' }[]
  /** Searched on the phone, in this many cached conversations, as the computer was away. */
  local: number | null
  indexing: SearchIndexing | null
  error: string | null
}

interface ProjectResult {
  path: string
  name: string
  count: number
}

type Item =
  | { kind: 'header'; key: string; title: string; count?: number; more?: SearchScope }
  | { kind: 'session'; key: string; session: SessionSummary }
  | {
      kind: 'hit'
      key: string
      sessionId: string
      session: SessionSummary | undefined
      snippet: string
      role: 'user' | 'agent'
    }
  | { kind: 'project'; key: string; project: ProjectResult }
  | { kind: 'artifact'; key: string; artifact: ArtifactSummary }
  | { kind: 'note'; key: string; text: string; tone?: 'error'; action?: () => void; label?: string }
  | { kind: 'loading'; key: string; text: string }
  | { kind: 'recent'; key: string; query: string }

const itemKey = (item: Item) => item.key
const itemType = (item: Item) => item.kind

/** Text with the query's words picked out. */
function Highlighted(props: {
  text: string
  words: string[]
  style: object
  color: string
  numberOfLines?: number
}) {
  const { c } = useTokens()
  const runs = splitMatches(props.text, props.words)
  return (
    <Text style={[props.style, { color: props.color }]} numberOfLines={props.numberOfLines}>
      {runs.map((run, i) =>
        run.hit ? (
          <Text key={i} style={[styles.hit, { color: c.accent, backgroundColor: c.fill }]}>
            {run.text}
          </Text>
        ) : (
          run.text
        ),
      )}
    </Text>
  )
}

export default function Search() {
  const { c } = useTokens()
  const wide = useWide()
  const link = useMaybeLink()
  const allSessions = useSessions()
  const allProjects = useProjects()
  const agents = useAgents()
  const active = useActiveHost()
  const shell = useShell()
  const insets = useSafeAreaInsets()
  const params = useLocalSearchParams<{ q?: string; scope?: string }>()
  const recent = useRecentSearches()
  const [query, setQuery] = useState(params.q ?? '')
  const [scope, setScope] = useState<SearchScope>(isScope(params.scope) ? params.scope : 'all')
  const [content, setContent] = useState<ContentSearch | null>(null)
  const [artifacts, setArtifacts] = useState<ArtifactSummary[] | null>(null)
  const [artifactsError, setArtifactsError] = useState<string | null>(null)
  const [open, setOpen] = useState<ArtifactSummary | null>(null)
  const connected = useConnected()
  const actions = useSessionActions('list')
  const words = useMemo(() => wordsOf(query), [query])
  const computer = active?.id ?? null

  // The Artifacts list is read once the page opens, while the computer is reachable.
  const loadArtifacts = useCallback(() => {
    if (!link || !connected) return
    setArtifactsError(null)
    void (link.request('artifacts.list', {}) as Promise<ArtifactSummary[]>).then(
      (list) => setArtifacts(list.filter((a) => a.deletedAt === null)),
      (failure: unknown) => setArtifactsError(errorText(failure)),
    )
  }, [link, connected])
  useEffect(() => {
    if (artifacts === null) loadArtifacts()
  }, [artifacts, loadArtifacts])

  const runContent = useCallback(
    (text: string) => {
      const asked = text.trim()
      const askedWords = wordsOf(asked)
      if (!longEnough(askedWords)) {
        setContent(null)
        return
      }
      rememberSearch(asked)
      const base: ContentSearch = {
        query: asked,
        state: 'loading',
        hits: [],
        local: null,
        indexing: null,
        error: null,
      }
      setContent(base)
      const settle = (next: Partial<ContentSearch>) =>
        setContent((current) => (current?.query === asked ? { ...base, ...next } : current))
      if (link && connected) {
        void (
          link.request('sessions.search', { query: asked }) as Promise<{
            hits: ConversationHit[]
            indexing?: SearchIndexing | null
          }>
        ).then(
          (answer) =>
            settle({
              state: 'done',
              hits: answer.hits.map((h) => ({
                sessionId: h.sessionId,
                snippet: h.snippet,
                role: h.role,
              })),
              indexing: answer.indexing ?? null,
            }),
          (failure: unknown) => settle({ state: 'error', error: errorText(failure) }),
        )
        return
      }
      if (!computer) return settle({ state: 'done' })
      void searchCachedThreads(computer, askedWords).then(
        (found) => settle({ state: 'done', hits: found.hits, local: found.searched }),
        (failure: unknown) => settle({ state: 'error', error: errorText(failure) }),
      )
    },
    [link, connected, computer],
  )

  // A link's query is searched at once.
  const started = useRef(false)
  useEffect(() => {
    if (started.current || !params.q) return
    started.current = true
    runContent(params.q)
  }, [params.q, runContent])

  const sessions = useMemo(() => {
    if (words.length === 0) return []
    return [...allSessions.values()]
      .filter((s) => s.parentId === null && matches(sessionTitle(s), words))
      .sort(
        (a, b) =>
          Number(a.archivedAt !== null) - Number(b.archivedAt !== null) ||
          b.updatedAt - a.updatedAt,
      )
  }, [allSessions, words])

  // The computer's own names for its projects, where rows would otherwise show a folder's.
  const projectNames = useMemo(
    () => new Map(allProjects.map((p) => [p.path, p.name])),
    [allProjects],
  )
  const projects = useMemo(() => {
    if (words.length === 0) return []
    const counts = new Map<string, number>()
    for (const s of allSessions.values()) {
      if (s.parentId !== null || s.scratch) continue
      counts.set(s.projectPath, (counts.get(s.projectPath) ?? 0) + 1)
    }
    for (const p of allProjects) if (!counts.has(p.path)) counts.set(p.path, 0)
    return [...counts.entries()]
      .map(([path, count]) => ({ path, count, name: projectNames.get(path) ?? folder(path) }))
      .filter((p) => matches(p.name, words) || matches(p.path, words))
      .sort((a, b) => b.count - a.count)
  }, [allSessions, allProjects, projectNames, words])

  const artifactHits = useMemo(
    () =>
      words.length === 0 || !artifacts
        ? []
        : artifacts
            .filter((a) => matches(a.title, words))
            .sort((a, b) => b.updatedAt - a.updatedAt),
    [artifacts, words],
  )

  const contentCurrent = content !== null && content.query === query.trim()

  const items = useMemo<Item[]>(() => {
    const out: Item[] = []
    if (words.length === 0) {
      if (recent.length > 0) {
        out.push({ kind: 'header', key: 'h-recent', title: '最近搜索' })
        for (const q of recent) out.push({ kind: 'recent', key: `r-${q}`, query: q })
      }
      return out
    }
    const all = scope === 'all'
    const group = <T,>(
      key: SearchScope,
      title: string,
      list: T[],
      make: (item: T) => Item,
    ): void => {
      if (list.length === 0) return
      const shown = all ? list.slice(0, PREVIEW) : list
      out.push({
        kind: 'header',
        key: `h-${key}`,
        title,
        count: list.length,
        ...(all && list.length > PREVIEW ? { more: key } : {}),
      })
      for (const item of shown) out.push(make(item))
    }
    if (all || scope === 'sessions') {
      group('sessions', '会话', sessions, (s) => ({
        kind: 'session',
        key: `s-${s.id}`,
        session: s,
      }))
    }
    if (all || scope === 'content') {
      if (!contentCurrent) {
        if (longEnough(words)) {
          if (!all) out.push({ kind: 'header', key: 'h-content', title: '对话内容' })
          out.push({
            kind: 'note',
            key: 'n-content',
            text: connected
              ? '按键盘上的「搜索」，在全部对话内容里找。'
              : '按键盘上的「搜索」，在这台手机缓存的对话里找。',
            label: '搜索对话内容',
            action: () => runContent(query),
          })
        } else if (!all || query.trim()) {
          // The computer searches what was said by two characters or more; say so rather than
          // stay silent after one.
          if (all) out.push({ kind: 'header', key: 'h-content', title: '对话内容' })
          out.push({ kind: 'note', key: 'n-short', text: '至少输入两个字再搜索对话内容。' })
        }
      } else if (content.state === 'loading') {
        out.push({ kind: 'header', key: 'h-content', title: '对话内容' })
        out.push({ kind: 'loading', key: 'l-content', text: '正在搜索对话内容…' })
      } else if (content.state === 'error') {
        out.push({ kind: 'header', key: 'h-content', title: '对话内容' })
        out.push({
          kind: 'note',
          key: 'e-content',
          tone: 'error',
          text: `没能搜索对话内容：${content.error ?? ''}`,
          label: '重试',
          action: () => runContent(query),
        })
      } else {
        const hits = content.hits.map((h) => ({ ...h, session: allSessions.get(h.sessionId) }))
        group('content', '对话内容', hits, (h) => ({
          kind: 'hit',
          key: `c-${h.sessionId}`,
          sessionId: h.sessionId,
          session: h.session,
          snippet: h.snippet,
          role: h.role,
        }))
        if (content.local !== null) {
          out.push({
            kind: 'note',
            key: 'n-local',
            text: `没连上电脑，只搜了这台手机缓存的 ${content.local} 个会话。连上后再搜一次能找全。`,
          })
        } else if (content.indexing) {
          out.push({
            kind: 'note',
            key: 'n-indexing',
            text: `电脑还在建立索引（${content.indexing.done}/${content.indexing.total}），结果可能不全。`,
          })
        }
      }
    }
    if (all || scope === 'projects') {
      group('projects', '项目', projects, (p) => ({
        kind: 'project',
        key: `p-${p.path}`,
        project: p,
      }))
    }
    if (all || scope === 'artifacts') {
      if (artifacts === null && (scope === 'artifacts' || artifactsError)) {
        if (artifactsError) {
          out.push({ kind: 'header', key: 'h-artifacts', title: '产物' })
          out.push({
            kind: 'note',
            key: 'e-artifacts',
            tone: 'error',
            text: `没能读取产物：${artifactsError}`,
            label: '重试',
            action: loadArtifacts,
          })
        } else if (!connected) {
          out.push({ kind: 'note', key: 'n-artifacts', text: '连上电脑后才能搜索产物。' })
        } else {
          out.push({ kind: 'loading', key: 'l-artifacts', text: '正在读取产物…' })
        }
      }
      group('artifacts', 'Artifacts', artifactHits, (a) => ({
        kind: 'artifact',
        key: `a-${a.id}`,
        artifact: a,
      }))
    }
    return out
  }, [
    words,
    recent,
    scope,
    sessions,
    contentCurrent,
    content,
    query,
    connected,
    allSessions,
    projects,
    artifacts,
    artifactsError,
    artifactHits,
    runContent,
    loadArtifacts,
  ])

  const sessionMenu = (s: SessionSummary) => (connected ? actions.menu(s) : offlineMenu())

  const openSession = (id: string) => {
    haptic.tap()
    rememberSearch(query)
    // On a wide window the session opens in the 会话 tab's pane, beside its list, not over both.
    if (wide && openInPane(id)) {
      if (router.canDismiss()) router.dismissAll()
      router.navigate('/')
      return
    }
    router.push({ pathname: '/session/[id]', params: { id } })
  }

  const renderItem: ListRenderItem<Item> = ({ item }) => {
    switch (item.kind) {
      case 'header':
        return (
          <View style={styles.header}>
            <Text
              style={[typeScale.subhead, styles.flex, { color: c.textSecondary }]}
              maxFontSizeMultiplier={FONT_SCALE.dense}
              accessibilityRole="header"
            >
              {item.title}
              {item.count !== undefined ? `  ${item.count}` : ''}
            </Text>
            {item.more ? (
              <Press onPress={() => setScope(item.more!)} hitSlop={8} accessibilityRole="button">
                <Text
                  style={[typeScale.subhead, { color: c.tint }]}
                  maxFontSizeMultiplier={FONT_SCALE.dense}
                >
                  查看全部
                </Text>
              </Press>
            ) : null}
            {item.key === 'h-recent' ? (
              <Press
                onPress={() => {
                  haptic.tap()
                  clearSearches()
                }}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="清除最近搜索"
              >
                <Text
                  style={[typeScale.subhead, { color: c.tint }]}
                  maxFontSizeMultiplier={FONT_SCALE.dense}
                >
                  清除
                </Text>
              </Press>
            ) : null}
          </View>
        )
      case 'session': {
        const s = item.session
        const place = s.scratch
          ? '无项目'
          : (projectNames.get(s.projectPath) ?? folder(s.projectPath))
        return (
          <ContextMenu items={sessionMenu(s)} title={sessionTitle(s)}>
            {(longPress) => (
              <Press
                onPress={() => openSession(s.id)}
                {...(longPress ? { onLongPress: longPress, delayLongPress: 350 } : {})}
                scale={false}
                style={[styles.row, { backgroundColor: c.bg }]}
              >
                <AgentAvatar agentId={s.agentId} name={agents.get(s.agentId)?.name} size={34} />
                <View style={styles.flex}>
                  <Highlighted
                    text={sessionTitle(s)}
                    words={words}
                    style={typeScale.rowTitle}
                    color={c.text}
                    numberOfLines={2}
                  />
                  <Text style={[typeScale.footnote, { color: c.textTertiary }]} numberOfLines={1}>
                    {place} · {listTime(s.updatedAt)}
                    {s.archivedAt !== null ? ' · 已归档' : ''}
                  </Text>
                </View>
              </Press>
            )}
          </ContextMenu>
        )
      }
      case 'hit':
        return (
          <ContextMenu
            items={item.session ? sessionMenu(item.session) : []}
            {...(item.session ? { title: sessionTitle(item.session) } : {})}
          >
            {(longPress) => (
              <Press
                onPress={() => openSession(item.sessionId)}
                {...(longPress ? { onLongPress: longPress, delayLongPress: 350 } : {})}
                scale={false}
                style={[styles.row, { backgroundColor: c.bg }]}
              >
                <View style={[styles.glyph, { backgroundColor: c.fill }]}>
                  <Icon name="message" size={17} color={c.textSecondary} />
                </View>
                <View style={styles.flex}>
                  <Text style={[typeScale.rowTitle, { color: c.text }]} numberOfLines={1}>
                    {item.session ? sessionTitle(item.session) : '会话'}
                  </Text>
                  <Highlighted
                    text={`${item.role === 'user' ? '你：' : ''}${item.snippet}`}
                    words={words}
                    style={typeScale.footnote}
                    color={c.textSecondary}
                    numberOfLines={3}
                  />
                </View>
              </Press>
            )}
          </ContextMenu>
        )
      case 'project':
        return (
          <Press
            onPress={() => {
              haptic.tap()
              rememberSearch(query)
              shell.setFilter({ kind: 'project', path: item.project.path })
              if (router.canDismiss()) router.dismissAll()
              router.navigate('/')
            }}
            scale={false}
            style={styles.row}
            accessibilityHint="只看这个项目的会话"
          >
            <View style={[styles.glyph, { backgroundColor: c.fill }]}>
              <Icon name="folder" size={17} color={c.textSecondary} />
            </View>
            <View style={styles.flex}>
              <Highlighted
                text={item.project.name}
                words={words}
                style={typeScale.rowTitle}
                color={c.text}
                numberOfLines={1}
              />
              <Highlighted
                text={item.project.path}
                words={words}
                style={typeScale.footnote}
                color={c.textTertiary}
                numberOfLines={1}
              />
            </View>
            <Text style={[typeScale.footnote, { color: c.textTertiary }]}>
              {item.project.count} 个会话
            </Text>
          </Press>
        )
      case 'artifact': {
        const a = item.artifact
        const kind = artifactKind(a)
        const menu = artifactMenu(a, {
          details: () => setOpen(a),
          session: allSessions.has(a.sessionId),
          remove:
            connected && link
              ? () => confirmDelete((m, p) => link.request(m, p), a, loadArtifacts)
              : null,
        })
        return (
          <ContextMenu items={menu} title={a.title || '未命名'}>
            {(longPress) => (
              <Press
                onPress={() => {
                  haptic.tap()
                  rememberSearch(query)
                  openArtifact(a.id)
                }}
                {...(longPress ? { onLongPress: longPress, delayLongPress: 350 } : {})}
                scale={false}
                style={[styles.row, { backgroundColor: c.bg }]}
              >
                <View style={[styles.glyph, { backgroundColor: c.fill }]}>
                  <Icon name={KIND_ICON[kind] as IconName} size={17} color={c.textSecondary} />
                </View>
                <View style={styles.flex}>
                  <Highlighted
                    text={a.title}
                    words={words}
                    style={typeScale.rowTitle}
                    color={c.text}
                    numberOfLines={2}
                  />
                  <Text style={[typeScale.footnote, { color: c.textTertiary }]} numberOfLines={1}>
                    {KIND_TEXT[kind]} ·{' '}
                    {a.scratch ? '无项目' : (projectNames.get(a.project) ?? folder(a.project))} ·{' '}
                    {listTime(a.updatedAt)}
                  </Text>
                </View>
              </Press>
            )}
          </ContextMenu>
        )
      }
      case 'note':
        return (
          <View style={styles.note}>
            <Text
              style={[
                typeScale.footnote,
                styles.flex,
                { color: item.tone === 'error' ? c.danger : c.textSecondary },
              ]}
            >
              {item.text}
            </Text>
            {item.action ? (
              <Press onPress={item.action} hitSlop={8} accessibilityRole="button">
                <Text style={[typeScale.footnote, { color: c.tint, fontWeight: '600' }]}>
                  {item.label}
                </Text>
              </Press>
            ) : null}
          </View>
        )
      case 'loading':
        return (
          <View style={styles.note}>
            <ActivityIndicator size="small" color={c.textSecondary} />
            <Text style={[typeScale.footnote, styles.flex, { color: c.textSecondary }]}>
              {item.text}
            </Text>
          </View>
        )
      case 'recent':
        return (
          <Press
            onPress={() => {
              haptic.tap()
              setQuery(item.query)
              runContent(item.query)
            }}
            scale={false}
            style={styles.row}
          >
            <Icon name="clock" size={17} color={c.textTertiary} />
            <Text style={[typeScale.body, styles.flex, { color: c.text }]} numberOfLines={1}>
              {item.query}
            </Text>
            <Press
              onPress={() => forgetSearch(item.query)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={`删除「${item.query}」`}
            >
              <Icon name="close" size={13} color={c.textTertiary} weight="semibold" />
            </Press>
          </Press>
        )
    }
  }

  const empty = () => {
    if (words.length === 0) {
      return (
        <EmptyState
          icon="search"
          title="搜索会话、对话内容、项目和产物"
          message={`在「${computerName(active)}」上找。按键盘上的「搜索」，也会搜全部对话内容。`}
        />
      )
    }
    return (
      <EmptyState
        icon="search"
        title={`没有找到「${query.trim()}」`}
        message={
          scope === 'all' || scope === 'content'
            ? '换几个词试试；对话内容要按「搜索」才会找。'
            : '换几个词，或者在「全部」里找。'
        }
        {...(scope !== 'all'
          ? { action: { label: '在全部里找', onPress: () => setScope('all') } }
          : {})}
      />
    )
  }

  return (
    <Screen edges={['top']} readable>
      <View style={styles.top}>
        <View style={[styles.box, { backgroundColor: c.fill }]}>
          <Icon name="search" size={17} color={c.textSecondary} />
          <TextInput
            autoFocus
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={() => {
              haptic.tap()
              runContent(query)
            }}
            placeholder="搜索会话、内容、项目、产物"
            placeholderTextColor={c.textTertiary}
            returnKeyType="search"
            enablesReturnKeyAutomatically
            autoCorrect={false}
            autoCapitalize="none"
            clearButtonMode="while-editing"
            accessibilityLabel="搜索"
            style={[typeScale.body, styles.input, { color: c.text }]}
          />
        </View>
        <Press
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          accessibilityRole="button"
          hitSlop={8}
        >
          <Text style={[typeScale.body, { color: c.tint }]}>取消</Text>
        </Press>
      </View>
      <View style={styles.scopes}>
        <SegmentedControl<SearchScope>
          segments={SCOPES}
          value={scope}
          onChange={(next) => setScope(next)}
        />
      </View>
      {!connected && words.length > 0 ? (
        <Text style={[typeScale.footnote, styles.offline, { color: c.textTertiary }]}>
          没连上电脑：会话和项目来自上次同步的列表。
        </Text>
      ) : null}
      <FlashList
        data={items}
        keyExtractor={itemKey}
        getItemType={itemType}
        renderItem={renderItem}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: insets.bottom + space.xxl }}
        ListEmptyComponent={empty()}
      />
      <ArtifactSheet artifact={open} onClose={() => setOpen(null)} />
      {actions.element}
    </Screen>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
  },
  box: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    minHeight: 44,
  },
  input: { flex: 1, paddingVertical: space.sm },
  scopes: { paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.xs },
  offline: { paddingHorizontal: space.xl, paddingTop: space.xs },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.xl,
    paddingTop: space.lg,
    paddingBottom: space.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.xl,
    paddingVertical: space.sm + 2,
    minHeight: 52,
  },
  glyph: {
    width: 34,
    height: 34,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.xl,
    paddingVertical: space.sm,
  },
  hit: { fontWeight: '700' },
})
