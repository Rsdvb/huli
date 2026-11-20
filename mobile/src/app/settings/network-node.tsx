// Settings › Agent 网络 › a node picker: the default node (`target` default) or one agent's network,
// with each node's latency and a test of them all, and for an agent the computer's network
// interfaces, one of which it may be bound to.

import { useState } from 'react'
import { router, useLocalSearchParams } from 'expo-router'
import type { NodeRef } from '@shared/agent-network'
import type { AgentId } from '@shared/thread'
import { useHost } from '../../host'
import {
  Button,
  call,
  GroupNote,
  ManagePage,
  ReadState,
  useActions,
  useConnected,
} from '../../manage/kit'
import {
  agentChoice,
  agentExit,
  choiceText,
  delayText,
  exitText,
  nodeKey,
  reloadSoon,
  setPick,
  useNetworkStatus,
  type NetworkPick,
  type NetworkStatus,
} from '../../manage/network'
import { Icon } from '../../ui/Icon'
import { ListGroup, ListRow } from '../../ui/ListRow'
import { useTokens } from '../../ui/tokens'

function samePick(a: NetworkPick, b: NetworkPick): boolean {
  if (a === b) return true
  if (a === null || b === null || typeof a === 'string' || typeof b === 'string') return false
  if ('interface' in a || 'interface' in b) {
    return 'interface' in a && 'interface' in b && a.interface === b.interface
  }
  return a.subscription === b.subscription && a.node === b.node
}

/** The interfaces to offer, with the one the agent is bound to kept even when it is gone. */
function interfaceRows(status: NetworkStatus, current: NetworkPick) {
  const bound = current !== null && typeof current === 'object' && 'interface' in current
  const name = bound ? current.interface : null
  const list = status.interfaces.map((item) => ({ ...item, gone: false }))
  if (name !== null && !list.some((item) => item.name === name)) {
    list.push({ name, up: false, tunnel: false, gone: true })
  }
  return list
}

/** The nodes by subscription, in the computer's order. */
function bySubscription(status: NetworkStatus) {
  return status.subscriptions
    .map((sub) => ({ sub, nodes: status.nodes.filter((n) => n.subscription === sub.id) }))
    .filter((group) => group.nodes.length > 0)
}

/** How many of a subscription's nodes show before 显示全部. */
const NODES_SHOWN = 40

export default function NetworkNodeScreen() {
  const { target: raw } = useLocalSearchParams<{ target?: string }>()
  const target = (raw ?? 'default') as 'default' | AgentId
  const { c } = useTokens()
  const host = useHost()
  const connected = useConnected()
  const read = useNetworkStatus()
  const { busy, run } = useActions()
  const [delays, setDelays] = useState<Record<string, number | null>>({})
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set())
  const status = read.value
  const forDefault = target === 'default'
  const title = forDefault ? '默认节点' : (host.agents.get(target)?.name ?? target)

  const current: NetworkPick = !status
    ? null
    : forDefault
      ? status.defaultNode
      : agentChoice(status, target)

  const pick = async (next: NetworkPick) => {
    if (!host.link || samePick(next, current)) {
      router.back()
      return
    }
    const done = await run('pick', () => setPick(host.link!, target, next), '没能切换')
    if (done) {
      reloadSoon()
      router.back()
    }
  }

  const test = () =>
    void run(
      'test',
      async () => {
        const { results } = await call(host.link!, 'agentNetwork.deviceLatency', { nodes: null })
        const next: Record<string, number | null> = {}
        for (const result of results) next[nodeKey(result)] = result.delay
        setDelays(next)
      },
      '没能测速',
    )

  const check = (selected: boolean) =>
    selected ? <Icon name="check" size={18} color={c.tint} weight="semibold" /> : undefined

  const nodeRow = (ref: NodeRef & { delay: number | null }) => {
    const key = nodeKey(ref)
    // A test's null is a node that did not answer; the computer's own checks say so with 0.
    const delay = key in delays ? (delays[key] ?? 0) : ref.delay
    return (
      <ListRow
        key={key}
        title={ref.node}
        value={delayText(delay)}
        trailing={check(samePick(current, ref))}
        disabled={!connected || busy('pick')}
        onPress={() => void pick({ subscription: ref.subscription, node: ref.node })}
      />
    )
  }

  const running = status?.state === 'running'
  const exit = status && !forDefault ? exitText(agentExit(status, target)) : null

  return (
    <ManagePage
      title={title}
      subtitle={forDefault ? undefined : '网络出口'}
      onRefresh={read.reload}
      right={
        running && status.nodes.length > 0 ? (
          <Button label="测速" busy={busy('test')} disabled={!connected} onPress={test} />
        ) : undefined
      }
    >
      {status === null ? (
        <ReadState read={read} what="节点" icon="globe" rows={6} />
      ) : (
        <>
          <ListGroup
            footer={
              forDefault
                ? '没有默认节点时，跟随默认的 Agent 没有网络。'
                : [
                    '切换到系统网络或从系统网络切出，要等它下次启动才生效。',
                    exit ? `上次检测：${exit}` : null,
                  ]
                    .filter(Boolean)
                    .join('\n')
            }
          >
            {forDefault ? (
              <ListRow
                title="无：不联网"
                trailing={check(current === null)}
                disabled={!connected || busy('pick')}
                onPress={() => void pick(null)}
              />
            ) : (
              <>
                <ListRow
                  title={choiceText(status, 'default')}
                  trailing={check(current === 'default')}
                  disabled={!connected || busy('pick')}
                  onPress={() => void pick('default')}
                />
                <ListRow
                  title="系统网络"
                  trailing={check(current === 'system')}
                  disabled={!connected || busy('pick')}
                  onPress={() => void pick('system')}
                />
              </>
            )}
          </ListGroup>

          {!forDefault && (
            <ListGroup
              header="选择网卡"
              footer="Agent 的流量和域名解析只从选定的网卡出去，比如代理软件的 TUN 或 WLAN。网卡断开或不存在时它就没有网络，不会改走别的网卡。"
            >
              {interfaceRows(status, current).length === 0 ? (
                <GroupNote>没有读到电脑的网卡。</GroupNote>
              ) : (
                interfaceRows(status, current).map((item) => (
                  <ListRow
                    key={item.name}
                    title={item.name}
                    subtitle={item.tunnel ? 'TUN / VPN' : undefined}
                    value={item.gone ? '已不存在' : item.up ? '已连接' : '未连接'}
                    trailing={check(samePick(current, { interface: item.name }))}
                    disabled={!connected || busy('pick')}
                    onPress={() => void pick({ interface: item.name })}
                  />
                ))
              )}
            </ListGroup>
          )}

          {!running ? (
            <GroupNote>Agent 网络在电脑上运行时才列出节点。</GroupNote>
          ) : status.nodes.length === 0 ? (
            <GroupNote>还没有节点。在电脑上添加或更新订阅。</GroupNote>
          ) : (
            bySubscription(status).map(({ sub, nodes }) => {
              // A subscription of hundreds of nodes draws its first ones, and the rest on asking:
              // drawn whole on a page that does not recycle its rows, it held up the screen.
              const all = opened.has(sub.id) || nodes.length <= NODES_SHOWN
              const chosen = nodes.find((n) => samePick(current, n))
              const shown = all ? nodes : nodes.slice(0, NODES_SHOWN)
              const extra = chosen && !shown.includes(chosen) ? [chosen] : []
              return (
                <ListGroup key={sub.id} header={sub.name}>
                  {[...shown, ...extra].map(nodeRow)}
                  {all ? null : (
                    <ListRow
                      key="more"
                      title={`显示全部 ${nodes.length} 个节点`}
                      action
                      onPress={() => setOpened((was) => new Set(was).add(sub.id))}
                    />
                  )}
                </ListGroup>
              )
            })
          )}
        </>
      )}
    </ManagePage>
  )
}
