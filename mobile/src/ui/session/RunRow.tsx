// The work between messages folded into one line, as the desktop's run group: what it did ("读取了
// a.ts 及另外 2 个文件 · 运行了 5 条命令"), over the stacked icons of its last kinds of step, how
// many failed and how long it took. While it runs, or is the last thing of a turn that still runs,
// the line ends with the latest thought's heading. Tapped, it opens to a line per step. A lone step
// shows as its own line.

import { memo } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import type { ThreadEntry } from '@shared/thread'
import { MemoryEntry } from '../../components/entries/AccessEntries'
import { E } from '../../components/entries/kit'
import { useSessionRows } from './context'
import { useDisclosure } from './disclosure'
import { G, Icon, TOOL_ICONS, type IconSpec } from './icons'
import { useSessionTokens } from './palette'
import { gentle } from './Press'
import { LiveTime, ThoughtRow, ToolRow } from './ToolRow'
import {
  diffStats,
  formatMs,
  runLabels,
  runSummary,
  stepOf,
  thoughtTitle,
  toolTime,
  type RunStep,
  type SummaryPart,
} from './work'

// What an agent's own label for a run names, so the counts after it leave these out.
const LABELLED = new Set(['read', 'search', 'fetch'])

function iconOf(entry: ThreadEntry): IconSpec | null {
  if (entry.kind === 'tool') return TOOL_ICONS[entry.toolKind]
  if (entry.kind === 'thought') return G.thought
  if (entry.kind === 'memory') return E.memory
  return null
}

/** A step of a run: a tool call, a thought or a project memory write. */
export const Step = memo(function Step(props: { entry: ThreadEntry }) {
  const { sessionId } = useSessionRows()
  const { entry } = props
  if (entry.kind === 'tool') return <ToolRow entry={entry} />
  if (entry.kind === 'thought') return <ThoughtRow entry={entry} />
  if (entry.kind === 'memory')
    return <MemoryEntry entry={entry} sessionId={sessionId} place="thread" />
  return null
})

export const RunRow = memo(function RunRow(props: { entries: ThreadEntry[]; latest: boolean }) {
  const { c } = useSessionTokens()
  const { sessionId } = useSessionRows()
  const { entries, latest } = props
  const [open, setOpen] = useDisclosure(`run:${entries[0]!.id}`)
  if (entries.length === 1) return <Step entry={entries[0]!} />

  const steps = entries.map(stepOf).filter((step): step is RunStep => step !== null)
  const summary = runSummary(steps)
  const own = runLabels(steps)
  const parts: SummaryPart[] =
    own.length > 0
      ? [
          ...own.map((text) => ({ text })),
          ...summary.parts.filter((part) => !part.kind || !LABELLED.has(part.kind)),
        ]
      : summary.parts
  const texts = parts.map((part) => {
    const stats = part.diffs ? diffStats(part.diffs) : null
    return stats && (stats.insertions > 0 || stats.deletions > 0)
      ? `${part.text} +${stats.insertions} −${stats.deletions}`
      : part.text
  })
  if (summary.running || latest) {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!
      if (entry.kind !== 'thought') continue
      const title = thoughtTitle(entry.markdown)
      if (title) texts.push(title)
      break
    }
  }
  const label = texts.join(' · ')

  // The time the run took, when this phone saw each of its steps start and end.
  let total = 0
  let known = true
  let since: number | undefined
  for (const entry of entries) {
    if (entry.kind === 'thought') {
      if (entry.durationMs !== undefined) total += entry.durationMs
      else if (!entry.streaming) known = false
    } else if (entry.kind === 'tool') {
      const time = toolTime(sessionId, entry.id)
      if (time.durationMs !== undefined) total += time.durationMs
      else if (time.startedAt !== undefined && (since === undefined || time.startedAt < since)) {
        since = time.startedAt
      } else if (!summary.running || time.startedAt === undefined) known = false
    } else if (entry.kind !== 'memory') known = false
  }

  // The kinds of its latest steps, each once and up to three, oldest first.
  const stack: IconSpec[] = []
  for (let i = entries.length - 1; i >= 0 && stack.length < 3; i--) {
    const icon = iconOf(entries[i]!)
    if (icon && !stack.includes(icon)) stack.unshift(icon)
  }

  return (
    <View>
      <Pressable
        onPress={() => {
          gentle()
          setOpen((v) => !v)
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={label}
        style={({ pressed }) => [styles.line, { opacity: pressed ? 0.6 : 1 }]}
      >
        <View style={[styles.chevron, { transform: [{ rotate: open ? '90deg' : '0deg' }] }]}>
          <Icon icon={G.right} size={12} color={c.textTertiary} weight="semibold" />
        </View>
        <View style={[styles.stack, { width: 24 + (stack.length - 1) * 10 }]}>
          {stack.map((icon, i) => (
            // The fill is translucent, so each badge lies on the page's own color: else the one
            // under it shows through and the stack reads as two icons drawn over each other.
            <View
              key={i}
              style={[
                styles.badge,
                { left: i * 10, backgroundColor: c.bg, borderColor: c.bg, zIndex: i },
              ]}
            >
              <View style={[styles.badgeFill, { backgroundColor: c.fill }]}>
                <Icon icon={icon} size={12} color={c.textSecondary} />
              </View>
            </View>
          ))}
        </View>
        <Text style={[styles.label, { color: c.textSecondary }]} numberOfLines={1}>
          {label}
        </Text>
        {!summary.running && summary.failed > 0 && (
          <Text style={[styles.meta, { color: c.danger }]}>· {summary.failed} 项失败</Text>
        )}
        {summary.running ? (
          <View style={styles.mark}>
            <ActivityIndicator size="small" color={c.textTertiary} style={styles.spinner} />
            {since !== undefined && <LiveTime since={since - total} color={c.textTertiary} />}
          </View>
        ) : known && total > 0 ? (
          <Text style={[styles.meta, { color: c.textTertiary }]}>· {formatMs(total, false)}</Text>
        ) : null}
      </Pressable>
      {open && (
        <View style={styles.steps}>
          {entries.map((entry, i) => (
            <TimelineStep
              key={entry.id}
              entry={entry}
              first={i === 0}
              last={i === entries.length - 1}
            />
          ))}
        </View>
      )}
    </View>
  )
})

// Where a step's dot sits: the middle of its line, closed or heading its card.
const DOT_AT = 17

/**
 * A step of an opened run on its timeline: a dot by its line, joined to the steps before and after
 * by a thin line that runs on past a card it opened into; red for a step that failed.
 */
const TimelineStep = memo(function TimelineStep(props: {
  entry: ThreadEntry
  first: boolean
  last: boolean
}) {
  const { c } = useSessionTokens()
  const failed = props.entry.kind === 'tool' && props.entry.status === 'failed'
  return (
    <View style={styles.timelineStep}>
      <View style={styles.gutter} pointerEvents="none">
        {!props.first && (
          <View style={[styles.rail, { top: 0, height: DOT_AT, backgroundColor: c.tint }]} />
        )}
        {!props.last && (
          <View style={[styles.rail, { top: DOT_AT, bottom: 0, backgroundColor: c.tint }]} />
        )}
        <View style={[styles.dot, { backgroundColor: failed ? c.danger : c.tint }]} />
      </View>
      <View style={styles.stepBody}>
        <Step entry={props.entry} />
      </View>
    </View>
  )
})

const styles = StyleSheet.create({
  line: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 },
  stack: { height: 24 },
  badge: {
    position: 'absolute',
    top: 0,
    width: 24,
    height: 24,
    borderRadius: 7,
    borderWidth: 1.5,
  },
  badgeFill: {
    flex: 1,
    borderRadius: 5.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { flex: 1, fontSize: 14, lineHeight: 19, fontWeight: '500' },
  meta: { fontSize: 12, fontVariant: ['tabular-nums'] },
  mark: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  spinner: { transform: [{ scale: 0.7 }], width: 16, height: 16 },
  chevron: { width: 14, alignItems: 'center' },
  steps: { marginTop: 2 },
  timelineStep: { flexDirection: 'row' },
  gutter: { width: 22 },
  rail: { position: 'absolute', left: 7.25, width: 1.5, opacity: 0.55 },
  dot: { position: 'absolute', left: 5, top: DOT_AT - 3, width: 6, height: 6, borderRadius: 3 },
  stepBody: { flex: 1, minWidth: 0 },
})
