// Renaming a session; an empty title, or Use the agent's, goes back to the title the agent gave.

import { useEffect, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useTheme } from '../theme'

const MAX_TITLE = 200

export function RenameDialog(props: {
  visible: boolean
  title: string
  onClose(): void
  onSave(title: string | null): Promise<void>
}) {
  const theme = useTheme()
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
      props.onClose()
    } catch (failure) {
      setError((failure as { message?: string }).message || '没能改名，请稍后再试。')
      setSaving(false)
    }
  }

  return (
    <Modal visible={props.visible} transparent animationType="fade" onRequestClose={props.onClose}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={[styles.card, { backgroundColor: theme.card }]}>
          <Text style={[styles.heading, { color: theme.text }]}>重命名会话</Text>
          <TextInput
            value={text}
            onChangeText={setText}
            autoFocus
            maxLength={MAX_TITLE}
            placeholder="会话标题"
            placeholderTextColor={theme.muted}
            returnKeyType="done"
            onSubmitEditing={() => void save(text.trim() || null)}
            selectTextOnFocus
            style={[
              styles.input,
              { color: theme.text, borderColor: theme.line, backgroundColor: theme.bg },
            ]}
          />
          {error && <Text style={{ color: theme.danger, fontSize: 13 }}>{error}</Text>}
          <Pressable onPress={() => void save(null)} disabled={saving} hitSlop={6}>
            <Text style={{ color: theme.accent, fontSize: 14 }}>用智能体起的标题</Text>
          </Pressable>
          <View style={styles.buttons}>
            <Pressable onPress={props.onClose} style={styles.button} hitSlop={6}>
              <Text style={{ color: theme.muted, fontSize: 16 }}>取消</Text>
            </Pressable>
            <Pressable
              onPress={() => void save(text.trim() || null)}
              disabled={saving}
              style={styles.button}
              hitSlop={6}
            >
              {saving ? (
                <ActivityIndicator color={theme.accent} />
              ) : (
                <Text style={{ color: theme.accent, fontSize: 16, fontWeight: '600' }}>保存</Text>
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  card: { borderRadius: 16, padding: 20, gap: 12 },
  heading: { fontSize: 17, fontWeight: '600' },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  buttons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 4 },
  button: { minWidth: 64, alignItems: 'center', paddingVertical: 8 },
})
