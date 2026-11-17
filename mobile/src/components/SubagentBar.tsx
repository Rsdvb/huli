// In place of the composer for a sub-agent's session, as the desktop's subagent-bar.tsx: the agent
// drives it, so the phone can only read it, stop it while it runs, or go to the session it runs for.
// The card sits where the composer's would, the line under it where the composer's status line is,
// with how full the context is on its right.

import { useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import type { SessionSummary } from '@shared/agent-host'
import type { SessionView } from '@shared/thread'
import { useConnected, useLink, useSession } from '../host'
import { Glass, useGlassMode } from '../ui/Glass'
import { haptic } from '../ui/session/feedback'
import { AgentGlyph, G, Icon } from '../ui/session/icons'
import { useSessionTokens } from '../ui/session/palette'
import { PressScale } from '../ui/session/Press'
import { PieRing } from '../ui/session/StatusLine'
import { composerBottom } from './Composer'

const RADIUS = 30

export function SubagentBar(props: {
  summary: SessionSummary
  session: SessionView | undefined
  agentName: string
  bottomInset: number
  /** How full the context is, which opens its breakdown. */
  context: { share: number; color: string; approximate: boolean; onPress(): void } | null
  onOpenParent(id: string): void
}) {
  const { c, s } = useSessionTokens()
  const liquid = useGlassMode() === 'liquid'
  const link = useLink()
  const { summary } = props
  const parent = useSession(summary.parentId)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const running = summary.status === 'running' || summary.status === 'awaiting_permission'
  const canStop = running && !!props.session?.subagent?.canCancel
  const connected = useConnected()

  const stop = () => {
    haptic.firm()
    setStopping(true)
    setError(null)
    link
      .request('sessions.cancel', { sessionId: summary.id })
      .catch((failed: { message?: string }) => setError(failed?.message || '没能停止'))
      .finally(() => setStopping(false))
  }

  const Tray = liquid ? Glass : View
  return (
    <View style={[styles.outer, { paddingBottom: composerBottom(props.bottomInset) }]}>
      <Tray
        {...(liquid ? { radius: RADIUS } : {})}
        style={[styles.tray, !liquid && { backgroundColor: s.dock, borderColor: c.border }]}
      >
        <View
          style={[
            styles.card,
            liquid
              ? { borderColor: c.border }
              : { backgroundColor: s.dockCard, borderColor: c.border },
          ]}
        >
          <View>
            <AgentGlyph agentId={summary.agentId} size={20} />
            {running && <View style={[styles.dot, { backgroundColor: c.success }]} />}
          </View>
          <Text style={[styles.agent, { color: c.text }]} numberOfLines={1}>
            {props.agentName}
            <Text style={{ color: c.textTertiary }}> · </Text>
            <Text style={[styles.readOnly, { color: c.textTertiary }]}>只读</Text>
          </Text>
          {canStop && (
            <PressScale
              onPress={stop}
              disabled={stopping || !connected}
              accessibilityRole="button"
              accessibilityLabel="停止这个子 Agent"
              style={[
                styles.stop,
                { backgroundColor: s.dangerSoft, opacity: stopping || !connected ? 0.6 : 1 },
              ]}
            >
              {stopping ? (
                <ActivityIndicator size="small" color={c.danger} />
              ) : (
                <Icon icon={G.stop} size={12} color={c.danger} />
              )}
              <Text style={[styles.stopText, { color: c.danger }]}>停止</Text>
            </PressScale>
          )}
        </View>
        <View style={styles.line}>
          <Pressable
            onPress={parent ? () => props.onOpenParent(parent.id) : undefined}
            disabled={!parent}
            hitSlop={8}
            accessibilityRole={parent ? 'button' : undefined}
            accessibilityLabel={parent ? `返回 ${parent.title || '父会话'}` : undefined}
            style={({ pressed }) => [styles.parent, { opacity: pressed ? 0.55 : 1 }]}
          >
            <Icon icon={G.child} size={13} color={c.textTertiary} />

            <Text style={[styles.text, { color: c.textTertiary }]} numberOfLines={1}>
              为{' '}
              <Text style={{ color: c.textSecondary, fontWeight: '600' }}>
                {parent?.title || '父会话'}
              </Text>{' '}
              运行
            </Text>
          </Pressable>
          {props.context && (
            <Pressable
              onPress={props.context.onPress}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={`上下文已用 ${Math.round(props.context.share * 100)}%，查看构成`}
              style={({ pressed }) => [styles.ring, { opacity: pressed ? 0.55 : 1 }]}
            >
              <PieRing share={props.context.share} color={props.context.color} />
              <Text style={[styles.text, { color: c.textSecondary }]}>
                {props.context.approximate ? '≈' : ''}
                {Math.round(props.context.share * 100)}%
              </Text>
            </Pressable>
          )}
        </View>
        {error && (
          <Text style={[styles.error, { color: c.danger }]} numberOfLines={2} selectable>
            {error}
          </Text>
        )}
      </Tray>
    </View>
  )
}

const styles = StyleSheet.create({
  outer: { paddingHorizontal: 10, paddingTop: 6 },
  tray: {
    borderRadius: RADIUS,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 4,
    paddingBottom: 6,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 56,
    borderRadius: 26,
    borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: 16,
    paddingRight: 8,
  },
  dot: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  agent: { flex: 1, fontSize: 16, fontWeight: '500' },
  readOnly: { fontSize: 15, fontWeight: '400' },
  stop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 40,
    borderRadius: 20,
    paddingHorizontal: 16,
  },
  stopText: { fontSize: 15, fontWeight: '600' },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 9,
    paddingBottom: 3,
    minHeight: 30,
  },
  parent: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
  ring: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  text: { fontSize: 13, lineHeight: 17, fontWeight: '500', flexShrink: 1 },
  error: { fontSize: 12, paddingHorizontal: 16, paddingTop: 2 },
})
