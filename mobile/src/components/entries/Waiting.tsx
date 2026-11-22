// What waits for the user in a session, as the area above the composer shows it: every request the
// computer counts for the session (what its `permissionCount` and pushes count), the requests the
// desktop shows as cards in the thread but does not count, the user's own hold on an app the agent
// waits for, and the sub-sessions that wait.

import { useCallback } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import type { SessionSummary } from '@shared/agent-host'
import type { HostLink } from '@shared/remote/link'
import type { SessionView, ThreadEntry } from '@shared/thread'
import { sameItems, useHostSelector, useLink, type HostData } from '../../host'
import { needsYou, sessionTitle } from '../../sessions'
import { call } from '../../git'
import { G, Icon } from '../../ui/session/icons'
import { useSessionTokens } from '../../ui/session/palette'
import { PermissionCard } from '../PermissionCard'
import {
  BrowserOriginEntry,
  ComputerAppEntry,
  ComputerSetupEntry,
  ControlAskEntry,
  DeviceAccessEntry,
  deviceWaits,
  MemoryEntry,
  memoryWaits,
  ProblemReportEntry,
  ProjectHooksEntry,
  ProjectMcpEntry,
  useAgentName,
} from './AccessEntries'
import { AskCard, CardButton, E, useSender } from './kit'
import { MarketPublishEntry, publishWaits } from './MarketPublishEntry'
import { SecretRequestEntry, secretWaits } from './SecretRequestEntry'
import { ThemeChangeEntry, themeWaits } from './ThemeChangeEntry'

/** Whether an entry waits for the user's answer, which its card above the composer asks. */
export function waitsForUser(entry: ThreadEntry, now = Date.now()): boolean {
  switch (entry.kind) {
    case 'tool':
      return entry.permission !== null && entry.permissionResult === null
    case 'browser_origin':
    case 'computer_app':
    case 'project_mcp':
    case 'project_hooks':
      return entry.decision === null
    case 'device_access':
      return deviceWaits(entry, now)
    case 'computer_setup':
    case 'control_ask':
    case 'problem_report':
      return entry.outcome === null
    case 'memory':
      return memoryWaits(entry)
    case 'market_publish':
      return publishWaits(entry, now)
    case 'secret_request':
      return secretWaits(entry, now)
    case 'theme_change':
      return themeWaits(entry, now)
    default:
      return false
  }
}

/** The card above the composer of an entry that waits. */
export function WaitingCard(props: { entry: ThreadEntry; sessionId: string; link: HostLink }) {
  const { entry, sessionId } = props
  const place = 'dock' as const
  switch (entry.kind) {
    case 'tool':
      return <PermissionCard entry={entry} sessionId={sessionId} link={props.link} />
    case 'browser_origin':
      return <BrowserOriginEntry entry={entry} sessionId={sessionId} place={place} />
    case 'computer_app':
      return <ComputerAppEntry entry={entry} sessionId={sessionId} place={place} />
    case 'computer_setup':
      return <ComputerSetupEntry entry={entry} sessionId={sessionId} place={place} />
    case 'control_ask':
      return <ControlAskEntry entry={entry} sessionId={sessionId} place={place} />
    case 'device_access':
      return <DeviceAccessEntry entry={entry} sessionId={sessionId} place={place} />
    case 'project_mcp':
      return <ProjectMcpEntry entry={entry} sessionId={sessionId} place={place} />
    case 'project_hooks':
      return <ProjectHooksEntry entry={entry} sessionId={sessionId} place={place} />
    case 'problem_report':
      return <ProblemReportEntry entry={entry} sessionId={sessionId} place={place} />
    case 'memory':
      return <MemoryEntry entry={entry} sessionId={sessionId} place={place} />
    case 'market_publish':
      return <MarketPublishEntry entry={entry} sessionId={sessionId} place={place} />
    case 'secret_request':
      return <SecretRequestEntry entry={entry} sessionId={sessionId} place={place} />
    case 'theme_change':
      return <ThemeChangeEntry entry={entry} sessionId={sessionId} place={place} />
    default:
      return null
  }
}

/**
 * The user took over the app the session uses: the agent's calls wait until they hand it back,
 * which the phone can do as the composer's label on the computer does.
 */
export function HandBackCard(props: { sessionId: string; session: SessionView | undefined }) {
  const link = useLink()
  const agent = useAgentName(props.sessionId)
  const sender = useSender()
  const computer = props.session?.computer
  if (computer?.control !== 'you') return null
  const app = computer.app ?? '电脑'
  return (
    <AskCard
      icon={E.cursor}
      title={`你接管了 ${app} · ${agent} 在等`}
      body={`等你交还 ${app}。交还后 ${agent} 接着用它；停止则这一轮不再用电脑。`}
      sender={sender}
      actions={[
        {
          key: 'stop',
          label: '停止',
          tone: 'danger',
          run: () => call(link, 'computer.stop', { sessionId: props.sessionId }),
        },
        {
          key: 'handBack',
          label: '交还',
          tone: 'primary',
          run: () => call(link, 'computer.handBack', { sessionId: props.sessionId }),
        },
      ]}
    />
  )
}

/** The sessions under this one, at any depth, that wait for the user. */
export function waitingBelow(id: string, sessions: Map<string, SessionSummary>): SessionSummary[] {
  const found: SessionSummary[] = []
  const walk = (parent: string, depth: number) => {
    if (depth > 8) return
    for (const s of sessions.values()) {
      if (s.parentId !== parent) continue
      if (needsYou(s)) found.push(s)
      walk(s.id, depth + 1)
    }
  }
  walk(id, 0)
  return found
}

/** `waitingBelow` from the store; changes only when the list it gives does. */
export function useWaitingBelow(id: string): SessionSummary[] {
  return useHostSelector(
    useCallback((d: HostData) => waitingBelow(id, d.sessions), [id]),
    sameItems,
  )
}

/** Sub-sessions that wait for the user: a row each that opens it, where its card is. */
export function WaitingChildren(props: { sessionId: string }) {
  const { c, s } = useSessionTokens()
  const waiting = useWaitingBelow(props.sessionId)
  if (waiting.length === 0) return null
  return (
    <View style={{ gap: 8 }}>
      {waiting.map((child) => (
        <View
          key={child.id}
          style={[styles.child, { backgroundColor: s.dockCard, borderColor: c.borderStrong }]}
        >
          <View style={[styles.badge, { backgroundColor: s.warningSoft }]}>
            <Icon icon={G.subagent} size={14} color={c.warning} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>
              {sessionTitle(child)}
            </Text>
            <Text style={[styles.sub, { color: c.textSecondary }]}>
              {child.origin === 'subagent' ? '子 Agent' : '子会话'}在等你处理
              {child.permissionCount > 1 ? ` ${child.permissionCount} 项` : ''}
            </Text>
          </View>
          <CardButton
            label="去处理"
            tone="primary"
            onPress={() => router.push(`/session/${child.id}`)}
          />
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  child: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 18,
    padding: 12,
  },
  badge: { width: 28, height: 28, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 15, fontWeight: '600' },
  sub: { fontSize: 13, marginTop: 1 },
})
