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
import { english, type GroupDef, type RowDef, type SectionDef } from './model'
import {
  DefaultNodeControl,
  InterfaceField,
  NetworkChoiceSelect,
  NetworkState,
  NetworkSwitch,
  RefreshAllAction,
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
  const en = english()
  useAgentNetwork()
  const status = useAgentNetworkStore((s) => s.status)
  const statusError = useAgentNetworkStore((s) => s.statusError)
  const nodes = useAgentNetworkStore((s) => s.nodes)
  const enabled = useSettingsStore((s) => s.settings.agentNetwork.enabled)
  const order = useAgentsStore((s) => s.order)
  const byId = useAgentsStore((s) => s.byId)
  const agents = usableAgents(order, byId).filter((agent) => !agent.disabled)
  const [editing, setEditing] = useState<SubscriptionView | null | 'new'>(null)
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
        {subscriptions.length > 0 && <RefreshAllAction disabled={!running} />}
        <SetButton variant="ghost" onClick={() => setEditing('new')}>
          {t('network.subscriptions.add')}
        </SetButton>
      </>
    ),
    note: (
      <>
        <SubscriptionDialog
          key={editing === 'new' ? 'new' : (editing?.id ?? 'closed')}
          sub={editing === 'new' ? null : editing}
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

  const rows: RowDef[] = [
    {
      id: 'enabled',
      name: t('network.enabled.name'),
      english: en('network.enabled.name'),
      description: t('network.enabled.description'),
      keywords: t('network.enabled.keywords'),
      group: main,
      render: () => <NetworkSwitch label={t('network.enabled.name')} />,
    },
    {
      id: 'status',
      name: t('network.status.name'),
      english: en('network.status.name'),
      group: main,
      render: () => <NetworkState status={status} />,
    },
    {
      id: 'interface',
      name: t('network.interface.name'),
      english: en('network.interface.name'),
      description: status?.interface.detected
        ? t('network.interface.descriptionFound', { name: status.interface.detected })
        : enabled && status?.problem === 'interface'
          ? t('network.interface.descriptionNone')
          : t('network.interface.description'),
      keywords: t('network.interface.keywords'),
      group: main,
      render: () => <InterfaceField label={t('network.interface.name')} />,
    },
    ...(subscriptions.length === 0
      ? [
          {
            id: 'no-subscriptions',
            name: t('network.subscriptions.emptyTitle'),
            keywords: t('network.subscriptions.keywords'),
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
          name: sub.name,
          keywords: t('network.subscriptions.keywords'),
          group: subs,
          layout: 'custom',
          render: () => (
            <SubscriptionRow
              sub={sub}
              running={running}
              onRename={() => setEditing(sub)}
              onRemove={() => setRemoving(sub)}
            />
          ),
        }))),
    {
      id: 'default-node',
      name: t('network.default.name'),
      english: en('network.default.name'),
      description:
        running && nodes?.length === 0
          ? t('network.default.noNodes')
          : t('network.default.description'),
      keywords: t('network.default.keywords'),
      group: defaults,
      render: () => <DefaultNodeControl label={t('network.default.name')} />,
    },
    ...agents.map((agent): RowDef => ({
      id: `agent-${agent.id}`,
      name: agent.name,
      keywords: t('network.choice.keywords'),
      group: agentGroup,
      render: () => <NetworkChoiceSelect agentId={agent.id} label={agent.name} />,
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
