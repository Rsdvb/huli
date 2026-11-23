// A review's findings on the file a diff shows, as the desktop's Files pane has them
// (src/renderer/src/features/review): the rows they sit on carry a bar of their severity's color,
// and a card over the diff steps from one to the next, with 让 Agent 修 and 忽略. The review lives
// with the session's thread on the computer, read here through `sessions.review`.

import { useCallback, useMemo, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { Alert, StyleSheet, Text, View } from 'react-native'
import type { HostLink } from '@shared/remote/link'
import {
  placeFinding,
  shownFindings,
  type ReviewAction,
  type ReviewFinding,
  type ReviewRun,
  type ReviewSeverity,
} from '@shared/review'
import type { Diff } from '../diff'
import { call } from '../git'
import { hostErrorText } from '../hostErrors'
import { Button } from '../manage/kit'
import { Icon } from '../ui/Icon'
import { Press } from '../ui/Press'
import { MONO, useSessionTokens } from '../ui/session/palette'
import { radius, space, type as typeScale } from '../ui/tokens'

const SEVERITY_WORDS: Record<ReviewSeverity, string> = {
  critical: '严重',
  high: '高',
  medium: '中',
  low: '低',
}

/**
 * The session's latest review, read as the screen comes into view and again when `refresh`
 * changes, as when the folder did.
 */
export function useSessionReview(
  link: HostLink,
  sessionId: string | null,
  refresh: number,
): [ReviewRun | null, (review: ReviewRun) => void] {
  const [review, setReview] = useState<ReviewRun | null>(null)
  useFocusEffect(
    useCallback(() => {
      if (!sessionId) return
      let live = true
      call(link, 'sessions.review', { sessionId }).then(
        (read) => live && setReview(read),
        () => {},
      )
      return () => {
        live = false
      }
      // `refresh` reads the review again, as a new callback runs the effect anew.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [link, sessionId, refresh]),
  )
  return [review, setReview]
}

/** A finding of the file, on the diff's row its first line now is, or none where it is gone. */
export interface PlacedFinding {
  finding: ReviewFinding
  /** The row's index in the diff, or null for a line the diff folds away or that is gone. */
  row: number | null
  outdated: boolean
}

/**
 * The review's findings on `path`, placed on the file as `newText` has it now and on the diff's
 * rows, in the order of their lines.
 */
export function placedFindings(
  review: ReviewRun | null,
  path: string,
  newText: string,
  diff: Diff,
): PlacedFinding[] {
  const findings = shownFindings(review)
    .filter((finding) => finding.path === path)
    .sort((a, b) => a.start - b.start)
  if (findings.length === 0) return []
  const lines = newText.split(/\r?\n/)
  const rowOf = new Map<number, number>()
  diff.rows.forEach((row, index) => {
    if (row.kind !== 'hunk' && row.kind !== 'del' && row.new !== null) rowOf.set(row.new, index)
  })
  return findings.map((finding) => {
    const place = placeFinding(finding, lines)
    return {
      finding,
      row: place ? (rowOf.get(place.start) ?? null) : null,
      outdated: place === null,
    }
  })
}

export function useSeverityColors(): Record<ReviewSeverity, { ink: string; soft: string }> {
  const { c, s } = useSessionTokens()
  return useMemo(
    () => ({
      critical: { ink: c.danger, soft: s.dangerSoft },
      high: { ink: c.accent, soft: s.accentSoft },
      medium: { ink: c.warning, soft: s.warningSoft },
      low: { ink: c.textSecondary, soft: c.fill },
    }),
    [c, s],
  )
}

/** The rows the findings sit on, with their severity's color, for the diff's rows to mark. */
export function flaggedRows(
  placed: readonly PlacedFinding[],
  colors: Record<ReviewSeverity, { ink: string }>,
): Map<number, string> {
  const out = new Map<number, string>()
  for (const { finding, row } of placed) {
    if (row !== null && !out.has(row)) out.set(row, colors[finding.severity].ink)
  }
  return out
}

/**
 * The card over the diff: the file's findings one at a time, stepped through with the arrows,
 * each with its detail, where it stands, and 忽略 and 让 Agent 修, which go to the computer.
 */
export function FindingsCard(props: {
  link: HostLink
  sessionId: string
  review: ReviewRun
  placed: readonly PlacedFinding[]
  onReview: (review: ReviewRun) => void
  /** Scrolls the diff to a row. */
  onShowRow: (row: number) => void
}) {
  const { link, sessionId, review, placed, onReview, onShowRow } = props
  const { c } = useSessionTokens()
  const colors = useSeverityColors()
  const [at, setAt] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState<ReviewAction | null>(null)
  const index = Math.min(at, placed.length - 1)
  const current = placed[index]

  const step = useCallback(
    (by: 1 | -1) => {
      const next = (index + by + placed.length) % placed.length
      setAt(next)
      setExpanded(false)
      const row = placed[next]?.row
      if (row !== null && row !== undefined) onShowRow(row)
    },
    [index, placed, onShowRow],
  )

  if (!current) return null
  const { finding } = current
  const tone = colors[finding.severity]
  const lines =
    finding.start === finding.end ? `${finding.start}` : `${finding.start}-${finding.end}`
  const where = current.outdated
    ? '已过时，这一行已经不在了'
    : current.row === null
      ? '不在显示的改动里'
      : null
  const act = async (action: ReviewAction) => {
    setBusy(action)
    try {
      onReview(
        await call(link, 'sessions.reviewAct', {
          sessionId,
          reviewId: review.id,
          findingIds: [finding.id],
          action,
        }),
      )
    } catch (error) {
      Alert.alert('没能完成', hostErrorText(error, '电脑没有回应，请稍后再试。'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <View
      style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}
      accessibilityLabel={`审查发现的问题，第 ${index + 1} 个，共 ${placed.length} 个`}
    >
      <View style={[styles.bar, { backgroundColor: tone.ink }]} />
      <View style={styles.head}>
        <View style={[styles.badge, { backgroundColor: tone.soft }]}>
          <Text style={[styles.badgeText, { color: tone.ink }]}>
            {SEVERITY_WORDS[finding.severity]}
          </Text>
        </View>
        <Text style={[typeScale.subhead, styles.grow, { color: c.text }]} numberOfLines={2}>
          {finding.title}
        </Text>
        {placed.length > 1 ? (
          <View style={styles.steps}>
            <Text style={[typeScale.caption, { color: c.textTertiary }]}>
              {index + 1}/{placed.length}
            </Text>
            <Press
              style={styles.stepButton}
              onPress={() => step(-1)}
              accessibilityRole="button"
              accessibilityLabel="上一个问题"
            >
              <Icon name="chevronUp" size={18} color={c.textSecondary} />
            </Press>
            <Press
              style={styles.stepButton}
              onPress={() => step(1)}
              accessibilityRole="button"
              accessibilityLabel="下一个问题"
            >
              <Icon name="chevronDown" size={18} color={c.textSecondary} />
            </Press>
          </View>
        ) : null}
      </View>
      {finding.body !== '' ? (
        <Press
          onPress={() => setExpanded((open) => !open)}
          accessibilityRole="button"
          accessibilityLabel={expanded ? '收起说明' : '展开说明'}
          scale={false}
        >
          <Text
            style={[typeScale.footnote, { color: c.textSecondary }]}
            numberOfLines={expanded ? undefined : 3}
          >
            {finding.body}
          </Text>
        </Press>
      ) : null}
      <Text style={[styles.place, { color: c.textTertiary }]} numberOfLines={1}>
        {`${finding.path}:${lines}`}
        {where ? ` · ${where}` : ''}
        {finding.state === 'sent' ? ' · 已交给 Agent' : ''}
      </Text>
      <View style={styles.actions}>
        <Button
          label="忽略"
          tone="plain"
          icon="eyeSlash"
          busy={busy === 'dismiss'}
          disabled={busy !== null}
          onPress={() => void act('dismiss')}
        />
        <Button
          label={finding.state === 'sent' ? '再发一次' : '让 Agent 修'}
          tone="primary"
          icon="send"
          busy={busy === 'fix'}
          disabled={busy !== null}
          onPress={() => void act('fix')}
        />
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: space.md,
    marginBottom: space.sm,
    paddingLeft: space.md + 3,
    paddingRight: space.sm,
    paddingVertical: space.sm,
    gap: space.xs,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  bar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  badge: { borderRadius: radius.sm, paddingHorizontal: 6, paddingVertical: 1 },
  badgeText: { fontSize: 12, lineHeight: 17, fontWeight: '600' },
  grow: { flex: 1, minWidth: 0 },
  steps: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  stepButton: { padding: space.xxs },
  place: { fontFamily: MONO, fontSize: 11, lineHeight: 15 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: space.sm },
})
