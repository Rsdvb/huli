// 开发服务器: the computer's dev servers, read when the page opens and again on a pull, never on a
// timer. From a session's ⋯ menu (`session`) its own come first. A tap previews one in the app.

import { memo, useCallback, useEffect, useState, type ReactElement } from 'react'
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { router, Stack, useLocalSearchParams } from 'expo-router'
import { parseLaunchAnswer, type LaunchConfig } from '@shared/launch-configs'
import { listDevServers, NEEDS_DIRECT, type DevServer } from '../devServers'
import { errorText } from '../git'
import { getHost, useHostState, useLink, useSession } from '../host'
import { sessionTitle } from '../sessions'
import { currentRoute, type CurrentRoute } from '../connection'
import { GlassHeader } from '../ui/session/GlassHeader'
import { G, Icon } from '../ui/session/icons'
import { MONO, useSessionTokens } from '../ui/session/palette'
import { PressScale } from '../ui/session/Press'
import { StateView } from '../ui/session/StateView'

export default function DevServersScreen() {
  const { session } = useLocalSearchParams<{ session?: string }>()
  const { c, s } = useSessionTokens()
  const link = useLink()
  const state = useHostState()
  const summary = useSession(session)
  const [route, setRoute] = useState<CurrentRoute | null>(null)
  const [list, setList] = useState<DevServer[] | null>(null)
  const [unlisted, setUnlisted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  // Huli: the session's .claude/launch.json presets, which Start runs in its terminal.
  const [presets, setPresets] = useState<LaunchConfig[]>([])
  const [started, setStarted] = useState<string | null>(null)
  const connected = state.kind === 'connected'

  // Named by the sessions and projects of the moment; what changes later shows on the next pull.
  const load = useCallback(async () => {
    setError(null)
    try {
      const { projects, sessions } = getHost()
      setRoute(currentRoute())
      const found = await listDevServers(link, projects, sessions, session ?? null)
      setUnlisted(found === null)
      setList(found ?? [])
      if (session) {
        // An older computer has no presets to give.
        const answer = await link
          .request('sessions.launchConfigs', { sessionId: session })
          .catch(() => null)
        setPresets(parseLaunchAnswer(answer))
      }
    } catch (failed) {
      setError(errorText(failed, '没能读取电脑上的端口。'))
    }
  }, [link, session])

  useEffect(() => {
    if (connected) void load()
  }, [connected, load])

  const refresh = () => {
    setRefreshing(true)
    void load().finally(() => setRefreshing(false))
  }

  const open = useCallback((server: DevServer) => {
    router.push({
      pathname: '/dev-preview',
      params: { port: String(server.port), name: server.process ?? '' },
    })
  }, [])

  // Runs the preset's command in a terminal of the session; the list shows its port once it
  // listens, on the next pull.
  const start = useCallback(
    (preset: LaunchConfig) => {
      if (!session) return
      setStarted(preset.name)
      link
        .request('sessions.runCommand', {
          sessionId: session,
          command: preset.command,
          notify: false,
        })
        .catch((failed: unknown) => {
          setStarted(null)
          setError(errorText(failed, '没能启动这个开发服务器。'))
        })
    },
    [link, session],
  )

  let body: ReactElement
  if (!list) {
    body = error ? (
      <StateView text={error} tone="danger" retry={() => void load()} />
    ) : connected ? (
      <StateView loading />
    ) : (
      <StateView text="连上电脑后才能看到它的开发服务器。" icon={G.wifiOff} />
    )
  } else if (unlisted) {
    body = <StateView text="这台电脑列不出它的端口。" icon={G.devServer} />
  } else {
    body = (
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={c.textSecondary} />
        }
      >
        {route?.kind === 'relay' ? (
          <View style={[styles.notice, { backgroundColor: s.warningSoft }]}>
            <Icon icon={G.wifiOff} size={15} color={c.warning} />
            <Text style={[styles.noticeText, { color: c.text }]}>{NEEDS_DIRECT}</Text>
          </View>
        ) : null}
        {presets.length > 0 ? (
          <View style={styles.presets}>
            <Text style={[styles.presetsTitle, { color: c.textSecondary }]}>
              .claude/launch.json 里的预设
            </Text>
            {presets.map((preset) => {
              const running = list.find(
                (server) => preset.port !== null && server.port === preset.port,
              )
              return (
                <PresetRow
                  key={preset.name}
                  preset={preset}
                  running={running ?? null}
                  started={started === preset.name}
                  onOpen={open}
                  onStart={start}
                />
              )
            })}
          </View>
        ) : null}
        {list.length === 0 ? (
          <Text style={[styles.empty, { color: c.textSecondary }]}>
            电脑上没有在 1024 以上端口监听的程序。启动开发服务器（比如 npm run dev）后下拉刷新。
          </Text>
        ) : (
          list.map((server) => (
            <ServerRow
              key={server.port}
              server={server}
              own={!!session && server.session?.id === session}
              onOpen={open}
            />
          ))
        )}
        <Text style={[styles.footnote, { color: c.textTertiary }]}>
          只列出电脑上你自己的程序。预览经直连打开，只有这台手机能用，30 分钟不用就自动关闭。
        </Text>
      </ScrollView>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ headerShown: false }} />
      <GlassHeader title="开发服务器" subtitle={summary ? sessionTitle(summary) : null} />
      {body}
    </View>
  )
}

const PresetRow = memo(function PresetRow(props: {
  preset: LaunchConfig
  running: DevServer | null
  started: boolean
  onOpen(server: DevServer): void
  onStart(preset: LaunchConfig): void
}) {
  const { c, s } = useSessionTokens()
  const { preset, running, started } = props
  return (
    <PressScale
      onPress={() => (running ? props.onOpen(running) : props.onStart(preset))}
      disabled={!running && started}
      accessibilityRole="button"
      accessibilityLabel={running ? `预览 ${preset.name}` : `启动 ${preset.name}`}
      style={[styles.row, { backgroundColor: s.code, borderColor: s.codeBorder }]}
    >
      <Text style={[styles.port, { color: c.text }]}>{preset.port ?? '—'}</Text>
      <View style={styles.what}>
        <Text style={[styles.process, { color: c.text }]} numberOfLines={1}>
          {preset.name}
        </Text>
        <Text style={[styles.where, { color: c.textSecondary }]} numberOfLines={1}>
          {running ? '正在运行' : started ? '已在电脑的终端里启动，下拉刷新' : preset.command}
        </Text>
      </View>
      {running ? (
        <Icon icon={G.globe} size={17} color={c.textSecondary} />
      ) : (
        <Text style={[styles.tag, { color: c.accent, backgroundColor: s.accentSoft }]}>启动</Text>
      )}
    </PressScale>
  )
})

const ServerRow = memo(function ServerRow(props: {
  server: DevServer
  own: boolean
  onOpen(server: DevServer): void
}) {
  const { c, s } = useSessionTokens()
  const { server, own } = props
  const where =
    server.session?.title ?? server.project ?? (server.folder ? folderName(server.folder) : null)
  return (
    <PressScale
      onPress={() => props.onOpen(server)}
      accessibilityRole="button"
      accessibilityLabel={`预览端口 ${server.port}`}
      style={[styles.row, { backgroundColor: s.code, borderColor: s.codeBorder }]}
    >
      <Text style={[styles.port, { color: c.text }]}>{server.port}</Text>
      <View style={styles.what}>
        <Text style={[styles.process, { color: c.text }]} numberOfLines={1}>
          {server.process ?? '未知程序'}
        </Text>
        {where ? (
          <Text style={[styles.where, { color: c.textSecondary }]} numberOfLines={1}>
            {server.session ? `会话 · ${where}` : where}
          </Text>
        ) : null}
      </View>
      {own ? (
        <Text style={[styles.tag, { color: c.accent, backgroundColor: s.accentSoft }]}>本会话</Text>
      ) : null}
      <Icon icon={G.globe} size={17} color={c.textSecondary} />
    </PressScale>
  )
})

function folderName(folder: string): string {
  const parts = folder.split(/[\\/]/).filter(Boolean)
  return parts.at(-1) ?? folder
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingBottom: 32, gap: 10 },
  presets: { gap: 10 },
  presetsTitle: { fontSize: 13, fontWeight: '500', marginTop: 4 },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  noticeText: { flex: 1, fontSize: 13, lineHeight: 18 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  port: { fontFamily: MONO, fontSize: 17, fontWeight: '600', minWidth: 56 },
  what: { flex: 1, gap: 2 },
  process: { fontSize: 15, fontWeight: '500' },
  where: { fontSize: 12.5 },
  tag: {
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    overflow: 'hidden',
  },
  empty: { fontSize: 14, lineHeight: 20, paddingVertical: 24, textAlign: 'center' },
  footnote: { fontSize: 12, lineHeight: 17, paddingTop: 6 },
})
