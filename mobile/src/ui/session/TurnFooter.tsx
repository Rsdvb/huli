// The line under a finished turn: when it ended and how long it took, and buttons to copy its
// reply, to fork the session from it and, under the latest turn, to undo that turn.

import { memo, useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useSessionRows } from './context'
import { copyText } from './feedback'
import { clockTime, spanText } from './format'
import { G, Icon } from './icons'
import { useSessionTokens } from './palette'
import { PressScale } from './Press'
import type { Row } from './turns'

type Footer = Extract<Row, { type: 'footer' }>

const STOPS: Partial<Record<Footer['end']['stopReason'], string>> = {
  cancelled: '已停止',
  max_tokens: '输出到上限',
  max_turn_requests: '步数到上限',
  refusal: '拒绝了',
}

export const TurnFooter = memo(function TurnFooter(props: {
  end: Footer['end']
  endedAt: number | null
  replies: Footer['replies']
}) {
  const { c } = useSessionTokens()
  const { fork, undo } = useSessionRows()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])

  const reply = props.replies
    .map((r) => r.markdown.trim())
    .filter(Boolean)
    .join('\n\n')
  const last = props.replies[props.replies.length - 1]
  const parts = [
    props.endedAt !== null ? clockTime(props.endedAt) : null,
    spanText(props.end.durationMs),
    STOPS[props.end.stopReason] ?? null,
  ].filter(Boolean)

  return (
    <View style={styles.row}>
      <Text style={[styles.text, { color: c.textTertiary }]} numberOfLines={1}>
        {parts.join(' · ')}
      </Text>
      <View style={styles.actions}>
        {reply ? (
          <PressScale
            hitSlop={10}
            onPress={() => void copyText(reply).then(() => setCopied(true))}
            accessibilityRole="button"
            accessibilityLabel="复制回复"
            style={styles.button}
          >
            <Icon
              icon={copied ? G.copied : G.copy}
              size={16}
              color={copied ? c.success : c.textTertiary}
            />
          </PressScale>
        ) : null}
        {fork && last ? (
          <PressScale
            hitSlop={10}
            onPress={() => fork(last.id)}
            accessibilityRole="button"
            accessibilityLabel="从这里分叉"
            style={styles.button}
          >
            <Icon icon={G.fork} size={16} color={c.textTertiary} />
          </PressScale>
        ) : null}
        {undo && undo.end === props.end.id ? (
          <PressScale
            hitSlop={10}
            disabled={undo.blocked}
            onPress={undo.run}
            accessibilityRole="button"
            accessibilityLabel="撤销这一轮"
            accessibilityState={{ disabled: undo.blocked }}
            style={[styles.button, undo.blocked && styles.blocked]}
          >
            <Icon icon={G.undo} size={16} color={c.textTertiary} />
          </PressScale>
        ) : null}
      </View>
    </View>
  )
})

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', minHeight: 32, marginTop: -2 },
  text: { flex: 1, fontSize: 13, lineHeight: 18, fontVariant: ['tabular-nums'] },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  button: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  blocked: { opacity: 0.38 },
})
