// One session in a list: its agent's avatar, its title, the project it is in and how it is doing,
// and when it last changed. Swipes and long-press come from the list that holds it.

import { memo } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import type { SessionSummary } from '@shared/agent-host'
import { folder, listTime, sessionState, sessionTitle, type SessionState } from '../sessions'
import { AgentAvatar, type AvatarBadge } from '../ui/AgentAvatar'
import { Icon } from '../ui/Icon'
import { Press } from '../ui/Press'
import { SwipeRow, type SwipeAction } from '../ui/SwipeRow'
import { Skeleton } from '../ui/Skeleton'
import {
  radius,
  size as sizes,
  space,
  type as typeScale,
  useTokens,
  type Palette,
} from '../ui/tokens'

const BADGES: Record<SessionState, AvatarBadge> = {
  waiting: 'waiting',
  error: 'error',
  live: 'live',
  auth: 'waiting',
  unread: 'unread',
}

function stateColor(c: Palette, kind: SessionState): string {
  return {
    waiting: c.warning,
    auth: c.warning,
    error: c.danger,
    live: c.success,
    unread: c.tint,
  }[kind]
}

export const SessionRow = memo(function SessionRow(props: {
  session: SessionSummary
  agentName: string | undefined
  /** The project's name as the computer names it, if known. */
  projectName: string | undefined
  /** A search hit's text, shown under the title. */
  snippet?: string
  /** What the time column shows; the last change by default. */
  time?: number
  start?: SwipeAction
  end?: SwipeAction
  /** The session open beside the list (iPad). */
  selected?: boolean
  onPress(): void
  onLongPress(): void
}) {
  const { c } = useTokens()
  const s = props.session
  const state = sessionState(s)
  const place = s.scratch ? '无项目' : (props.projectName ?? folder(s.projectPath))
  const plan = s.plan && s.plan.total > 0 ? s.plan : null

  const row = (
    <Press
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      delayLongPress={350}
      scale={false}
      accessibilityRole="button"
      accessibilityLabel={`${sessionTitle(s)}，${place}${state ? `，${state.text}` : ''}`}
      accessibilityHint="长按查看更多操作"
      accessibilityState={props.selected ? { selected: true } : undefined}
      style={[styles.row, props.selected && [styles.selected, { backgroundColor: c.fillStrong }]]}
    >
      <AgentAvatar
        size={sizes.rowAvatar}
        agentId={s.agentId}
        name={props.agentName}
        badge={state ? BADGES[state.kind] : null}
      />
      <View style={styles.body}>
        <View style={styles.titleLine}>
          {s.pinnedAt !== null && <Icon name="pin" size={13} color={c.accent} weight="semibold" />}
          <Text style={[typeScale.rowTitle, styles.title, { color: c.text }]} numberOfLines={1}>
            {sessionTitle(s)}
          </Text>
          <Text style={[typeScale.subhead, styles.time, { color: c.textTertiary }]}>
            {listTime(props.time ?? s.updatedAt)}
          </Text>
        </View>
        {props.snippet ? (
          <Text style={[typeScale.footnote, { color: c.textSecondary }]} numberOfLines={2}>
            {props.snippet}
          </Text>
        ) : null}
        <View style={styles.meta}>
          <Icon name="folder" size={13} color={c.textTertiary} />
          <Text
            style={[typeScale.footnote, styles.place, { color: c.textTertiary }]}
            numberOfLines={1}
          >
            {place}
          </Text>
          {state && (
            <Text
              style={[typeScale.footnote, { color: stateColor(c, state.kind), fontWeight: '500' }]}
              numberOfLines={1}
            >
              {state.text}
            </Text>
          )}
          {plan && !props.snippet && (
            <Text
              style={[typeScale.footnote, styles.plan, { color: c.textTertiary }]}
              numberOfLines={1}
            >
              计划 {plan.done}/{plan.total}
              {plan.current ? ` · ${plan.current.text}` : ''}
            </Text>
          )}
        </View>
      </View>
    </Press>
  )

  if (!props.start && !props.end) return row
  return (
    <SwipeRow start={props.start} end={props.end}>
      {row}
    </SwipeRow>
  )
})

const TITLE_WIDTHS = ['68%', '54%', '76%', '46%', '62%', '50%', '72%'] as const

/** Rows the shape and size of SessionRow's, while the list loads. */
export function SessionRowSkeleton(props: { count?: number }) {
  return (
    <View accessibilityLabel="正在加载">
      {Array.from({ length: props.count ?? 7 }, (_, i) => (
        <View key={i} style={styles.row}>
          <Skeleton width={sizes.rowAvatar} height={sizes.rowAvatar} radius={sizes.rowAvatar / 2} />
          <View style={styles.body}>
            <View style={[styles.titleLine, styles.skeletonLine]}>
              <View style={styles.title}>
                <Skeleton width={TITLE_WIDTHS[i % TITLE_WIDTHS.length]} height={15} />
              </View>
              <Skeleton width={52} height={12} />
            </View>
            <View style={[styles.meta, styles.skeletonMeta]}>
              <Skeleton width={13} height={11} radius={2} />
              <Skeleton width="22%" height={11} />
            </View>
          </View>
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  skeletonLine: { height: typeScale.rowTitle.lineHeight },
  skeletonMeta: { height: typeScale.footnote.lineHeight },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md + 2,
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
  },
  selected: { marginHorizontal: space.sm, paddingHorizontal: space.md, borderRadius: radius.md },
  body: { flex: 1, gap: 3 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 },
  title: { flex: 1 },
  time: { fontVariant: ['tabular-nums'], fontWeight: '400' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 },
  place: { flexShrink: 1, maxWidth: '55%' },
  plan: { flexShrink: 1 },
})
