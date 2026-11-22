// Huli: above a manager session's composer on the phone: how many workers work and wait, the way
// to the 工人 screen and 全部停止. It reads the manager's summary alone.

import { useState } from 'react'
import { Alert, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import type { SessionSummary } from '@shared/agent-host'
import { useLink } from '../host'
import { errorText } from '../sessions'
import { haptic } from '../ui/session/feedback'
import { G, Icon } from '../ui/session/icons'
import { useSessionTokens } from '../ui/session/palette'
import { PressScale } from '../ui/session/Press'
import { CardButton } from './entries/kit'

export function managerLine(manager: NonNullable<SessionSummary['manager']>): string {
  if (manager.stopped) return '已全部停止'
  const parts = [
    manager.paused
      ? `已暂停 · ${manager.working} 个工人在干活`
      : manager.working > 0
        ? `${manager.working} 个工人在干活`
        : '没有工人在干活',
  ]
  if (manager.waiting > 0) parts.push(`${manager.waiting} 个等你批准`)
  if (manager.held > 0) parts.push(`${manager.held} 个排队`)
  return parts.join(' · ')
}

export function ManagerBanner(props: { summary: SessionSummary }) {
  const { c, s } = useSessionTokens()
  const link = useLink()
  const [stopping, setStopping] = useState(false)
  const manager = props.summary.manager
  if (!manager) return null
  const busy =
    manager.working > 0 ||
    props.summary.status === 'running' ||
    props.summary.status === 'awaiting_permission'
  const stop = () => {
    haptic.firm()
    setStopping(true)
    link
      .request('manager.stopAll', { sessionId: props.summary.id })
      .catch((error: unknown) => Alert.alert('没能全部停止', errorText(error)))
      .finally(() => setStopping(false))
  }
  return (
    <View style={[styles.card, { backgroundColor: s.dockCard, borderColor: c.borderStrong }]}>
      <PressScale
        scale={0.98}
        outerStyle={styles.outer}
        style={styles.main}
        onPress={() => router.push(`/workers/${props.summary.id}`)}
        accessibilityRole="button"
        accessibilityLabel={`工人：${managerLine(manager)}`}
      >
        <View
          style={[
            styles.badge,
            { backgroundColor: manager.waiting > 0 ? s.warningSoft : s.accentSoft },
          ]}
        >
          <Icon icon={G.subagent} size={14} color={manager.waiting > 0 ? c.warning : c.accent} />
        </View>
        <Text style={[styles.text, { color: c.text }]} numberOfLines={1}>
          {managerLine(manager)}
        </Text>
      </PressScale>
      {busy && <CardButton label="全部停止" tone="danger" busy={stopping} onPress={stop} />}
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 12,
    marginBottom: 8,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 18,
  },
  // The pressable takes the row's room; the view inside it lays out the badge and the line.
  outer: { flex: 1, minWidth: 0 },
  main: { flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 0 },
  badge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { flex: 1, fontSize: 14.5, fontWeight: '500' },
})
