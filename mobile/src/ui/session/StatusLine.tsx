// The line under the composer: the computer with its system and whether the link is up, the
// session's folder, which opens its changes (or, in New session, the project picker) and shows its
// whole path on a long press, the branch it is on with the worktree's mark, how much of the plan's
// tightest window is used, which opens the plan's usage, how long the prompt cache has left, and how
// full the context is, both of which open what fills it.

import { useState, type RefObject } from 'react'
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import Svg, { Circle } from 'react-native-svg'
import type { PlanLimit } from '@shared/agent-host'
import { cachePhase, endingWindow, type KnownExpiry } from '@shared/prompt-cache'
import type { LinkState } from '@shared/remote/link'
import { showNotice } from '../NoticeBar'
import { copyText } from './feedback'
import { G, Icon, SystemMark } from './icons'
import { cacheLeftText, useCacheLeft } from './promptCache'
import type { ViewHandle } from './Popover'
import {
  backText,
  inlineReset,
  isExhausted,
  limitColor,
  limitTextColor,
  shownLimit,
  windowName,
  windowShort,
} from './limits'
import { useSessionTokens } from './palette'
import { useTicking } from './ticking'

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
  /** The session works in a worktree of its own: the branch carries its mark. */
  worktree?: boolean
  /** The folder's whole path, which a long press on the folder shows and copies. */
  path?: string | null
  limits?: PlanLimit[]
  /** The plan ring opens the plan's usage. */
  onLimitPress?: () => void
  /** The context's share used, which opens its breakdown. */
  context?: { share: number; color: string; approximate: boolean; onPress(): void } | null
  /** The prompt cache's time left, which opens the context's breakdown with its cache. */
  cache?: { expiry: KnownExpiry; onPress(): void } | null
}) {
  const { c, s } = useSessionTokens()
  const path = props.path ?? null
  const dot =
    props.state.kind === 'connected'
      ? c.success
      : props.state.kind === 'stopped'
        ? c.danger
        : c.warning
  // Counts down while the line says when the window resets.
  const near = shownLimit(props.limits ?? [])
  const counting = !!near && inlineReset(near) !== null
  const ticked = useTicking(counting)
  const now = counting ? ticked : Date.now()
  const limit = shownLimit(props.limits ?? [], now)
  const out = !!limit && isExhausted(limit, now)
  const percent = out ? 100 : Math.round(limit?.usedPercent ?? 0)
  const reset = limit ? inlineReset(limit, now) : null
  // When the line runs short the limit's reset time goes first, then the computer's and the
  // folder's names give way; the limit itself never does, as a cut 88% reads as 88. The reset
  // time stays while the line has room to spare, which it has none of once a name is cut, and
  // comes back once the room it needs is spare again.
  const [resetWidth, setResetWidth] = useState(0)
  const [spare, setSpare] = useState<number | null>(null)
  const [resetShown, setResetShown] = useState(true)
  const suffix = reset ? ` · ${reset}` : ''
  const showReset =
    !!suffix &&
    (resetShown ? spare === null || spare >= 0.5 : spare !== null && spare >= resetWidth + 4)
  if (showReset !== resetShown && suffix && resetWidth > 0) setResetShown(showReset)
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
        <Text style={[styles.text, styles.shrink, { color: c.textSecondary }]} numberOfLines={1}>
          {props.hostName}
        </Text>
      </View>
      {props.folder !== null && (
        <>
          <Text style={[styles.text, { color: c.textTertiary }]}>/</Text>
          <View ref={props.folderAnchor} collapsable={false} style={styles.folderBox}>
            <Pressable
              onPress={props.onFolderPress}
              {...(path
                ? {
                    onLongPress: () =>
                      Alert.alert(props.folder ?? '项目', path, [
                        {
                          text: '复制路径',
                          onPress: () =>
                            void copyText(path).then(() =>
                              showNotice({ text: '已复制', tone: 'success' }),
                            ),
                        },
                        { text: '好', style: 'cancel' },
                      ]),
                    delayLongPress: 400,
                    accessibilityHint: '长按查看完整路径',
                  }
                : {})}
              disabled={!props.onFolderPress && !path}
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
              <Text
                style={[styles.text, styles.shrink, styles.folderName, { color: c.textSecondary }]}
                numberOfLines={1}
              >
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
      <View style={styles.spacer} onLayout={(event) => setSpare(event.nativeEvent.layout.width)} />
      {props.branch !== undefined && props.branch !== null && (
        <View
          style={styles.branch}
          accessibilityLabel={
            props.branch === 'loading'
              ? '分支：正在读取'
              : props.worktree
                ? `在分支 ${props.branch} 的 worktree 里工作`
                : `分支：${props.branch}`
          }
        >
          <Icon
            icon={props.worktree ? G.fork : G.branch}
            size={13}
            color={props.worktree ? c.tint : c.textTertiary}
          />
          {props.branch === 'loading' ? (
            // An ellipsis rather than words: the line is full on every phone, and the branch is the
            // last thing to give room to while it is still unknown.
            <Text style={[styles.text, { color: c.textTertiary }]} numberOfLines={1}>
              …
            </Text>
          ) : (
            <Text
              style={[styles.text, styles.shrink, { color: c.textSecondary }]}
              numberOfLines={1}
            >
              {props.branch}
            </Text>
          )}
          {props.worktree && props.branch !== 'loading' ? (
            <View style={[styles.mark, { backgroundColor: c.tintSoft }]}>
              <Text style={[styles.markText, { color: c.tint }]}>工作树</Text>
            </View>
          ) : null}
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
              ? `${windowName(limit)}限额已用完，${reset ?? backText(limit.resetsAt, now)}，查看套餐用量`
              : `${windowName(limit)}限额已用 ${percent}%${reset ? `，${reset}` : ''}，查看套餐用量`
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
              {windowShort(limit)}已用完 · {reset ?? backText(limit.resetsAt, now)}
            </Text>
          ) : (
            <>
              <Text style={[styles.text, { color: c.textSecondary }]} numberOfLines={1}>
                <Text style={{ color: c.textTertiary }}>{windowShort(limit)} </Text>
                <Text style={{ color: limitTextColor(limit, c, c.textSecondary) }}>{percent}%</Text>
              </Text>
              {suffix ? (
                <Text
                  style={[styles.text, styles.measure]}
                  onLayout={(event) => setResetWidth(event.nativeEvent.layout.width)}
                  accessibilityElementsHidden
                  importantForAccessibility="no-hide-descendants"
                >
                  {suffix}
                </Text>
              ) : null}
              {suffix && resetShown ? (
                <Text
                  style={[
                    styles.text,
                    styles.reset,
                    { color: limitTextColor(limit, c, c.textSecondary) },
                  ]}
                  numberOfLines={1}
                >
                  {suffix}
                </Text>
              ) : null}
            </>
          )}
        </Pressable>
      )}
      {props.cache && <CacheChip expiry={props.cache.expiry} onPress={props.cache.onPress} />}
      {props.context && (
        <Pressable
          onPress={props.context.onPress}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={`上下文已用 ${Math.round(props.context.share * 100)}%，查看构成`}
          style={({ pressed }) => [styles.chip, { opacity: pressed ? 0.55 : 1 }]}
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

/** The prompt cache's countdown; it ticks alone, so the screen around it does not. */
function CacheChip(props: { expiry: KnownExpiry; onPress(): void }) {
  const { c } = useSessionTokens()
  const { expiry } = props
  const left = useCacheLeft(expiry.expiresAt)
  const phase = cachePhase(expiry.expiresAt, endingWindow(expiry.ttl), expiry.expiresAt - left)
  const time = `${expiry.estimate ? '约 ' : ''}${cacheLeftText(left)}`
  return (
    <Pressable
      onPress={props.onPress}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={`Prompt cache：${
        phase === 'expired' ? (expiry.estimate ? '可能已过期' : '已过期') : `剩余 ${time}`
      }`}
      style={({ pressed }) => [styles.chip, { opacity: pressed ? 0.55 : 1 }]}
    >
      <Icon
        icon={G.timer}
        size={13}
        color={phase === 'expired' ? c.textTertiary : phase === 'ending' ? c.warning : c.tint}
      />
      <Text style={[styles.text, { color: phase === 'ending' ? c.warning : c.textSecondary }]}>
        {phase === 'expired' ? '已过期' : time}
      </Text>
    </Pressable>
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
  // Each part clips what it cannot fit rather than run under the next one.
  host: { flexDirection: 'row', alignItems: 'center', gap: 7, flexShrink: 1, overflow: 'hidden' },
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
  // A name cut short inside its row, so it never runs under the / after it.
  shrink: { flexShrink: 1 },
  // Shrinking with the computer's longer name, a short folder name would be cut to nothing.
  folderName: { minWidth: 24 },
  folderBox: { flexShrink: 1, overflow: 'hidden' },
  folder: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1 },
  badge: { borderRadius: 999, paddingHorizontal: 6, minWidth: 18, alignItems: 'center' },
  badgeText: { fontSize: 11, lineHeight: 16, fontWeight: '600', fontVariant: ['tabular-nums'] },
  limit: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 0 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  spacer: { flexGrow: 1, flexShrink: 0 },
  reset: { marginLeft: -5 },
  measure: { position: 'absolute', opacity: 0, left: 0, top: 0 },
  // A used-up limit's words are long; they end in its reset time, which may be cut.
  out: {
    borderRadius: 999,
    paddingLeft: 4,
    paddingRight: 8,
    paddingVertical: 2,
    flexShrink: 1,
    overflow: 'hidden',
  },
  outText: { fontWeight: '600', flexShrink: 1 },
  branch: { flexDirection: 'row', alignItems: 'center', gap: 5, flexShrink: 1, maxWidth: 190 },
  mark: { borderRadius: 999, paddingHorizontal: 5 },
  markText: { fontSize: 10, lineHeight: 15, fontWeight: '600' },
})
