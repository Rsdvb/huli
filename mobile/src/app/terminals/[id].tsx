// A session's terminals on the computer, while its owner lets devices use them: each with what
// runs in it and the end of its output as its screen shows it, read again on a pull.

import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import type { TerminalInfo } from '@shared/terminal-host'
import { errorText } from '../../git'
import { useHostState, useLink, useSession } from '../../host'
import { sessionTitle } from '../../sessions'
import { sessionTerminals, terminalTail, useTerminalAllowed } from '../../terminals'
import { copyText } from '../../ui/session/feedback'
import { GlassHeader } from '../../ui/session/GlassHeader'
import { G, Icon } from '../../ui/session/icons'
import { MONO, useSessionTokens } from '../../ui/session/palette'
import { PressScale } from '../../ui/session/Press'
import { StateView } from '../../ui/session/StateView'

interface Shown {
  info: TerminalInfo
  tail: string | null
  error: string | null
}

export default function TerminalsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { c } = useSessionTokens()
  const state = useHostState()
  const link = useLink()
  const allowed = useTerminalAllowed(link, state)
  const summary = useSession(id)
  // The summary changes with every turn the session streams; the terminals only with its folder.
  const projectPath = summary?.projectPath
  const [list, setList] = useState<Shown[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    if (projectPath === undefined || !allowed) return
    setError(null)
    try {
      const found = await sessionTerminals(link, projectPath, id)
      // A terminal read before keeps its output until the new one comes, rather than a spinner.
      setList((was) =>
        found.map((info) => ({
          info,
          tail: was?.find((t) => t.info.id === info.id)?.tail ?? null,
          error: null,
        })),
      )
      await Promise.all(
        found.map(async (info) => {
          let next: Partial<Shown>
          try {
            next = { tail: await terminalTail(link, info.id) }
          } catch (failed) {
            next = { error: errorText(failed, '没能读取输出。') }
          }
          setList((was) => was?.map((t) => (t.info.id === info.id ? { ...t, ...next } : t)) ?? was)
        }),
      )
    } catch (failed) {
      setError(errorText(failed, '没能读取终端。'))
    }
  }, [link, projectPath, allowed, id])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = () => {
    setRefreshing(true)
    void load().finally(() => setRefreshing(false))
  }

  let body: ReactElement
  if (!allowed) {
    body = (
      <StateView
        text="电脑没有允许手机使用终端。可以在电脑上的 设置 › 远程访问 里打开。"
        icon={G.terminal}
      />
    )
  } else if (!list) {
    body = error ? (
      <StateView text={error} tone="danger" retry={() => void load()} />
    ) : (
      <StateView loading />
    )
  } else if (list.length === 0) {
    body = <StateView text="这个会话没有终端。" icon={G.terminal} />
  } else {
    body = (
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32, gap: 14 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.textSecondary} />
        }
      >
        {list.map((t) => (
          <TerminalCard key={t.info.id} shown={t} />
        ))}
      </ScrollView>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ headerShown: false }} />
      <GlassHeader title="终端" subtitle={sessionTitle(summary)} />
      {body}
    </View>
  )
}

function TerminalCard(props: { shown: Shown }) {
  const { c, s } = useSessionTokens()
  const { info, tail, error } = props.shown
  const state =
    info.exitCode !== null
      ? { text: `已退出（${info.exitCode}）`, color: c.textTertiary }
      : info.waiting === 'password'
        ? { text: '等待输入密码', color: c.warning }
        : info.busy
          ? { text: '运行中', color: c.success }
          : { text: '空闲', color: c.textSecondary }
  return (
    <View style={[styles.card, { backgroundColor: s.code, borderColor: s.codeBorder }]}>
      <View style={styles.head}>
        <Icon icon={G.terminal} size={15} color={c.textSecondary} />
        <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>
          {info.title || info.shell}
        </Text>
        <Text style={[styles.state, { color: state.color }]}>{state.text}</Text>
        {tail ? (
          <PressScale
            onPress={() => void copyText(tail)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="复制输出"
          >
            <Icon icon={G.copy} size={15} color={c.textSecondary} />
          </PressScale>
        ) : null}
      </View>
      {tail === null && !error ? (
        <ActivityIndicator size="small" color={c.textTertiary} style={{ paddingVertical: 12 }} />
      ) : error ? (
        <Text style={[styles.note, { color: c.danger }]}>{error}</Text>
      ) : tail ? (
        <ScrollView horizontal bounces={false}>
          <Text selectable style={[styles.output, { color: c.text }]}>
            {tail}
          </Text>
        </ScrollView>
      ) : (
        <Text style={[styles.note, { color: c.textTertiary }]}>还没有输出</Text>
      )}
      {info.owner && (
        <Text style={[styles.note, { color: c.textTertiary }]}>
          {info.owner.fromReply ? '运行回复里的命令' : 'Agent 打开的终端'}
          {info.control.kind !== 'idle' ? ' · 这一轮正在使用' : ''}
        </Text>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, fontSize: 14, fontWeight: '600', fontFamily: MONO },
  state: { fontSize: 12, fontWeight: '500' },
  output: { fontFamily: MONO, fontSize: 11.5, lineHeight: 16 },
  note: { fontSize: 12, lineHeight: 16 },
})
