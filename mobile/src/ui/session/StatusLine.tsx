// The line under the composer: the computer with its system and whether the link is up, the
// session's folder, which opens its changes (or, in New session, the project picker), the branch
// it is on, how much of the plan's tightest window is used, which opens the plan's usage, and how
// full the context is, which opens what fills it.

import type { RefObject } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import Svg, { Circle } from 'react-native-svg'
import type { PlanLimit } from '@shared/agent-host'
import type { LinkState } from '@shared/remote/link'
import { G, Icon, SystemMark } from './icons'
import type { ViewHandle } from './Popover'
import {
  backText,
  isExhausted,
  limitColor,
  limitTextColor,
  shownLimit,
  windowName,
  windowShort,
} from './limits'
import { useSessionTokens } from './palette'

export function UsageRing(props: {
  percent: number
  color: string
  track: string
  size?: number
  stroke?: number
}) {
  const size = props.size ?? 14
  const stroke = props.stroke ?? 2.4
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

/**
 * A pie on a disc tinted in its color: a filling wedge, which cannot read as a spinner as a short
 * arc can, and the disc shows how much is left.
 */
export function PieRing(props: { share: number; color: string; size?: number }) {
  const size = props.size ?? 15
  const r = size / 4
  const length = 2 * Math.PI * r
  const used = Math.min(1, Math.max(0, props.share))
  return (
    <Svg width={size} height={size} style={{ transform: [{ rotate: '-90deg' }] }}>
      <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={props.color} opacity={0.22} />
      {used > 0 && (
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={props.color}
          strokeWidth={r * 2}
          strokeDasharray={`${used * length} ${length}`}
        />
      )}
    </Svg>
  )
}

export function StatusLine(props: {
  hostName: string
  platform: string | null
  state: LinkState
  folder: string | null
  /** Files changed in the folder, when known. */
  changed?: number
  onFolderPress?: () => void
  /** The folder opens a picker: a chevron says so. */
  folderPicker?: boolean
  folderAnchor?: RefObject<ViewHandle | null>
  /** The branch the folder is on; `loading` while it is read, null outside a repository. */
  branch?: string | null | 'loading'
  limits?: PlanLimit[]
  /** The plan ring opens the plan's usage. */
  onLimitPress?: () => void
  /** The context's share used, which opens its breakdown. */
  context?: { share: number; color: string; approximate: boolean; onPress(): void } | null
}) {
  const { c, s } = useSessionTokens()
  const dot =
    props.state.kind === 'connected'
      ? c.success
      : props.state.kind === 'stopped'
        ? c.danger
        : c.warning
  const now = Date.now()
  const limit = shownLimit(props.limits ?? [], now)
  const out = !!limit && isExhausted(limit, now)
  const percent = out ? 100 : Math.round(limit?.usedPercent ?? 0)
  const connection =
    props.state.kind === 'connected'
      ? '已连接'
      : props.state.kind === 'stopped'
        ? '已断开'
        : '正在连接'
  return (
    <View style={styles.row}>
      <View style={styles.host} accessibilityLabel={`${props.hostName}，${connection}`}>
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
          <View ref={props.folderAnchor} collapsable={false} style={styles.folderBox}>
            <Pressable
              onPress={props.onFolderPress}
              disabled={!props.onFolderPress}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={
                props.folderPicker
                  ? `项目：${props.folder}，点按换一个`
                  : props.changed
                    ? `${props.folder}，${props.changed} 个文件有改动`
                    : props.folder
              }
              style={({ pressed }) => [styles.folder, { opacity: pressed ? 0.55 : 1 }]}
            >
              <Icon icon={G.folder} size={14} color={c.tint} />
              <Text style={[styles.text, { color: c.textSecondary }]} numberOfLines={1}>
                {props.folder}
              </Text>
              {props.folderPicker ? (
                <Icon icon={G.upDown} size={10} color={c.textTertiary} weight="semibold" />
              ) : props.changed ? (
                <View style={[styles.badge, { backgroundColor: c.fillStrong }]}>
                  <Text style={[styles.badgeText, { color: c.text }]}>{props.changed}</Text>
                </View>
              ) : null}
            </Pressable>
          </View>
        </>
      )}
      <View style={{ flex: 1 }} />
      {props.branch !== undefined && props.branch !== null && (
        <View
          style={styles.branch}
          accessibilityLabel={`分支：${props.branch === 'loading' ? '正在读取' : props.branch}`}
        >
          <Icon icon={G.fork} size={13} color={c.textTertiary} />
          {props.branch === 'loading' ? (
            <Text style={[styles.text, { color: c.textTertiary }]}>正在读取…</Text>
          ) : (
            <Text style={[styles.text, { color: c.textSecondary }]} numberOfLines={1}>
              {props.branch}
            </Text>
          )}
        </View>
      )}
      {limit && (
        <Pressable
          onPress={props.onLimitPress}
          disabled={!props.onLimitPress}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={
            out
              ? `${windowName(limit)}限额已用完，${backText(limit.resetsAt, now)}，查看套餐用量`
              : `${windowName(limit)}限额已用 ${percent}%，查看套餐用量`
          }
          style={({ pressed }) => [
            styles.limit,
            out && [styles.out, { backgroundColor: s.dangerSoft }],
            { opacity: pressed ? 0.55 : 1 },
          ]}
        >
          <UsageRing percent={percent} color={limitColor(limit, c)} track={c.fillStrong} />
          {out ? (
            <Text style={[styles.text, styles.outText, { color: c.danger }]} numberOfLines={1}>
              {windowShort(limit)}已用完 · {backText(limit.resetsAt, now)}
            </Text>
          ) : (
            <Text style={[styles.text, { color: c.textSecondary }]} numberOfLines={1}>
              <Text style={{ color: c.textTertiary }}>{windowShort(limit)} </Text>
              <Text style={{ color: limitTextColor(limit, c, c.textSecondary) }}>{percent}%</Text>
            </Text>
          )}
        </Pressable>
      )}
      {props.context && (
        <Pressable
          onPress={props.context.onPress}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={`上下文已用 ${Math.round(props.context.share * 100)}%，查看构成`}
          style={({ pressed }) => [styles.limit, { opacity: pressed ? 0.55 : 1 }]}
        >
          <PieRing share={props.context.share} color={props.context.color} />
          <Text style={[styles.text, { color: c.textSecondary }]}>
            {props.context.approximate ? '≈' : ''}
            {Math.round(props.context.share * 100)}%
          </Text>
        </Pressable>
      )}
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
  folderBox: { flexShrink: 1 },
  folder: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1 },
  badge: { borderRadius: 999, paddingHorizontal: 6, minWidth: 18, alignItems: 'center' },
  badgeText: { fontSize: 11, lineHeight: 16, fontWeight: '600', fontVariant: ['tabular-nums'] },
  limit: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  out: { borderRadius: 999, paddingLeft: 4, paddingRight: 8, paddingVertical: 2, flexShrink: 1 },
  outText: { fontWeight: '600', flexShrink: 1 },
  branch: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1, maxWidth: 150 },
})
