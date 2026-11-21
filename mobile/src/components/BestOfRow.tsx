// A best-of-N group (同时交给几个 Agent) in the session list: the prompt's first line, its runs'
// agents, how many are done, wait or work, or which one was kept. A tap opens it to its runs,
// which the list shows under it as session rows.

import { memo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { phaseCounts } from '@shared/session-groups'
import type { BestOf } from '../homeList'
import { AgentAvatar } from '../ui/AgentAvatar'
import { haptic } from '../ui/haptics'
import { Icon } from '../ui/Icon'
import { Press } from '../ui/Press'
import { radius, space, type as typeScale, useTokens } from '../ui/tokens'

function sameBestOf(a: { bestOf: BestOf }, b: { bestOf: BestOf }): boolean {
  const x = a.bestOf
  const y = b.bestOf
  return (
    x.open === y.open &&
    x.group.title === y.group.title &&
    x.group.kept === y.group.kept &&
    x.runs.length === y.runs.length &&
    x.runs.every((run, i) => run.session === y.runs[i]?.session)
  )
}

export const BestOfRow = memo(function BestOfRow(props: { bestOf: BestOf; onToggle: () => void }) {
  const { c } = useTokens()
  const { group, runs, open } = props.bestOf
  const counts = phaseCounts(runs.map((p) => p.session))
  const parts: { text: string; color: string }[] = []
  if (group.kept !== null) parts.push({ text: '已保留一个结果', color: c.success })
  if (counts.waiting > 0) parts.push({ text: `${counts.waiting} 个等你处理`, color: c.warning })
  if (counts.failed > 0) parts.push({ text: `${counts.failed} 个失败`, color: c.danger })
  if (counts.working > 0) parts.push({ text: `${counts.working} 个进行中`, color: c.tint })
  if (group.kept === null && counts.done > 0) {
    parts.push({ text: `${counts.done} 个完成`, color: c.textSecondary })
  }
  return (
    <Press
      onPress={() => {
        haptic.select()
        props.onToggle()
      }}
      scale={false}
      accessibilityRole="button"
      accessibilityLabel={`同时交给 ${runs.length} 个 Agent：${group.title}，${parts.map((p) => p.text).join('，')}`}
      accessibilityState={{ expanded: open }}
      accessibilityHint={open ? '点按收起' : '点按展开每个运行'}
      style={[styles.row, { backgroundColor: c.surface, borderColor: c.border }]}
    >
      <View style={styles.marks}>
        {runs.slice(0, 4).map((p, i) => (
          <View key={p.session.id} style={[styles.mark, { marginLeft: i === 0 ? 0 : -8 }]}>
            <AgentAvatar agentId={p.session.agentId} size={22} ring={c.surface} />
          </View>
        ))}
      </View>
      <View style={styles.text}>
        <Text style={[typeScale.headline, { color: c.text }]} numberOfLines={1}>
          {group.title}
        </Text>
        <Text style={[typeScale.footnote, { color: c.textTertiary }]} numberOfLines={1}>
          {`同时交给 ${runs.length} 个 Agent`}
          {parts.map((p) => (
            <Text key={p.text} style={{ color: p.color }}>
              {` · ${p.text}`}
            </Text>
          ))}
        </Text>
      </View>
      <Icon
        name={open ? 'chevronDown' : 'chevronRight'}
        size={12}
        color={c.textTertiary}
        weight="semibold"
      />
    </Press>
  )
}, sameBestOf)

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  marks: { flexDirection: 'row', alignItems: 'center' },
  mark: { borderRadius: 999 },
  text: { flex: 1, minWidth: 0, gap: 2 },
})
