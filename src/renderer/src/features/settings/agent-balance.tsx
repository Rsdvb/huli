// Settings > Agents: the balance a harness bills from instead of a plan, DeepSeek Harness's on its
// account sign-in or an API key, where an agent with a plan shows its usage.

import { useState } from 'react'
import { RefreshIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { AgentStatus } from '@shared/agent-host'
import { useRefresh } from '@renderer/components/refresh'
import { mediumAgo, planBalance } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import { useNow } from '@renderer/lib/use-now'
import { useHostScope } from '@renderer/stores/host-scope'
import { IconAction } from './controls'
import { GroupLabel, RowFrame, RowGroup, RowText } from './rows'

/** Whether the agent signs in on a route whose balance its vendor keeps. */
function billed(status: AgentStatus): boolean {
  const kind = status.account?.kind
  return status.signIn === 'signed-in' && (kind === 'external' || kind === 'api_key')
}

export function BalanceGroup({ status, reading }: { status: AgentStatus; reading: boolean }) {
  const { request } = useHostScope()
  const { t } = useTranslation('settings')
  const now = useNow()
  const refresh = useRefresh()
  const [refreshError, setRefreshError] = useState<string | null>(null)
  const usage = status.balance ?? null
  const balances = usage?.balances ?? []
  const signedIn = billed(status)
  const failed = usage?.state === 'error' ? usage.error : null
  const observedAt = balances.length > 0 ? (usage?.observedAt ?? 0) : 0
  const actions = signedIn ? (
    <>
      {observedAt > 0 && (
        <span className="k-muted">
          {t('agents.usageUpdated', { ago: mediumAgo(observedAt, now) })}
        </span>
      )}
      <IconAction
        label={t('agents.balance.refresh')}
        icon={RefreshIcon}
        busy={refresh.phase === 'turning'}
        onClick={() => {
          setRefreshError(null)
          void refresh
            .run(() => request('agents.refreshLimits', { agentId: status.id, force: true }))
            .catch((e: unknown) => setRefreshError(errorMessage(e)))
        }}
      />
    </>
  ) : undefined
  const empty =
    !signedIn && status.account?.kind === 'gateway'
      ? t('agents.balance.gateway')
      : !signedIn
        ? t('agents.balance.afterSignIn', { name: status.name })
        : reading || usage === null
          ? t('agents.balance.reading')
          : null
  return (
    <section className="k-group" aria-label={t('agents.usage')}>
      <GroupLabel group={{ id: 'usage', label: t('agents.usage'), actions }} />
      {balances.length > 0 ? (
        <RowGroup>
          {balances.map((balance) => (
            <RowFrame
              key={`${balance.label}/${balance.currency}`}
              text={
                <RowText
                  name={
                    balances.length > 1
                      ? t('agents.balance.nameIn', { currency: balance.currency })
                      : t('agents.balance.name')
                  }
                  description={
                    balance.granted
                      ? t('agents.balance.granted', {
                          amount: planBalance(balance.granted, balance.currency),
                        })
                      : undefined
                  }
                />
              }
            >
              <span className="k-figure" data-selectable="">
                {planBalance(balance.amount, balance.currency)}
              </span>
            </RowFrame>
          ))}
        </RowGroup>
      ) : (
        !failed && empty && <p className="k-reading">{empty}</p>
      )}
      {usage?.stale && !failed && !refreshError && balances.length > 0 && (
        <p className="ui-sg-hint" data-wrap="">
          {t('agents.balance.kept')}
        </p>
      )}
      {(refreshError ?? failed) && (
        <p className="ui-sg-hint k-error" data-wrap="">
          {refreshError ??
            (observedAt > 0
              ? `${failed} ${t('agents.balance.stale', { ago: mediumAgo(observedAt, now) })}`
              : failed)}
        </p>
      )}
    </section>
  )
}
