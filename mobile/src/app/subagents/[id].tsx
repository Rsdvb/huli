// A session's sub-sessions: those its agent started and those started from it, running first,
// each with how it is doing, what it was for, the start of its last reply and how long it took.
// The + starts a new sub-session of the same agent in the same folder. A long list, such as a
// session's many sub-agents that its row's badge opens here, gets a search field.

import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, SectionList, StyleSheet, Text, TextInput, View } from 'react-native'
import { Stack, router, useLocalSearchParams } from 'expo-router'
import type { SessionOutputs, SessionSummary } from '@shared/agent-host'
import { call } from '../../git'
import { useAgents, useLink, useSessions } from '../../host'
import { errorText, sessionTitle } from '../../sessions'
import { AgentAvatar } from '../../ui/AgentAvatar'
import { haptic, plainText } from '../../ui/session/feedback'
import { spanText } from '../../ui/session/format'
import { useSecond } from '../../ui/session/now'
import { GlassHeader } from '../../ui/session/GlassHeader'
import { G, Icon } from '../../ui/session/icons'
import { useSessionTokens } from '../../ui/session/palette'
import { PressScale, RoundButton } from '../../ui/session/Press'
import { StateView } from '../../ui/session/StateView'

const running = (s: SessionSummary) =>
  s.status === 'running' || s.status === 'starting' || s.status === 'awaiting_permission'

// Read the replies of this many at most, newest first, so a long list does not flood the link.
const READ_REPLIES = 30
// More sub-sessions than this get a search field.
const SEARCH_FROM = 12

export default function SubagentsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { c } = useSessionTokens()
  // The sessions and agents alone, not every change of the link and the lists.
  const sessions = useSessions()
  const agents = useAgents()
  const link = useLink()
  const parent = sessions.get(id)
  const [outputs, setOutputs] = useState<Record<string, SessionOutputs>>({})
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')

  const children = useMemo(
    () =>
      [...sessions.values()]
        .filter((s) => s.parentId === id)
        .sort((a, b) => b.createdAt - a.createdAt),
    [sessions, id],
  )
  const searchable = children.length > SEARCH_FROM
  const words = searchable ? query.trim().toLowerCase() : ''
  const shown = words
    ? children.filter((s) =>
        [sessionTitle(s), s.description ?? ''].some((text) => text.toLowerCase().includes(words)),
      )
    : children
  const live = shown.filter(running)
  const done = shown.filter((s) => !running(s))

  // Each child's reply is read once it has ended a turn, and again when it ends another.
  const stamps = children
    .slice(0, READ_REPLIES)
    .map((s) => `${s.id}:${s.updatedAt}`)
    .join(',')
  // Only a child that changed since its last read is read again, not every child each time one does.
  const readAt = useRef(new Map<string, number>())
  const latestChildren = useRef(children)
  latestChildren.current = children
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    [],
  )
  useEffect(() => {
    for (const child of latestChildren.current.slice(0, READ_REPLIES)) {
      if (readAt.current.get(child.id) === child.updatedAt) continue
      readAt.current.set(child.id, child.updatedAt)
      call(link, 'sessions.outputs', { sessionId: child.id }).then(
        (out) => mounted.current && setOutputs((was) => ({ ...was, [child.id]: out })),
        // Read again at its next change, or when the page opens again.
        () => readAt.current.delete(child.id),
      )
    }
    // Keyed by the children's stamps, not by each render's new array.
  }, [link, stamps])

  const create = () => {
    if (!parent || creating) return
    setCreating(true)
    call(link, 'sessions.create', {
      agentId: parent.agentId,
      projectPath: parent.scratch ? null : parent.projectPath,
      parentId: id,
    })
      .then((made) => {
        haptic.success()
        router.push(`/session/${made.id}`)
      })
      .catch((error: unknown) => Alert.alert('没能新建子会话', errorText(error)))
      .finally(() => setCreating(false))
  }

  const sections = [
    ...(live.length > 0 ? [{ title: '正在运行', data: live }] : []),
    ...(done.length > 0 ? [{ title: '完成', data: done }] : []),
  ]

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ headerShown: false }} />
      <GlassHeader
        title="子会话"
        subtitle={sessionTitle(parent)}
        right={
          <RoundButton
            tone="glass"
            size={44}
            onPress={create}
            disabled={!parent || creating}
            accessibilityLabel="新建子会话"
          >
            <Icon icon={G.plus} size={19} color={c.text} weight="medium" />
          </RoundButton>
        }
      />
      {!parent && sessions.size === 0 ? (
        <StateView loading />
      ) : children.length === 0 ? (
        <StateView text="还没有子会话。点右上角的 + 从这里开一个。" icon={G.child} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(s) => s.id}
          stickySectionHeadersEnabled={false}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 32 }}
          {...(searchable
            ? {
                ListHeaderComponent: (
                  <TextInput
                    value={query}
                    onChangeText={setQuery}
                    placeholder={`搜索 ${children.length} 个子会话`}
                    placeholderTextColor={c.textTertiary}
                    clearButtonMode="while-editing"
                    autoCorrect={false}
                    returnKeyType="search"
                    style={[styles.search, { color: c.text, backgroundColor: c.fill }]}
                  />
                ),
              }
            : {})}
          {...(words
            ? {
                ListEmptyComponent: (
                  <Text style={[styles.none, { color: c.textSecondary }]}>没有符合的子会话</Text>
                ),
              }
            : {})}
          renderSectionHeader={({ section }) => (
            <Text style={[styles.section, { color: c.textSecondary }]}>
              {section.title}
              <Text style={{ color: c.textTertiary }}> {section.data.length}</Text>
            </Text>
          )}
          renderItem={({ item }) => (
            <ChildRow
              child={item}
              outputs={outputs[item.id]}
              agentName={agents.get(item.agentId)?.name}
            />
          )}
        />
      )}
    </View>
  )
}

function ChildRow(props: {
  child: SessionSummary
  outputs: SessionOutputs | undefined
  agentName: string | undefined
}) {
  const { c } = useSessionTokens()
  const { child, outputs } = props
  const isRunning = running(child)
  const now = useSecond(isRunning)
  const failed = child.status === 'failed' || child.attention === 'error'
  const waiting = child.status === 'awaiting_permission' || child.permissionCount > 0
  const since = child.turnStartedAt ?? outputs?.turnStartedAt ?? null
  const length = isRunning
    ? since !== null
      ? now - since
      : now - child.createdAt
    : (outputs?.turnMs ?? null)
  const reply = outputs?.reply ? plainText(outputs.reply).replace(/\s+/g, ' ') : null
  const state = waiting
    ? { text: '等你处理', color: c.warning }
    : isRunning
      ? { text: '正在运行', color: c.text }
      : failed
        ? { text: '出错', color: c.danger }
        : { text: '完成', color: c.text }
  const kind = child.origin === 'subagent' ? '子 Agent' : (props.agentName ?? '子会话')
  return (
    <PressScale
      scale={0.98}
      onPress={() => router.push(`/session/${child.id}`)}
      accessibilityRole="button"
      accessibilityLabel={`${sessionTitle(child)}，${state.text}`}
      style={styles.row}
    >
      <AgentAvatar agentId={child.agentId} size={34} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <View style={styles.titleRow}>
          <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>
            {sessionTitle(child)}
          </Text>
          {length !== null && length > 0 ? (
            <Text style={[styles.time, { color: c.textSecondary }]}>{spanText(length)}</Text>
          ) : null}
        </View>
        <Text style={[styles.meta, { color: c.textSecondary }]} numberOfLines={1}>
          {isRunning ? (
            <Text style={{ color: c.accent }}>⁘ </Text>
          ) : failed ? null : (
            <Text style={{ color: c.success }}>✓ </Text>
          )}
          <Text style={{ color: state.color }}>{state.text}</Text>
          {'  '}
          {[kind, child.description].filter(Boolean).join(' · ')}
        </Text>
        {reply ? (
          <Text style={[styles.reply, { color: c.textSecondary }]} numberOfLines={2}>
            {reply}
          </Text>
        ) : null}
      </View>
    </PressScale>
  )
}

const styles = StyleSheet.create({
  section: { fontSize: 15, fontWeight: '500', paddingTop: 18, paddingBottom: 6 },
  search: { height: 38, borderRadius: 10, paddingHorizontal: 12, fontSize: 16, marginTop: 8 },
  none: { fontSize: 15, paddingTop: 24, textAlign: 'center' },
  row: { flexDirection: 'row', gap: 12, paddingVertical: 10 },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  title: { flex: 1, fontSize: 16, lineHeight: 21, fontWeight: '600' },
  time: { fontSize: 13, fontVariant: ['tabular-nums'] },
  meta: { fontSize: 13.5, lineHeight: 19 },
  reply: { fontSize: 13.5, lineHeight: 19 },
})
