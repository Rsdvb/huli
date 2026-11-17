// Text on a sheet of its own, where holding it selects a range as anywhere in iOS: handles, then
// Copy, Look Up and Share. The rows that show text keep the long press for their menu, and a
// selectable `Text` on iOS only offers to copy all of it, so the sheet shows the text in a
// read-only text view instead. Any screen opens it with `selectText`; the root layout holds it.

import { useEffect, useRef, useState, useSyncExternalStore, type ComponentRef } from 'react'
import {
  Modal,
  Platform,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputSelectionChangeEvent,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { LockLayer } from '../../lock'
import { copyText } from './feedback'
import { G, Icon, type IconSpec } from './icons'
import { MONO, useSessionTokens } from './palette'
import { PressScale, RoundButton } from './Press'

export interface Selectable {
  text: string
  /** Code, output and files: monospace, without wrapping words apart. */
  mono?: boolean
  /** The sheet's title; 选择文本 by default. */
  title?: string
}

let current: Selectable | null = null
const listeners = new Set<() => void>()

function set(next: Selectable | null): void {
  current = next
  for (const listener of listeners) listener()
}

/** Opens the sheet over whatever shows. */
export function selectText(next: Selectable): void {
  if (next.text) set(next)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function Action(props: { icon: IconSpec; label: string; onPress(): void }) {
  const { c } = useSessionTokens()
  return (
    <PressScale
      onPress={props.onPress}
      hitSlop={6}
      accessibilityRole="button"
      style={[styles.action, { backgroundColor: c.fill }]}
    >
      <Icon icon={props.icon} size={14} color={c.text} />
      <Text style={[styles.actionText, { color: c.text }]}>{props.label}</Text>
    </PressScale>
  )
}

export function SelectTextHost() {
  const shown = useSyncExternalStore(subscribe, () => current)
  // Kept while the sheet slides away, so its text does not vanish first.
  const [last, setLast] = useState<Selectable | null>(shown)
  useEffect(() => {
    if (shown) setLast(shown)
  }, [shown])
  const { c } = useSessionTokens()
  const insets = useSafeAreaInsets()
  const input = useRef<ComponentRef<typeof TextInput>>(null)
  const range = useRef({ start: 0, end: 0 })
  const [copied, setCopied] = useState(false)
  const item = shown ?? last
  const text = item?.text ?? ''

  useEffect(() => {
    range.current = { start: 0, end: 0 }
    setCopied(false)
  }, [shown])
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  const chosen = () => {
    const { start, end } = range.current
    return end > start ? text.slice(start, end) : text
  }
  const onSelection = (event: TextInputSelectionChangeEvent) => {
    range.current = event.nativeEvent.selection
  }
  const selectAll = () => {
    input.current?.focus()
    input.current?.setSelection(0, text.length)
    range.current = { start: 0, end: text.length }
  }
  const close = () => set(null)

  return (
    <Modal
      visible={shown !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={close}
    >
      <View style={[styles.root, { backgroundColor: c.bg }]}>
        <View style={styles.head}>
          <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>
            {item?.title ?? '选择文本'}
          </Text>
          <RoundButton size={34} onPress={close} accessibilityLabel="完成">
            <Icon icon={G.close} size={14} color={c.text} weight="semibold" />
          </RoundButton>
        </View>
        <View style={styles.actions}>
          <Action icon={G.select} label="全选" onPress={selectAll} />
          <Action
            icon={copied ? G.copied : G.copy}
            label={copied ? '已复制' : '复制'}
            onPress={() => void copyText(chosen()).then(() => setCopied(true))}
          />
          <Action
            icon={G.share}
            label="分享"
            onPress={() => void Share.share({ message: chosen() }).catch(() => {})}
          />
        </View>
        <TextInput
          ref={input}
          value={text}
          editable={false}
          multiline
          scrollEnabled
          showSoftInputOnFocus={false}
          onSelectionChange={onSelection}
          textAlignVertical="top"
          selectionColor={c.tint}
          style={[
            item?.mono ? styles.mono : styles.text,
            {
              color: c.text,
              paddingBottom: insets.bottom + 24,
            },
          ]}
        />
      </View>
      <LockLayer />
    </Modal>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
    paddingTop: 14,
    height: 62,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
    position: 'absolute',
    left: 64,
    right: 64,
    top: 14,
    lineHeight: 48,
    textAlign: 'center',
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 10,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 14,
    height: 34,
  },
  actionText: { fontSize: 14, fontWeight: '500' },
  text: {
    flex: 1,
    fontSize: 17,
    lineHeight: 26,
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  mono: {
    flex: 1,
    fontFamily: MONO,
    fontSize: Platform.OS === 'ios' ? 13 : 12.5,
    lineHeight: 19,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
})
