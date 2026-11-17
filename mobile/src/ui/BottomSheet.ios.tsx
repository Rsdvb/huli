// A sheet from the bottom, as iOS presents its own: a SwiftUI sheet through @expo/ui, sized to its
// content, with the system's grabber, drag to dismiss and dimming, and Liquid Glass on iOS 26.
// Its content stays React Native's. BottomSheet.tsx is Android's.

import type { ReactNode } from 'react'
import { Dimensions, ScrollView, StyleSheet, Text, View } from 'react-native'
import { BottomSheet as SwiftSheet, Group, Host, RNHostView } from '@expo/ui/swift-ui'
import { preferredColorScheme, presentationDragIndicator } from '@expo/ui/swift-ui/modifiers'
import { LockLayer } from '../lock'
import { space, type as typeScale, useTokens } from './tokens'

export function BottomSheet(props: {
  visible: boolean
  onClose(): void
  title?: string
  message?: string
  children?: ReactNode
  /** Scroll the body when it is taller than this; the default suits a menu. */
  maxHeight?: number
  /**
   * An opaque sheet for a form: through the glass of a sheet sized to its content, the list
   * behind showed as smudges around the fields.
   */
  solid?: boolean
}) {
  const { c, scheme } = useTokens()
  const window = Dimensions.get('window')
  return (
    <Host style={styles.host} colorScheme={scheme}>
      <SwiftSheet
        isPresented={props.visible}
        onIsPresentedChange={(presented) => {
          if (!presented) props.onClose()
        }}
        fitToContents
      >
        <Group modifiers={[presentationDragIndicator('visible'), preferredColorScheme(scheme)]}>
          <RNHostView matchContents>
            <View
              style={[
                styles.sheet,
                { width: window.width },
                props.solid && { backgroundColor: c.surface },
              ]}
            >
              {props.title || props.message ? (
                <View style={styles.head}>
                  {props.title ? (
                    <Text style={[typeScale.headline, { color: c.text }]} numberOfLines={2}>
                      {props.title}
                    </Text>
                  ) : null}
                  {props.message ? (
                    <Text style={[typeScale.footnote, { color: c.textSecondary }]}>
                      {props.message}
                    </Text>
                  ) : null}
                </View>
              ) : null}
              <ScrollView
                style={{
                  maxHeight: Math.min(props.maxHeight ?? window.height * 0.7, window.height - 160),
                }}
                contentContainerStyle={styles.body}
                bounces={false}
                keyboardShouldPersistTaps="handled"
                keyboardDismissMode="interactive"
              >
                {props.children}
              </ScrollView>
              <LockLayer />
            </View>
          </RNHostView>
        </Group>
      </SwiftSheet>
    </Host>
  )
}

const styles = StyleSheet.create({
  // The sheet is presented by the system; its host takes no room in the screen.
  host: { position: 'absolute', width: 0, height: 0 },
  sheet: { paddingTop: space.xl, paddingBottom: space.lg },
  head: {
    paddingHorizontal: space.xl,
    paddingTop: space.sm,
    paddingBottom: space.md,
    gap: space.xs,
  },
  body: { paddingHorizontal: space.lg, gap: space.md },
})
