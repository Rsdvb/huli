// Settings › Agent 网络: the computer's agent network as the phone may see it: whether it runs, the
// default node, each agent's choice with where its traffic leaves from, and the subscriptions'
// names, nodes and traffic. Picking nodes is the phone's; the subscriptions stay the computer's.

import { router } from 'expo-router'
import { formatBytes, type SubscriptionUsage } from '@shared/agent-network'
import type { AgentId } from '@shared/thread'
import { useHost } from '../../host'
import { GroupNote, ManagePage, Notice, ReadState } from '../../manage/kit'
import {
  agentChoice,
  agentExit,
  choiceText,
  defaultText,
  exitText,
  PROBLEM_TEXT,
  STATE_TEXT,
  useNetworkStatus,
} from '../../manage/network'
import { ListGroup, ListRow } from '../../ui/ListRow'
import { dateText } from '../../usage/text'

function usageText(usage: SubscriptionUsage | null): string | null {
  if (!usage) return null
  const parts: string[] = []
  if (usage.total > 0) {
    parts.push(`已用 ${formatBytes(usage.upload + usage.download)} / ${formatBytes(usage.total)}`)
  }
  if (usage.expire) parts.push(`${dateText(usage.expire)}到期`)
  return parts.length > 0 ? parts.join(' · ') : null
}

function openPicker(target: 'default' | AgentId): void {
  router.push({ pathname: '/settings/network-node', params: { target } })
}

export default function AgentNetworkScreen() {
  const host = useHost()
  const read = useNetworkStatus()
  const status = read.value
  const agentName = (id: AgentId) => host.agents.get(id)?.name ?? id

  return (
    <ManagePage
      title="Agent 网络"
      intro="Agent 可以经由电脑上机场订阅的节点联网，也可以只从电脑的某块网卡联网；节点或网卡不可用时就没有网络，不会从别的路出去。订阅只在电脑上添加和管理，链接不会发到手机。"
      onRefresh={read.reload}
    >
      {status === null ? (
        <ReadState read={read} what="Agent 网络" icon="network" rows={4} />
      ) : (
        <>
          {!status.available ? (
            <Notice tone="warning" title="这台电脑上不能用">
              {PROBLEM_TEXT.missing}
            </Notice>
          ) : !status.enabled ? (
            <Notice tone="info" title="Agent 网络在电脑上已关闭">
              所有 Agent 都用系统网络。在电脑的「设置 › 智能体网络」里打开。
            </Notice>
          ) : status.problem ? (
            <Notice tone="error" title="Agent 网络未运行">
              {PROBLEM_TEXT[status.problem]}
            </Notice>
          ) : null}

          <ListGroup header="状态">
            <ListRow title="状态" icon="network" plainIcon value={STATE_TEXT[status.state]} />
            <ListRow title="网卡" icon="wifi" plainIcon value={status.interface ?? '—'} />
          </ListGroup>

          <ListGroup header="默认节点" footer="跟随默认的 Agent 经由这个节点联网。">
            <ListRow
              title="默认节点"
              icon="globe"
              plainIcon
              value={defaultText(status)}
              chevron
              onPress={() => openPicker('default')}
            />
          </ListGroup>

          <ListGroup
            header="Agent"
            footer="切换到系统网络或从系统网络切出，要等 Agent 下次启动才生效。出口是电脑经由这个 Agent 的路实际测到的地址。"
          >
            {status.agents.map(({ agentId }) => {
              const exit = exitText(agentExit(status, agentId))
              return (
                <ListRow
                  key={agentId}
                  title={agentName(agentId)}
                  subtitle={[choiceText(status, agentChoice(status, agentId)), exit]
                    .filter(Boolean)
                    .join('\n')}
                  icon="sparkles"
                  plainIcon
                  chevron
                  onPress={() => openPicker(agentId)}
                />
              )
            })}
          </ListGroup>

          <ListGroup header="订阅" footer="订阅只能在电脑上添加、移除和更新。">
            {status.subscriptions.length === 0 ? (
              <GroupNote>电脑上还没有订阅。</GroupNote>
            ) : (
              status.subscriptions.map((sub) => (
                <ListRow
                  key={sub.id}
                  title={sub.name}
                  subtitle={
                    [sub.nodes === null ? '尚未读取' : `${sub.nodes} 个节点`, usageText(sub.usage)]
                      .filter(Boolean)
                      .join(' · ') || undefined
                  }
                  icon="server"
                  plainIcon
                />
              ))
            )}
          </ListGroup>
        </>
      )}
    </ManagePage>
  )
}
