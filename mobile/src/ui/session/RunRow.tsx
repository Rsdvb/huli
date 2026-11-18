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
        <View style={[styles.stack, { width: 24 + (stack.length - 1) * 10 }]}>
          {stack.map((icon, i) => (
            <View
              key={i}
              style={[
                styles.badge,
                { left: i * 10, backgroundColor: c.fill, borderColor: c.bg, zIndex: i },
              ]}
            >
              <Icon icon={icon} size={12} color={c.textSecondary} />
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
        <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}>
          <Icon icon={G.right} size={11} color={c.textTertiary} weight="semibold" />
        </View>
      </Pressable>
      {open && (
        <View style={[styles.steps, { borderLeftColor: c.border }]}>
          {entries.map((entry) => (
            <Step key={entry.id} entry={entry} />
          ))}
        </View>
      )}
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
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { flex: 1, fontSize: 14, lineHeight: 19, fontWeight: '500' },
  meta: { fontSize: 12, fontVariant: ['tabular-nums'] },
  mark: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  spinner: { transform: [{ scale: 0.7 }], width: 16, height: 16 },
  steps: { marginLeft: 11, paddingLeft: 10, borderLeftWidth: StyleSheet.hairlineWidth, gap: 2 },
})
