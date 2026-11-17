// The line under the composer: the computer with its system and whether the link is up, the
// session's folder, which opens its changes, and how much of the plan's windows is used.

import { Pressable, StyleSheet, Text, View } from 'react-native'
import Svg, { Circle } from 'react-native-svg'
import type { PlanLimit } from '@shared/agent-host'
import type { LinkState } from '@shared/remote/link'
import { G, Icon, SystemMark } from './icons'
import { useSessionTokens } from './palette'

export function UsageRing(props: { percent: number; color: string; track: string; size?: number }) {
  const size = props.size ?? 14
  const stroke = 2.4
  const r = (size - stroke) / 2
  const length = 2 * Math.PI * r
  const shown = Math.min(100, Math.max(0, props.percent))
  return (
    <Svg width={size} height={size} style={{ transform: [{ rotate: '-90deg' }] }}>
      <Circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={props.track}
        strokeWidth={stroke}
        fill="none"
      />
      {shown > 0 && (
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={props.color}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${(length * shown) / 100} ${length}`}
        />
      )}
    </Svg>
  )
}

const WINDOW_NAMES: Record<string, string> = {
  five_hour: '5 小时',
  seven_day: '7 天',
  seven_day_opus: '7 天 Opus',
  seven_day_sonnet: '7 天 Sonnet',
}

/** The windows worth a ring: the plan's own ones first, at most two. */
function shownLimits(limits: PlanLimit[]): PlanLimit[] {
  const known = limits.filter((l) => l.usedPercent !== null)
  const rank = (l: PlanLimit) =>
    l.window === 'seven_day' ? 0 : l.window === 'five_hour' ? 1 : l.models ? 3 : 2
  return [...known].sort((a, b) => rank(a) - rank(b)).slice(0, 2)
}

export function StatusLine(props: {
  hostName: string
  platform: string | null
  state: LinkState
  folder: string | null
  /** Files changed in the folder, when known. */
  changed?: number
  onFolderPress?: () => void
  limits?: PlanLimit[]
}) {
  const { c } = useSessionTokens()
  const dot =
    props.state.kind === 'connected'
      ? c.success
      : props.state.kind === 'stopped'
        ? c.danger
        : c.warning
  const limits = shownLimits(props.limits ?? [])
  return (
    <View style={styles.row}>
      <View style={styles.host}>
        <View>
          <SystemMark platform={props.platform} color={c.textSecondary} size={14} />
          <View style={[styles.dot, { backgroundColor: dot, borderColor: c.bg }]} />
        </View>
        <Text style={[styles.text, { color: c.textSecondary }]} numberOfLines={1}>
          {props.hostName}
        </Text>
      </View>
      {props.folder !== null && (
        <>
          <Text style={[styles.text, { color: c.textTertiary }]}>/</Text>
          <Pressable
            onPress={props.onFolderPress}
            disabled={!props.onFolderPress}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={
              props.changed ? `${props.folder}，${props.changed} 个文件有改动` : props.folder
            }
            style={({ pressed }) => [styles.folder, { opacity: pressed ? 0.55 : 1 }]}
          >
            <Icon icon={G.folder} size={14} color={c.tint} />
            <Text style={[styles.text, { color: c.textSecondary }]} numberOfLines={1}>
              {props.folder}
            </Text>
            {props.changed ? (
              <View style={[styles.badge, { backgroundColor: c.fillStrong }]}>
                <Text style={[styles.badgeText, { color: c.text }]}>{props.changed}</Text>
              </View>
            ) : null}
          </Pressable>
        </>
      )}
      <View style={{ flex: 1 }} />
      {limits.map((limit) => {
        const percent = Math.round(limit.usedPercent ?? 0)
        const color =
          limit.state === 'reached' || percent >= 95
            ? c.danger
            : limit.state === 'warning' || percent >= 80
              ? c.warning
              : c.tint
        return (
          <View
            key={limit.window}
            style={styles.limit}
            accessibilityLabel={`${limit.label} 已用 ${percent}%`}
          >
            <UsageRing percent={percent} color={color} track={c.fillStrong} />
            <Text style={[styles.text, { color: c.textSecondary }]} numberOfLines={1}>
              {WINDOW_NAMES[limit.window] ? `${WINDOW_NAMES[limit.window]} ` : ''}
              {percent}%
            </Text>
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 9,
    paddingBottom: 3,
    minHeight: 30,
  },
  host: { flexDirection: 'row', alignItems: 'center', gap: 7, flexShrink: 1 },
  dot: {
    position: 'absolute',
    top: -3,
    right: -3,
    width: 7,
    height: 7,
    borderRadius: 3.5,
    borderWidth: 1,
  },
  text: { fontSize: 13, lineHeight: 17, fontWeight: '500', fontVariant: ['tabular-nums'] },
  folder: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1 },
  badge: { borderRadius: 999, paddingHorizontal: 6, minWidth: 18, alignItems: 'center' },
  badgeText: { fontSize: 11, lineHeight: 16, fontWeight: '600', fontVariant: ['tabular-nums'] },
  limit: { flexDirection: 'row', alignItems: 'center', gap: 5 },
})
