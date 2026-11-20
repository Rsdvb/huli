// Settings › MCP 服务器: Huli's own server and whether it listens, which agents get its tools, the
// servers Huli keeps for the agents with their sign-ins, and where each agent keeps its own.

import { useEffect, useState } from 'react'
import { Linking, StyleSheet, Text, View } from 'react-native'
import type { AgentStatus, HostEvent, McpStatus } from '@shared/agent-host'
import type { AgentId } from '@shared/agents'
import {
  specRuns,
  type ConnectStart,
  type MarketConnection,
  type MarketConnections,
  type MarketServer,
} from '@shared/marketplace'
import { Sheet, type SheetItem } from '../../components/Sheet'
import { useHost } from '../../host'
import {
  Button,
  call,
  Code,
  confirm,
  fail,
  GroupNote,
  homeShort,
  ManagePage,
  Notice,
  ReadState,
  SwitchRow,
  Tag,
  useActions,
  useConnected,
  useHostSettings,
  useRead,
} from '../../manage/kit'
import { AgentAvatar } from '../../ui/AgentAvatar'
import { BottomSheet } from '../../ui/BottomSheet'
import { haptic } from '../../ui/haptics'
import { ListGroup, ListRow } from '../../ui/ListRow'
import { space, type as typeScale, useTokens } from '../../ui/tokens'

/** The product's name where the host still says Kettu's. */
const shown = (title: string) => (title === 'Kettu' ? '纸鸢' : title)

function connectionText(connection: MarketConnection | undefined): string | null {
  if (!connection) return null
  switch (connection.state) {
    case 'connected':
      return connection.account ? `已以 ${connection.account} 连接` : '已连接'
    case 'needs-reconnect':
      return '需要重新连接'
    case 'error':
      return `出错：${connection.message}`
    default:
      return '未连接'
  }
}

export default function McpSettings() {
  const { c } = useTokens()
  const host = useHost()
  const connected = useConnected()
  const status = useRead<McpStatus>('mcp', (link) => call(link, 'mcp.status', undefined))
  const connections = useRead<MarketConnections>(
    'connections',
    (link) => call(link, 'market.connections', undefined),
    ['market.connectionChanged'],
  )
  const settings = useHostSettings()
  const actions = useActions()
  const [menu, setMenu] = useState<MarketServer | null>(null)
  const [showTools, setShowTools] = useState(false)
  const [code, setCode] = useState<Extract<ConnectStart, { kind: 'device' }> | null>(null)

  const agents = [...host.agents.values()].filter((a) => a.registered !== false)
  const off: AgentId[] = settings.value?.mcp.kettu.off ?? []
  const kept = settings.value?.marketplace.mcp ?? []
  const server = status.value?.servers.find((s) => s.builtIn) ?? null

  // A device code's sign-in ends at the service; the computer says how it ended.
  useEffect(() => {
    if (!code || !host.link) return
    return host.link.onHostEvent((raw) => {
      const event = raw as HostEvent
      if (event.type !== 'market.connectionChanged' || event.loginId !== code.loginId) return
      setCode(null)
      if (event.connection.state === 'connected') haptic.success()
      else fail('无法连接', new Error(event.error ?? '登录没有完成。'))
    })
  }, [code, host.link])

  const setKettu = (agentId: AgentId, on: boolean) =>
    actions.run(
      `kettu:${agentId}`,
      () =>
        settings.update({
          mcp: { kettu: { off: on ? off.filter((id) => id !== agentId) : [...off, agentId] } },
        }),
      '无法修改',
    )

  const saveKept = (next: MarketServer[], key: string, failTitle: string) =>
    actions.run(key, () => settings.update({ marketplace: { mcp: next } }), failTitle)

  const setOn = (s: MarketServer, on: boolean) =>
    saveKept(
      kept.map((k) => (k.id === s.id ? { ...k, on } : k)),
      `on:${s.id}`,
      `无法修改 ${s.title}`,
    )

  const uninstall = async (s: MarketServer) => {
    const ok = await confirm({
      title: `卸载 ${s.title}？`,
      message: '新会话启动时将不再带上它，它的密钥也会从电脑上删除。',
      confirm: '卸载',
    })
    if (ok)
      await saveKept(
        kept.filter((k) => k.id !== s.id),
        `on:${s.id}`,
        `无法修改 ${s.title}`,
      )
  }

  const connect = async (s: MarketServer) => {
    if (!host.link) return
    if (s.spec.type === 'http' && s.spec.oauth?.flow === 'browser') {
      fail(
        '无法连接',
        new Error('这个服务只能在主机自己的浏览器里完成登录，请在那台主机上的纸鸢里连接。'),
      )
      return
    }
    await actions.run(
      `connect:${s.id}`,
      async () => {
        const start = await call(host.link!, 'market.connect', { serverId: s.id })
        if (start.kind === 'device') setCode(start)
        else void connections.reload()
      },
      '无法连接',
    )
  }

  const disconnect = (s: MarketServer) =>
    actions.run(
      `connect:${s.id}`,
      async () => {
        await call(host.link!, 'market.disconnect', { serverId: s.id })
        connections.set((all) => ({ ...all, [s.id]: { state: 'disconnected' } }))
      },
      `无法断开 ${s.title}`,
    )

  const menuItems = (s: MarketServer): SheetItem[] => {
    const oauth = s.spec.type === 'http' && !!s.spec.oauth
    const connection = connections.value?.[s.id]
    const items: SheetItem[] = [
      {
        key: 'on',
        label: s.on ? '关闭' : '开启',
        disabled: !connected,
        onPress: () => void setOn(s, !s.on),
      },
    ]
    if (oauth) {
      items.push(
        connection?.state === 'connected'
          ? {
              key: 'disconnect',
              label: '断开连接',
              disabled: !connected,
              onPress: () => void disconnect(s),
            }
          : {
              key: 'connect',
              label: connection?.state === 'needs-reconnect' ? '重新连接' : '连接',
              disabled: !connected,
              onPress: () => void connect(s),
            },
      )
    }
    items.push({
      key: 'uninstall',
      label: '卸载…',
      destructive: true,
      disabled: !connected,
      onPress: () => void uninstall(s),
    })
    return items
  }

  const agentName = (id: AgentId) => host.agents.get(id)?.name ?? id

  return (
    <ManagePage
      title="MCP 服务器"
      intro="纸鸢自带的服务器，以及你安装的服务器。Agent 自己的服务器也会连接。"
      onRefresh={() =>
        Promise.all([status.reload(), connections.reload(), settings.reload(), host.refresh()])
      }
      overlay={
        <>
          <Sheet
            visible={menu !== null}
            title={menu?.title}
            message={menu ? specRuns(menu.spec) : undefined}
            items={menu ? menuItems(menu) : []}
            onClose={() => setMenu(null)}
          />
          <BottomSheet
            visible={code !== null}
            onClose={() => setCode(null)}
            title="在服务页面输入这个验证码"
            message="登录信息由纸鸢保管，这些 Agent 通过纸鸢访问这个服务器。"
          >
            {code ? (
              <>
                <Text
                  selectable
                  style={[typeScale.stat, styles.code, { color: c.text }]}
                  accessibilityLabel={`验证码 ${code.userCode}`}
                >
                  {code.userCode}
                </Text>
                <Button
                  label="打开服务页面"
                  tone="primary"
                  icon="external"
                  onPress={() => void Linking.openURL(code.verificationUri)}
                />
                <Text style={[typeScale.footnote, styles.center, { color: c.textTertiary }]}>
                  正在等待登录完成…
                </Text>
              </>
            ) : null}
          </BottomSheet>
        </>
      }
    >
      {status.value === null ? (
        <ReadState read={status} what="MCP 服务器" icon="server" rows={2} />
      ) : (
        <>
          {server ? (
            <ListGroup
              header="内置"
              footer="产物、会话和浏览器都通过纸鸢自带的服务器提供给每个 Agent。"
            >
              <ListRow
                title={shown(server.title)}
                subtitle={[
                  server.running ? '运行中' : '未运行',
                  `${server.tools.length} 个工具`,
                ].join(' · ')}
                icon="server"
                iconTint={server.running ? c.success : c.danger}
                trailing={<Tag label="内置" />}
              />
              {server.tools.length > 0 ? (
                <ListRow
                  title={showTools ? '收起工具' : '显示工具'}
                  action
                  onPress={() => {
                    haptic.tap()
                    setShowTools((v) => !v)
                  }}
                />
              ) : null}
              {showTools
                ? server.tools.map((tool) => (
                    <ListRow
                      key={tool.name}
                      title={tool.name}
                      subtitle={tool.description}
                      trailing={tool.asks ? <Tag label="会先问你" /> : undefined}
                    />
                  ))
                : null}
            </ListGroup>
          ) : null}
          {server && !server.running ? (
            <Notice
              tone="error"
              title="纸鸢的服务器没有运行"
              actions={
                <Button
                  label="重试"
                  icon="refresh"
                  busy={actions.busy('retry')}
                  disabled={!connected}
                  onPress={() =>
                    void actions.run(
                      'retry',
                      async () => {
                        const next = await call(host.link!, 'mcp.retry', undefined)
                        status.set(() => next)
                      },
                      '没能重试',
                    )
                  }
                />
              }
            >
              <Text style={[typeScale.footnote, { color: c.textSecondary }]}>
                在它运行之前，会话启动时不带它的工具。
              </Text>
              {server.error ? <Code>{server.error}</Code> : null}
            </Notice>
          ) : null}

          {agents.length > 0 ? (
            <ListGroup header="在各 Agent 中使用纸鸢的工具">
              {agents.map((agent) => (
                <KettuSwitch
                  key={agent.id}
                  agent={agent}
                  off={off.includes(agent.id)}
                  busy={actions.busy(`kettu:${agent.id}`)}
                  disabled={!connected || settings.value === null}
                  onChange={(on) => void setKettu(agent.id, on)}
                />
              ))}
            </ListGroup>
          ) : null}

          <View style={styles.section}>
            <Text style={[typeScale.headline, styles.header, { color: c.textSecondary }]}>
              MCP 服务器
            </Text>
            {settings.value === null ? (
              settings.error ? (
                <GroupNote tone="error">{`无法读取 MCP 服务器：${settings.error}`}</GroupNote>
              ) : (
                <GroupNote>正在读取…</GroupNote>
              )
            ) : kept.length === 0 ? (
              <GroupNote>
                纸鸢还没有保存任何 MCP 服务器。可以在电脑上纸鸢的 Marketplace 里安装。
              </GroupNote>
            ) : (
              <ListGroup>
                {kept.map((s) => {
                  const oauth = s.spec.type === 'http' && !!s.spec.oauth
                  const line = [
                    oauth ? connectionText(connections.value?.[s.id]) : null,
                    s.on ? null : '已关闭',
                    s.agents === 'all' ? null : `用于 ${s.agents.length} 个 Agent`,
                    specRuns(s.spec),
                  ]
                    .filter(Boolean)
                    .join(' · ')
                  return (
                    <ListRow
                      key={s.id}
                      title={s.title}
                      subtitle={line}
                      icon="server"
                      chevron
                      disabled={actions.busy(`on:${s.id}`) || actions.busy(`connect:${s.id}`)}
                      onPress={() => setMenu(s)}
                    />
                  )
                })}
              </ListGroup>
            )}
          </View>

          {status.value.places.length > 0 ? (
            <ListGroup
              header="Agent 自己的"
              footer="每个 Agent 自己保存的 MCP 服务器。纸鸢只显示它们，要修改请在 Agent 中进行。"
            >
              {status.value.places.map((place) => {
                const path = homeShort(place.path)
                const note = place.chosen
                  ? '在纸鸢中选定'
                  : place.env
                    ? `由 ${place.env} 设定`
                    : null
                return (
                  <ListRow
                    key={place.agentId}
                    title={agentName(place.agentId)}
                    subtitle={[
                      place.exists ? path : `${path} · 尚未创建`,
                      note,
                      place.listCommand
                        ? `在会话中输入 ${place.listCommand} 可以查看，或在项目里添加 ${place.project}。`
                        : `也读取项目里的 ${place.project}。`,
                    ]
                      .filter(Boolean)
                      .join('\n')}
                    leading={<AgentAvatar agentId={place.agentId} size={30} />}
                  />
                )
              })}
            </ListGroup>
          ) : null}
        </>
      )}
    </ManagePage>
  )
}

/** Whether one agent's sessions get Huli's tools, and when a change takes effect. */
function KettuSwitch(props: {
  agent: AgentStatus
  off: boolean
  busy: boolean
  disabled: boolean
  onChange(on: boolean): void
}) {
  const { agent } = props
  const takesNone = agent.capabilities.mcpHttp === false
  const active = agent.kettuServer.active
  const note = takesNone
    ? `${agent.name} 不支持通过 HTTP 连接的 MCP 服务器。`
    : active !== null && active !== agent.kettuServer.runs
      ? `将在 ${agent.name} 下次启动时生效。`
      : undefined
  if (takesNone) {
    return (
      <ListRow
        title={agent.name}
        subtitle={note}
        leading={<AgentAvatar agentId={agent.id} name={agent.name} size={30} />}
      />
    )
  }
  return (
    <SwitchRow
      title={agent.name}
      subtitle={note}
      leading={<AgentAvatar agentId={agent.id} name={agent.name} size={30} />}
      value={!props.off}
      busy={props.busy}
      disabled={props.disabled}
      onChange={props.onChange}
    />
  )
}

const styles = StyleSheet.create({
  section: { gap: space.sm },
  header: { marginLeft: space.lg },
  code: { textAlign: 'center', letterSpacing: 4, paddingVertical: space.md },
  center: { textAlign: 'center' },
})
