// Huli: Settings › Agent network, this computer's: whether agents go through nodes, mihomo's
// state, the interface, the subscriptions, the default node and each agent's choice. Huli's own;
// see tools/huli/README.md.

import { useState } from 'react'
import { Route01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { SubscriptionView } from '@shared/agent-network'
import { usableAgents, useAgentsStore } from '@renderer/stores/agents'
import { useAgentNetwork, useAgentNetworkStore } from '@renderer/stores/agent-network'
import { useSettingsStore } from '@renderer/stores/settings'
import { SetButton } from './controls'
import type { GroupDef, RowDef, SectionDef } from './model'
import {
  DefaultNodeControl,
  ExitCheckAction,
  ExitLine,
  InterfaceField,
  InterfaceRow,
  InterfacesEmpty,
  NetworkChoiceSelect,
  NetworkState,
  NetworkSwitch,
  RefreshAllAction,
  RefreshInterfacesAction,
  RemoveSubscriptionDialog,
  SubscriptionDialog,
  SubscriptionRow,
} from './agent-network-rows'
import { EmptyRow, GroupNote, RowShell } from './rows'

function group(id: string, label: string, extra?: Omit<GroupDef, 'id' | 'label'>): GroupDef {
  return { id, label, ...extra }
}

export function useAgentNetworkSection(): SectionDef {
  const { t } = useTranslation('settings')
  useAgentNetwork()
  const status = useAgentNetworkStore((s) => s.status)
  const statusError = useAgentNetworkStore((s) => s.statusError)
  const nodes = useAgentNetworkStore((s) => s.nodes)
  const interfaces = useAgentNetworkStore((s) => s.interfaces)
  const enabled = useSettingsStore((s) => s.settings.agentNetwork.enabled)
  const choices = useSettingsStore((s) => s.settings.agentNetwork.agents)
  const order = useAgentsStore((s) => s.order)
  const byId = useAgentsStore((s) => s.byId)
  const agents = usableAgents(order, byId).filter((agent) => !agent.disabled)
  const [editing, setEditing] = useState<SubscriptionView | null | 'new' | 'file'>(null)
  const [removing, setRemoving] = useState<SubscriptionView | null>(null)
  const running = status?.state === 'running'
  const subscriptions = status?.subscriptions ?? []

  const problem = status?.problem ? t(`network.problem.${status.problem}`) : null
  const main = group('agent-network', t('network.groups.main'), {
    unlabeled: true,
    note:
      problem || statusError ? (
        <>
          {problem && <GroupNote>{problem}</GroupNote>}
          {status?.detail && <GroupNote>{status.detail}</GroupNote>}
          {statusError && <GroupNote>{statusError}</GroupNote>}
        </>
      ) : undefined,
  })
  const subs = group('subscriptions', t('network.groups.subscriptions'), {
    count: subscriptions.length,
    actions: (
      <>
        {subscriptions.some((sub) => sub.source === 'url') && <RefreshAllAction />}
        <SetButton variant="ghost" onClick={() => setEditing('file')}>
          {t('network.subscriptions.importFile')}
        </SetButton>
        <SetButton variant="ghost" onClick={() => setEditing('new')}>
          {t('network.subscriptions.add')}
        </SetButton>
      </>
    ),
    note: (
      <>
        <SubscriptionDialog
          key={typeof editing === 'string' ? editing : (editing?.id ?? 'closed')}
          sub={typeof editing === 'string' ? null : editing}
          fromFile={editing === 'file'}
          open={editing !== null}
          onOpenChange={(open) => !open && setEditing(null)}
        />
        <RemoveSubscriptionDialog
          sub={removing}
          onOpenChange={(open) => !open && setRemoving(null)}
        />
      </>
    ),
  })
  const defaults = group('default-node', t('network.groups.default'), {
    note:
      enabled && !running ? <GroupNote>{t('network.default.notRunning')}</GroupNote> : undefined,
  })
  const agentGroup = group('agents', t('network.groups.agents'), { count: agents.length })
  const interfaceGroup = group('interfaces', t('network.groups.interfaces'), {
    count: interfaces?.length,
    actions: <RefreshInterfacesAction />,
    note: <GroupNote>{t('network.interfaces.description')}</GroupNote>,
  })
  /** The names of the agents bound to the interface. */
  const boundTo = (name: string) =>
    agents
      .filter((agent) => {
        const choice = choices[agent.id]
        return typeof choice === 'object' && 'interface' in choice && choice.interface === name
      })
      .map((agent) => agent.name)

  const rows: RowDef[] = [
    {
      id: 'enabled',
      setting: 'agent-network.enabled',
      group: main,
      render: () => <NetworkSwitch label={t('network.enabled.name')} />,
    },
    {
      id: 'status',
      setting: 'agent-network.status',
      group: main,
      render: () => <NetworkState status={status} />,
    },
    {
      id: 'interface',
      setting: 'agent-network.interface',
      description: status?.interface.detected
        ? t('network.interface.descriptionFound', { name: status.interface.detected })
        : enabled && status?.problem === 'interface'
          ? t('network.interface.descriptionNone')
          : t('network.interface.description'),
      group: main,
      render: () => <InterfaceField label={t('network.interface.name')} />,
    },
    ...(subscriptions.length === 0
      ? [
          {
            id: 'no-subscriptions',
            setting: 'agent-network.subscriptions',
            item: { name: t('network.subscriptions.emptyTitle') },
            group: subs,
            layout: 'custom',
            render: () => (
              <RowShell>
                <EmptyRow
                  title={t('network.subscriptions.emptyTitle')}
                  hint={t('network.subscriptions.emptyHint')}
                />
              </RowShell>
            ),
          } satisfies RowDef,
        ]
      : subscriptions.map((sub): RowDef => ({
          id: `subscription-${sub.id}`,
          setting: 'agent-network.subscriptions',
          item: { name: sub.name, keywords: t('network.subscriptions.keywords') },
          group: subs,
          layout: 'custom',
          render: () => (
            <SubscriptionRow
              sub={sub}
              onRename={() => setEditing(sub)}
              onRemove={() => setRemoving(sub)}
            />
          ),
        }))),
    {
      id: 'default-node',
      setting: 'agent-network.default-node',
      description:
        running && nodes?.length === 0
          ? t('network.default.noNodes')
          : t('network.default.description'),
      group: defaults,
      render: () => <DefaultNodeControl label={t('network.default.name')} />,
    },
    ...(interfaces && interfaces.length > 0
      ? interfaces.map((item): RowDef => ({
          id: `interface-${item.name}`,
          setting: 'agent-network.interfaces',
          item: { name: item.name, keywords: t('network.interfaces.keywords') },
          group: interfaceGroup,
          layout: 'custom',
          render: () => <InterfaceRow item={item} agents={boundTo(item.name)} />,
        }))
      : [
          {
            id: 'no-interfaces',
            setting: 'agent-network.interfaces',
            group: interfaceGroup,
            layout: 'custom',
            render: () => <InterfacesEmpty />,
          } satisfies RowDef,
        ]),
    ...agents.map((agent): RowDef => ({
      id: `agent-${agent.id}`,
      setting: 'agent-network.agents',
      item: { name: agent.name, keywords: t('network.choice.keywords') },
      group: agentGroup,
      rich: <ExitLine agentId={agent.id} />,
      render: () => (
        <>
          <ExitCheckAction agentId={agent.id} />
          <NetworkChoiceSelect agentId={agent.id} label={agent.name} />
        </>
      ),
    })),
  ]
  return {
    id: 'agent-network',
    title: t('sections.agent-network'),
    description: t('pages.agent-network'),
    icon: Route01Icon,
    rows,
  }
}
