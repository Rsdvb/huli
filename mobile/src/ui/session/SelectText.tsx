// A message's text on a sheet of its own, where holding it selects words as anywhere in iOS: the
// conversation keeps the long press for its menu.

import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { copyText } from './feedback'
import { G, Icon } from './icons'
import { useSessionTokens } from './palette'
import { PressScale, RoundButton } from './Press'

export function SelectText(props: { text: string | null; onClose(): void }) {
  const { c } = useSessionTokens()
  const insets = useSafeAreaInsets()
  return (
    <Modal
      visible={props.text !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <View style={[styles.root, { backgroundColor: c.bg }]}>
        <View style={styles.head}>
          <PressScale
            onPress={() => props.text && void copyText(props.text)}
            hitSlop={8}
            accessibilityRole="button"
            style={[styles.copy, { backgroundColor: c.fill }]}
          >
            <Icon icon={G.copy} size={14} color={c.text} />
            <Text style={[styles.copyText, { color: c.text }]}>全部复制</Text>
          </PressScale>
          <Text style={[styles.title, { color: c.text }]}>选择文本</Text>
          <RoundButton size={34} onPress={props.onClose} accessibilityLabel="完成">
            <Icon icon={G.close} size={14} color={c.text} weight="semibold" />
          </RoundButton>
        </View>
        <ScrollView contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 24 }}>
          <Text selectable style={[styles.text, { color: c.text }]}>
            {props.text}
          </Text>
        </ScrollView>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 6,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
    position: 'absolute',
    left: 0,
    right: 0,
    textAlign: 'center',
    zIndex: -1,
  },
  copy: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 12,
    height: 34,
  },
  copyText: { fontSize: 14, fontWeight: '500' },
  text: { fontSize: 17, lineHeight: 26 },
})
