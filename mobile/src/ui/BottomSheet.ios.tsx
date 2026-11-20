// A sheet from the bottom, as iOS presents its own: a SwiftUI sheet through @expo/ui, sized to its
// content, with the system's grabber, drag to dismiss and dimming, and Liquid Glass on iOS 26.
// Its content stays React Native's. BottomSheet.tsx is Android's.

import { useEffect, useState, type ReactNode } from 'react'
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native'
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
  // The height follows rotation and Split View; the width is the sheet's own, below.
  const window = useWindowDimensions()
  // A sheet not shown draws nothing: its content mounts as it opens, one frame before the system
  // presents it so the sheet sizes to it, and goes once the system has slid it away.
  const [mounted, setMounted] = useState(props.visible)
  const [ready, setReady] = useState(false)
  if (props.visible && !mounted) setMounted(true)
  useEffect(() => {
    if (props.visible) {
      if (ready) return
      const frame = requestAnimationFrame(() => setReady(true))
      return () => cancelAnimationFrame(frame)
    }
    if (!mounted) return
    const timer = setTimeout(() => {
      setMounted(false)
      setReady(false)
    }, DISMISSED_MS)
    return () => clearTimeout(timer)
  }, [props.visible, mounted, ready])
  return (
    <Host style={styles.host} colorScheme={scheme}>
      <SwiftSheet
        isPresented={props.visible && ready}
        onIsPresentedChange={(presented) => {
          if (!presented) props.onClose()
        }}
        fitToContents
      >
        <Group modifiers={[presentationDragIndicator('visible'), preferredColorScheme(scheme)]}>
          {/* The sheet's width, which on iPad is a form's rather than the window's; the height
              the content's. */}
          <RNHostView matchContents={{ vertical: true }}>
            {mounted ? (
              <View style={[styles.sheet, props.solid && { backgroundColor: c.surface }]}>
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
                    maxHeight: Math.min(
                      props.maxHeight ?? window.height * 0.7,
                      window.height - 160,
                    ),
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
            ) : (
              <View />
            )}
          </RNHostView>
        </Group>
      </SwiftSheet>
    </Host>
  )
}

/** How long the system takes to slide a dismissed sheet away, its content kept till then. */
const DISMISSED_MS = 600

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
