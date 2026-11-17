// A list of actions or choices that rises from the bottom, the same on iOS and Android.

import type { ReactNode } from 'react'
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '../theme'

export interface SheetItem {
  key: string
  label: string
  detail?: string
  destructive?: boolean
  disabled?: boolean
  checked?: boolean
  /** A heading shown above this item. */
  section?: string
  onPress(): void
}

export function Sheet(props: {
  visible: boolean
  title?: string
  message?: string
  items: SheetItem[]
  onClose(): void
  footer?: ReactNode
}) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  return (
    <Modal visible={props.visible} transparent animationType="fade" onRequestClose={props.onClose}>
      <Pressable style={styles.backdrop} onPress={props.onClose} accessibilityLabel="关闭">
        <Pressable
          style={[
            styles.card,
            { backgroundColor: theme.card, paddingBottom: Math.max(insets.bottom, 12) },
          ]}
          onPress={() => {}}
        >
          {props.title || props.message ? (
            <View style={[styles.head, { borderBottomColor: theme.line }]}>
              {props.title ? (
                <Text style={[styles.title, { color: theme.text }]} numberOfLines={2}>
                  {props.title}
                </Text>
              ) : null}
              {props.message ? (
                <Text style={{ color: theme.muted, fontSize: 13, marginTop: 4 }}>
                  {props.message}
                </Text>
              ) : null}
            </View>
          ) : null}
          <ScrollView style={{ maxHeight: 460 }} bounces={false}>
            {props.items.map((item) => (
              <View key={item.key}>
                {item.section ? (
                  <Text style={[styles.section, { color: theme.muted }]}>{item.section}</Text>
                ) : null}
                <Pressable
                  disabled={item.disabled}
                  onPress={() => {
                    props.onClose()
                    // iOS will not present an alert or another modal while this one is leaving.
                    setTimeout(item.onPress, Platform.OS === 'ios' ? 400 : 0)
                  }}
                  style={({ pressed }) => [
                    styles.item,
                    { backgroundColor: pressed ? theme.line : 'transparent' },
                    item.disabled && { opacity: 0.4 },
                  ]}
                >
                  <View style={{ flex: 1 }}>
                    <Text
                      style={{
                        color: item.destructive ? theme.danger : theme.text,
                        fontSize: 16,
                        fontWeight: item.checked ? '600' : '400',
                      }}
                    >
                      {item.label}
                    </Text>
                    {item.detail ? (
                      <Text style={{ color: theme.muted, fontSize: 12, marginTop: 2 }}>
                        {item.detail}
                      </Text>
                    ) : null}
                  </View>
                  {item.checked && (
                    <Text style={{ color: theme.accent, fontSize: 16, fontWeight: '700' }}>✓</Text>
                  )}
                </Pressable>
              </View>
            ))}
          </ScrollView>
          {props.footer}
          <Pressable
            onPress={props.onClose}
            style={({ pressed }) => [
              styles.cancel,
              { borderTopColor: theme.line, opacity: pressed ? 0.6 : 1 },
            ]}
          >
            <Text style={{ color: theme.accent, fontSize: 16, fontWeight: '600' }}>取消</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)' },
  card: { borderTopLeftRadius: 16, borderTopRightRadius: 16, overflow: 'hidden' },
  head: { paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12, borderBottomWidth: 1 },
  title: { fontSize: 15, fontWeight: '600' },
  section: { fontSize: 12, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 13,
  },
  cancel: { alignItems: 'center', paddingVertical: 14, borderTopWidth: StyleSheet.hairlineWidth },
})
