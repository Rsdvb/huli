// A list of actions or choices that rises from the bottom, the same on iOS and Android.

import type { ReactNode } from 'react'
import { Platform, StyleSheet, Text, View } from 'react-native'
import { BottomSheet } from '../ui/BottomSheet'
import { Icon } from '../ui/Icon'
import { Press } from '../ui/Press'
import { radius, space, type as typeScale, useTokens } from '../ui/tokens'

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
  const { c } = useTokens()

  // Items between section headings share one rounded group.
  const groups: { section?: string; items: SheetItem[] }[] = []
  for (const item of props.items) {
    if (groups.length === 0 || item.section) groups.push({ section: item.section, items: [] })
    groups[groups.length - 1]!.items.push(item)
  }

  return (
    <BottomSheet
      visible={props.visible}
      onClose={props.onClose}
      title={props.title}
      message={props.message}
    >
      {groups.map((group, g) => (
        <View key={g} style={styles.groupWrap}>
          {group.section ? (
            <Text style={[typeScale.footnote, styles.section, { color: c.textSecondary }]}>
              {group.section}
            </Text>
          ) : null}
          <View style={[styles.group, { backgroundColor: c.fill }]}>
            {group.items.map((item, i) => (
              <View key={item.key}>
                {i > 0 && <View style={[styles.line, { backgroundColor: c.border }]} />}
                <Press
                  disabled={item.disabled}
                  scale={false}
                  accessibilityRole="button"
                  accessibilityState={{ selected: item.checked }}
                  onPress={() => {
                    props.onClose()
                    // iOS will not present an alert or another modal while this one is leaving.
                    setTimeout(item.onPress, Platform.OS === 'ios' ? 400 : 0)
                  }}
                  style={styles.item}
                >
                  <View style={styles.text}>
                    <Text
                      style={[
                        typeScale.body,
                        {
                          color: item.destructive ? c.danger : c.text,
                          fontWeight: item.checked ? '600' : '400',
                        },
                      ]}
                    >
                      {item.label}
                    </Text>
                    {item.detail ? (
                      <Text style={[typeScale.footnote, { color: c.textSecondary }]}>
                        {item.detail}
                      </Text>
                    ) : null}
                  </View>
                  {item.checked && <Icon name="check" size={18} color={c.tint} weight="semibold" />}
                </Press>
              </View>
            ))}
          </View>
        </View>
      ))}
      {props.footer}
      <Press
        onPress={props.onClose}
        scale={false}
        style={[styles.cancel, { backgroundColor: c.fill }]}
      >
        <Text style={[typeScale.body, { color: c.text, fontWeight: '600' }]}>取消</Text>
      </Press>
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  groupWrap: { gap: space.sm },
  section: { marginLeft: space.lg, marginTop: space.xs },
  group: { borderRadius: radius.lg, overflow: 'hidden' },
  line: { height: StyleSheet.hairlineWidth, marginLeft: space.lg },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    minHeight: 52,
    paddingVertical: space.md,
  },
  text: { flex: 1, gap: 2 },
  cancel: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.lg,
    minHeight: 52,
  },
})
