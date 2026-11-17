// The pieces a task's page is built of: a card that waits for the user, a note field, a button
// that shows its request at work, a document's chip and a request's busy and error state.

import { useState, type ReactNode } from 'react'
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native'
import { router } from 'expo-router'
import { errorText } from '../../sessions'
import { haptic } from '../../ui/haptics'
import { Icon, type IconName } from '../../ui/Icon'
import { Press } from '../../ui/Press'
import { radius, space, type as typeScale, useTokens } from '../../ui/tokens'

/** One request at a time from a card, with the key of the button that sent it and its error. */
export function useRequest() {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const run = async (key: string, request: () => Promise<unknown>): Promise<boolean> => {
    if (busy) return false
    setBusy(key)
    setError(null)
    try {
      await request()
      haptic.success()
      return true
    } catch (failure) {
      haptic.warning()
      setError(errorText(failure))
      return false
    } finally {
      setBusy(null)
    }
  }
  return { busy, error, run }
}

export function NeedCard(props: {
  icon: IconName
  tone?: 'warning' | 'danger'
  /** A quiet line above the title, such as the round and its agent. */
  over?: string
  title: string
  body?: ReactNode
  error?: string | null
  children?: ReactNode
}) {
  const { c } = useTokens()
  const tone = props.tone === 'danger' ? c.danger : props.tone === 'warning' ? c.warning : c.accent
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: c.surface, borderColor: c.border, borderLeftColor: tone },
      ]}
    >
      {props.over ? (
        <Text style={[typeScale.caption, { color: c.textTertiary }]} numberOfLines={1}>
          {props.over}
        </Text>
      ) : null}
      <View style={styles.head}>
        <Icon name={props.icon} size={18} color={tone} />
        <Text style={[typeScale.headline, styles.flex, { color: c.text }]}>{props.title}</Text>
      </View>
      {typeof props.body === 'string' ? (
        <Text selectable style={[typeScale.callout, { color: c.textSecondary }]}>
          {props.body}
        </Text>
      ) : (
        props.body
      )}
      {props.children}
      {props.error ? (
        <Text accessibilityRole="alert" style={[typeScale.footnote, { color: c.danger }]}>
          {props.error}
        </Text>
      ) : null}
    </View>
  )
}

export function NoteField(props: {
  value: string
  onChange(value: string): void
  placeholder: string
  editable?: boolean
}) {
  const { c } = useTokens()
  return (
    <TextInput
      value={props.value}
      onChangeText={props.onChange}
      placeholder={props.placeholder}
      placeholderTextColor={c.textTertiary}
      accessibilityLabel={props.placeholder}
      editable={props.editable !== false}
      multiline
      textAlignVertical="top"
      style={[typeScale.callout, styles.note, { color: c.text, backgroundColor: c.fill }]}
    />
  )
}

export function ActionButton(props: {
  label: string
  onPress(): void
  tone?: 'primary' | 'plain' | 'danger'
  busy?: boolean
  disabled?: boolean
  icon?: IconName
}) {
  const { c } = useTokens()
  const tone = props.tone ?? 'plain'
  const ink = tone === 'primary' ? c.onAccent : tone === 'danger' ? c.danger : c.text
  return (
    <Press
      onPress={props.onPress}
      disabled={props.disabled || props.busy}
      accessibilityRole="button"
      accessibilityState={{ busy: !!props.busy, disabled: !!props.disabled }}
      accessibilityLabel={props.label}
      style={[
        styles.button,
        {
          backgroundColor: tone === 'primary' ? c.accent : c.fill,
          opacity: props.disabled ? 0.45 : 1,
        },
      ]}
    >
      {props.busy ? (
        <ActivityIndicator color={ink} />
      ) : (
        <>
          {props.icon ? <Icon name={props.icon} size={16} color={ink} /> : null}
          <Text
            style={[typeScale.subhead, { color: ink, fontWeight: '600', flexShrink: 1 }]}
            numberOfLines={1}
          >
            {props.label}
          </Text>
        </>
      )}
    </Press>
  )
}

/** A row of buttons that wraps on a narrow phone, the main one last. */
export function Actions(props: { children: ReactNode }) {
  return <View style={styles.actions}>{props.children}</View>
}

/** A document a step handed in: it opens full screen. */
export function DocumentChip(props: { artifactId: string; title: string; detail?: string }) {
  const { c } = useTokens()
  return (
    <Press
      onPress={() => router.push(`/artifact/${props.artifactId}`)}
      accessibilityRole="button"
      accessibilityLabel={`打开文档：${props.title}`}
      style={[styles.doc, { backgroundColor: c.fill }]}
    >
      <Icon name="doc" size={16} color={c.tint} />
      <View style={styles.flexShrink}>
        <Text style={[typeScale.subhead, { color: c.text }]} numberOfLines={1}>
          {props.title}
        </Text>
        {props.detail ? (
          <Text style={[typeScale.caption, { color: c.textTertiary }]} numberOfLines={1}>
            {props.detail}
          </Text>
        ) : null}
      </View>
      <Icon name="chevronRight" size={12} color={c.textTertiary} weight="semibold" />
    </Press>
  )
}

/** A small tag on a step: who does it, or that you review it. */
export function Tag(props: { label: string; color: string; background: string }) {
  return (
    <Text
      style={[
        typeScale.caption,
        styles.tag,
        { color: props.color, backgroundColor: props.background },
      ]}
    >
      {props.label}
    </Text>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  flexShrink: { flexShrink: 1 },
  card: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderLeftWidth: 3,
    padding: space.lg,
    gap: space.sm + 2,
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  note: {
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingTop: space.sm + 2,
    paddingBottom: space.sm + 2,
    minHeight: 44,
    maxHeight: 160,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs + 2,
    minHeight: 40,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'flex-end',
    gap: space.sm,
  },
  doc: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    alignSelf: 'flex-start',
    maxWidth: '100%',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
  },
  tag: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radius.xs,
    overflow: 'hidden',
  },
})
