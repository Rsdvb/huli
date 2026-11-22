// An agent's change to the desktop's theme colors, as its card asks it: the canvas and accent of
// each mode, Apply or Don't change, then one line of what came of it with Undo while it stands.
// The phone keeps its own look; this changes the computer's window.

import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Palette } from 'lucide-react-native'
import { BUILTIN_THEME_ID as BUILTIN, THEME_MODES } from '@shared/themes'
import type { ThreadEntry } from '@shared/thread'
import { call } from '../../git'
import { useLink } from '../../host'
import type { IconSpec } from '../../ui/session/icons'
import { MONO, useSessionTokens } from '../../ui/session/palette'
import { useAgentName, type Place } from './AccessEntries'
import { AskCard, QuietLine, useSender, WaitingLine } from './kit'

type Entry = Extract<ThreadEntry, { kind: 'theme_change' }>

const THEME: IconSpec = { sf: 'paintpalette', lucide: Palette }
const MODE = { light: '浅色', dark: '深色' }

/** Whether the card still waits: unanswered and not past the time it counts as declined. */
export function themeWaits(entry: Entry, now = Date.now()): boolean {
  return entry.outcome === null && entry.expiresAt !== null && now < entry.expiresAt
}

function Swatches(props: { entry: Entry }) {
  const { c } = useSessionTokens()
  const colors = props.entry.to.theme === BUILTIN ? null : (props.entry.to.agent?.colors ?? null)
  return (
    <View style={styles.swatches}>
      {THEME_MODES.map((mode) => {
        const own = colors?.[mode]
        return (
          <View key={mode} style={styles.swatch}>
            <View
              style={[
                styles.sheet,
                { borderColor: c.border, backgroundColor: own ? own.canvas : c.fill },
              ]}
            >
              {own ? <View style={[styles.pill, { backgroundColor: own.accent }]} /> : null}
            </View>
            <Text style={[styles.caption, { color: c.textSecondary }]}>
              {MODE[mode]}
              <Text style={{ color: c.textTertiary, fontFamily: own ? MONO : undefined }}>
                {own ? `  ${own.canvas} · ${own.accent}` : '  内置'}
              </Text>
            </Text>
          </View>
        )
      })}
    </View>
  )
}

export function ThemeChangeEntry(props: { entry: Entry; sessionId: string; place: Place }) {
  const { entry, sessionId } = props
  const link = useLink()
  const agent = useAgentName(sessionId)
  const sender = useSender(entry.id)
  const lineSender = useSender()
  const { c } = useSessionTokens()
  const reset = entry.to.theme === BUILTIN
  if (entry.outcome === null) {
    if (props.place === 'thread') return <WaitingLine icon={THEME} text="想更换主题颜色" />
    const answer = (decision: 'apply' | 'keep') => () =>
      call(link, 'theme.answerChange', { sessionId, entryId: entry.id, decision })
    return (
      <AskCard
        icon={THEME}
        title={reset ? '换回内置主题' : `更换主题颜色：${entry.to.name}`}
        body={`${agent} 想更换电脑上纸鸢的主题颜色`}
        sender={sender}
        footnote="只改颜色，布局保持纸鸢自己的。每次修改都能撤销。"
        actions={[
          { key: 'keep', label: '不改', run: answer('keep') },
          { key: 'apply', label: '应用', tone: 'primary', run: answer('apply') },
        ]}
      >
        {reset ? null : <Swatches entry={entry} />}
      </AskCard>
    )
  }
  const outcome = entry.outcome
  const changed = outcome.kind === 'changed'
  const undone = changed && outcome.undone === true
  const live = changed && !undone && outcome.stale !== true
  const text = undone
    ? '已撤销主题修改'
    : changed
      ? reset
        ? '已换回内置主题'
        : `已把主题颜色换成 ${entry.to.name}`
      : '没有更换主题颜色'
  const detail =
    [
      entry.device ? `在 ${entry.device.name} 上回答` : null,
      outcome.kind === 'expired' ? '10 分钟没有回答' : null,
      outcome.kind === 'failed' ? outcome.message : null,
    ]
      .filter(Boolean)
      .join(' · ') || null
  return (
    <>
      <QuietLine
        icon={THEME}
        tone={changed && !undone ? 'done' : 'other'}
        text={text}
        detail={detail}
        trail={
          live ? (
            <Pressable
              onPress={() =>
                void lineSender.send('undo', () =>
                  call(link, 'theme.undoChange', { sessionId, entryId: entry.id }),
                )
              }
              disabled={lineSender.busy !== null}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="撤销主题修改"
              style={({ pressed }) => ({ opacity: pressed || lineSender.busy ? 0.5 : 1 })}
            >
              <Text style={[styles.trail, { color: c.tint }]}>撤销主题修改</Text>
            </Pressable>
          ) : null
        }
      />
      {lineSender.error ? (
        <Text style={[styles.error, { color: c.danger }]}>{lineSender.error}</Text>
      ) : null}
    </>
  )
}

const styles = StyleSheet.create({
  swatches: { flexDirection: 'row', gap: 10, marginTop: 10 },
  swatch: { flex: 1, gap: 6 },
  sheet: {
    height: 56,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'flex-end',
    padding: 10,
  },
  pill: { width: 32, height: 12, borderRadius: 6 },
  caption: { fontSize: 12 },
  trail: { fontSize: 13, fontWeight: '600' },
  error: { fontSize: 12, marginLeft: 21, marginBottom: 4 },
})
