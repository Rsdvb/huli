// Renaming a session; an empty title, or Use the agent's, goes back to the title the agent gave.

import { useEffect, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { LockLayer } from '../lock'
import { haptic } from '../ui/haptics'
import { Press } from '../ui/Press'
import { radius, space, type as typeScale, useTokens } from '../ui/tokens'

const MAX_TITLE = 200

export function RenameDialog(props: {
  visible: boolean
  title: string
  onClose(): void
  onSave(title: string | null): Promise<void>
  /** For another name than a session's: its heading and placeholder, and no way back. */
  heading?: string
  placeholder?: string
  noReset?: boolean
  maxLength?: number
}) {
  const { c } = useTokens()
  const [text, setText] = useState(props.title)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!props.visible) return
    setText(props.title)
    setError(null)
    setSaving(false)
  }, [props.visible, props.title])

  const save = async (title: string | null) => {
    setSaving(true)
    setError(null)
    try {
      await props.onSave(title)
      haptic.success()
      props.onClose()
    } catch (failure) {
      haptic.warning()
      setError((failure as { message?: string }).message || '没能改名，请稍后再试。')
      setSaving(false)
    }
  }

  return (
    <Modal visible={props.visible} transparent animationType="fade" onRequestClose={props.onClose}>
      <KeyboardAvoidingView
        style={[styles.backdrop, { backgroundColor: c.scrim }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={[styles.card, { backgroundColor: c.surfaceRaised, borderColor: c.border }]}>
          <Text style={[typeScale.headline, { color: c.text }]}>
            {props.heading ?? '重命名会话'}
          </Text>
          <TextInput
            value={text}
            onChangeText={setText}
            autoFocus
            maxLength={props.maxLength ?? MAX_TITLE}
            placeholder={props.placeholder ?? '会话标题'}
            placeholderTextColor={c.textTertiary}
            returnKeyType="done"
            onSubmitEditing={() => void save(text.trim() || null)}
            selectTextOnFocus
            clearButtonMode="while-editing"
            style={[typeScale.body, styles.input, { color: c.text, backgroundColor: c.fill }]}
          />
          {error && <Text style={[typeScale.footnote, { color: c.danger }]}>{error}</Text>}
          {props.noReset ? null : (
            <Press onPress={() => void save(null)} disabled={saving} hitSlop={6} scale={false}>
              <Text style={[typeScale.subhead, { color: c.tint }]}>用 Agent 起的标题</Text>
            </Press>
          )}
          <View style={styles.buttons}>
            <Press
              onPress={props.onClose}
              accessibilityRole="button"
              containerStyle={styles.flex}
              style={[styles.button, { backgroundColor: c.fill }]}
            >
              <Text style={[typeScale.body, { color: c.text }]}>取消</Text>
            </Press>
            <Press
              onPress={() => void save(text.trim() || null)}
              disabled={saving}
              accessibilityRole="button"
              containerStyle={styles.flex}
              style={[styles.button, { backgroundColor: c.accent }]}
            >
              {saving ? (
                <ActivityIndicator color={c.onAccent} />
              ) : (
                <Text style={[typeScale.body, { color: c.onAccent, fontWeight: '600' }]}>保存</Text>
              )}
            </Press>
          </View>
        </View>
      </KeyboardAvoidingView>
      <LockLayer />
    </Modal>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  backdrop: { flex: 1, justifyContent: 'center', padding: space.xxl },
  card: {
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.xl,
    gap: space.md,
  },
  input: { borderRadius: radius.md, paddingHorizontal: space.md + 2, height: 48 },
  buttons: { flexDirection: 'row', gap: space.sm + 2, marginTop: space.xs },
  button: {
    height: 46,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
