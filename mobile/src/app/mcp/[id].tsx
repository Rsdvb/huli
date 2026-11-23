// Huli: MCP 服务器, a session's MCP servers as the desktop's panel lists them: each one's state,
// error, where it comes from and its tools, with Reconnect. Read when the page opens, on a pull,
// after Reconnect and when the computer says the servers changed; never on a timer. Turning a
// server off and signing in stay on the computer.

import { memo, useCallback, useEffect, useState, type ReactElement } from 'react'
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import type { HostEvent } from '@shared/agent-host'
import type {
  SessionMcpApp,
  SessionMcpServer,
  SessionMcpSource,
  SessionMcpState,
  SessionMcpView,
} from '@shared/session-mcp'
import { agentLabel } from '../../agentName'
import { call, errorText } from '../../git'
import { useAgent, useHostState, useLink, useSession } from '../../host'
import { sessionTitle } from '../../sessions'
import { GlassHeader } from '../../ui/session/GlassHeader'
import { G, Icon } from '../../ui/session/icons'
import { MONO, useSessionTokens } from '../../ui/session/palette'
import { StateView } from '../../ui/session/StateView'

const STATE_TEXT: Record<SessionMcpState, string> = {
  connected: '已连接',
  pending: '连接中',
  failed: '失败',
  'needs-auth': '需要登录',
  disabled: '已关闭',
  unknown: '状态未知',
}

const SOURCE_TEXT: Record<SessionMcpSource, string> = {
  kite: '纸鸢',
  user: '用户',
  project: '项目',
  local: '项目（仅你）',
  plugin: '插件',
  managed: '组织管理',
  cloud: '账号',
  other: '其他',
}

/** How long the page waits for a burst of changes, as servers start one after another. */
const CHANGE_SETTLE_MS = 250

export default function McpScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { c } = useSessionTokens()
  const link = useLink()
  const state = useHostState()
  const summary = useSession(id)
  const agentStatus = useAgent(summary?.agentId)
  const agent = agentLabel(summary?.agentId ?? '', agentStatus?.name)
  const [data, setData] = useState<SessionMcpView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [acting, setActing] = useState<string | null>(null)
  const connected = state.kind === 'connected'

  const load = useCallback(async () => {
    try {
      setData(await call(link, 'sessions.mcp', { sessionId: id }))
      setError(null)
    } catch (failed) {
      setError(errorText(failed, '没能读取这个会话的 MCP 服务器。'))
    }
  }, [link, id])

  useEffect(() => {
    if (connected) void load()
  }, [connected, load])

  // The computer says the session's servers changed, as each one starts or a sign-in ends.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const off = link.onHostEvent((raw) => {
      const event = raw as HostEvent
      if (event.type !== 'session.mcpChanged' || event.sessionId !== id) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void load(), CHANGE_SETTLE_MS)
    })
    return () => {
      off()
      if (timer) clearTimeout(timer)
    }
  }, [link, id, load])

  const refresh = () => {
    setRefreshing(true)
    void load().finally(() => setRefreshing(false))
  }

  const reconnect = useCallback(
    (server: string | null) => {
      setActing(server ?? '')
      call(link, 'sessions.mcpAct', { sessionId: id, action: 'reconnect', server })
        .then((view) => setData(view))
        .catch((failed: unknown) => {
          const title = server ? `没能重新连接 ${server}` : '没能重新连接'
          Alert.alert(title, errorText(failed, title))
          void load()
        })
        .finally(() => setActing(null))
    },
    [link, id, load],
  )

  let body: ReactElement
  if (!data) {
    body = error ? (
      <StateView text={error} tone="danger" retry={() => void load()} />
    ) : connected ? (
      <StateView loading />
    ) : (
      <StateView text="连上电脑后才能看到这个会话的 MCP 服务器。" icon={G.wifiOff} />
    )
  } else {
    const perServer = data.can.reconnect === 'server'
    body = (
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.textSecondary} />
        }
      >
        {[error, data.error].filter(Boolean).map((note) => (
          <Text key={note} style={[styles.note, { color: c.danger }]}>
            {note}
          </Text>
        ))}
        {!data.running ? (
          <View style={[styles.notice, { backgroundColor: c.fill }]}>
            <Text style={[styles.noticeText, { color: c.textSecondary }]}>
              {`${agent} 现在没有为这个会话运行，它的 MCP 服务器会在下一条消息时启动。`}
            </Text>
          </View>
        ) : !data.reported ? (
          <Text style={[styles.note, { color: c.textSecondary }]}>
            {`${agent} 不报告 MCP 服务器的状态，下面是纸鸢交给它的服务器。`}
          </Text>
        ) : null}
        {data.servers.length === 0 ? (
          <Text style={[styles.empty, { color: c.textSecondary }]}>
            {data.running
              ? `${agent} 在这个会话里没有 MCP 服务器。`
              : 'Agent 启动后才能看到服务器。'}
          </Text>
        ) : null}
        {data.servers.map((server) => (
          <ServerRow
            key={server.name}
            server={server}
            canReconnect={perServer && server.state !== 'disabled'}
            busy={acting === server.name}
            disabled={acting !== null}
            onReconnect={reconnect}
          />
        ))}
        {data.can.reconnect === 'all' && data.servers.length > 0 ? (
          <Pressable
            onPress={() => reconnect(null)}
            disabled={acting !== null}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.wide,
              { backgroundColor: c.fill, opacity: pressed || acting !== null ? 0.6 : 1 },
            ]}
          >
            <Text style={[styles.wideText, { color: c.text }]}>
              {acting === '' ? '正在重新连接…' : '全部重新连接'}
            </Text>
          </Pressable>
        ) : null}
        {data.apps ? <Apps apps={data.apps} /> : null}
        <Text style={[styles.footnote, { color: c.textTertiary }]}>
          打开这页、下拉和服务器有变化时读取。关闭服务器和登录请在电脑上操作。
        </Text>
      </ScrollView>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ headerShown: false }} />
      <GlassHeader title="MCP 服务器" subtitle={summary ? sessionTitle(summary) : null} />
      {body}
    </View>
  )
}

const ServerRow = memo(function ServerRow(props: {
  server: SessionMcpServer
  canReconnect: boolean
  busy: boolean
  disabled: boolean
  onReconnect(server: string): void
}) {
  const { c, s } = useSessionTokens()
  const { server } = props
  const [open, setOpen] = useState(false)
  const tools = server.tools
  const tone =
    server.state === 'connected'
      ? { color: c.success, background: s.successSoft }
      : server.state === 'failed'
        ? { color: c.danger, background: s.dangerSoft }
        : server.state === 'needs-auth'
          ? { color: c.warning, background: s.warningSoft }
          : { color: c.textSecondary, background: c.fill }
  const source =
    server.source === 'plugin' && server.plugin
      ? `插件 ${server.plugin}`
      : SOURCE_TEXT[server.source]
  return (
    <View style={[styles.row, { backgroundColor: s.code, borderColor: s.codeBorder }]}>
      <View style={styles.head}>
        <View style={[styles.dot, { backgroundColor: tone.color }]} />
        <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>
          {server.name}
        </Text>
        <Text style={[styles.tag, { color: c.textSecondary, backgroundColor: c.fill }]}>
          {source}
        </Text>
      </View>
      <View style={styles.actions}>
        <Text style={[styles.state, { color: tone.color, backgroundColor: tone.background }]}>
          {STATE_TEXT[server.state]}
        </Text>
        {tools !== null ? (
          <Pressable
            onPress={() => setOpen(!open)}
            disabled={tools.length === 0}
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            style={styles.link}
          >
            <Text
              style={[styles.linkText, { color: tools.length > 0 ? c.accent : c.textTertiary }]}
            >
              {tools.length === 0
                ? '没有工具'
                : open
                  ? `收起 ${tools.length} 个工具`
                  : `${tools.length} 个工具`}
            </Text>
          </Pressable>
        ) : null}
        <View style={{ flex: 1 }} />
        {props.canReconnect ? (
          <Pressable
            onPress={() => props.onReconnect(server.name)}
            disabled={props.disabled}
            accessibilityRole="button"
            style={({ pressed }) => [
              styles.button,
              { backgroundColor: s.accentSoft, opacity: pressed || props.disabled ? 0.6 : 1 },
            ]}
          >
            <Text style={[styles.buttonText, { color: c.accent }]}>
              {props.busy ? '连接中…' : '重新连接'}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {server.error ? (
        <Text selectable style={[styles.meta, { color: c.danger }]}>
          {server.error}
        </Text>
      ) : null}
      {server.state === 'needs-auth' ? (
        <Text style={[styles.meta, { color: c.textTertiary }]}>请在电脑上登录这个服务器。</Text>
      ) : null}
      {open && tools && tools.length > 0 ? (
        <View style={styles.tools}>
          {tools.map((tool) => (
            <Text
              key={tool}
              style={[styles.tool, { color: c.textSecondary, backgroundColor: c.fill }]}
            >
              {tool}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  )
})

function Apps(props: { apps: SessionMcpApp[] }) {
  const { c, s } = useSessionTokens()
  return (
    <View style={styles.apps}>
      <Text style={[styles.label, { color: c.textTertiary }]}>ChatGPT 应用</Text>
      {props.apps.length === 0 ? (
        <Text style={[styles.meta, { color: c.textSecondary }]}>
          这个 ChatGPT 账号还没有连接应用。
        </Text>
      ) : (
        props.apps.map((app) => (
          <View
            key={app.id}
            style={[styles.row, { backgroundColor: s.code, borderColor: s.codeBorder }]}
          >
            <View style={styles.head}>
              <Icon icon={G.plug} size={15} color={c.textSecondary} />
              <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>
                {app.name}
              </Text>
              {!app.enabled ? (
                <Text style={[styles.tag, { color: c.textSecondary, backgroundColor: c.fill }]}>
                  Codex 里已关闭
                </Text>
              ) : null}
            </View>
            {app.description ? (
              <Text style={[styles.meta, { color: c.textSecondary }]} numberOfLines={2}>
                {app.description}
              </Text>
            ) : null}
          </View>
        ))
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingBottom: 32, gap: 10 },
  label: { fontSize: 13, fontWeight: '600', paddingTop: 8 },
  note: { fontSize: 13, lineHeight: 18 },
  notice: { borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  noticeText: { fontSize: 13, lineHeight: 18 },
  row: {
    gap: 6,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  name: { flexShrink: 1, fontFamily: MONO, fontSize: 14.5, fontWeight: '500' },
  tag: {
    fontSize: 12,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 6,
    overflow: 'hidden',
  },
  state: {
    fontSize: 12.5,
    fontWeight: '600',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 7,
    overflow: 'hidden',
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingTop: 2 },
  link: { paddingVertical: 4 },
  linkText: { fontSize: 13.5, fontWeight: '500' },
  button: { borderRadius: 9, paddingHorizontal: 12, paddingVertical: 6 },
  buttonText: { fontSize: 13.5, fontWeight: '600' },
  meta: { fontSize: 12.5, lineHeight: 17 },
  tools: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingTop: 2 },
  tool: {
    fontFamily: MONO,
    fontSize: 12,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: 'hidden',
  },
  wide: { alignItems: 'center', borderRadius: 12, paddingVertical: 12, marginTop: 6 },
  wideText: { fontSize: 15, fontWeight: '500' },
  apps: { gap: 8 },
  empty: { fontSize: 14, lineHeight: 20, paddingVertical: 24, textAlign: 'center' },
  footnote: { fontSize: 12, lineHeight: 17, paddingTop: 6 },
})
