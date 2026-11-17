// A sheet that rises from the bottom over a dimmed screen, with a grabber and a title. It stays
// mounted through its exit so it slides away instead of vanishing.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Animated,
  Dimensions,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { LockLayer } from '../lock'
import { Glass, useGlassMode } from './Glass'
import { useReduceMotion } from './Press'
import { motion, radius, space, type as typeScale, useTokens } from './tokens'

export function BottomSheet(props: {
  visible: boolean
  onClose(): void
  title?: string
  message?: string
  children?: ReactNode
  /** Scroll the body when it is taller than this; the default suits a menu. */
  maxHeight?: number
}) {
  const { c } = useTokens()
  const insets = useSafeAreaInsets()
  const reduce = useReduceMotion()
  const [mounted, setMounted] = useState(props.visible)
  const shown = useRef(new Animated.Value(0)).current
  const travel = Dimensions.get('window').height * 0.6
  const [keyboard, setKeyboard] = useState(0)
  // With Liquid Glass the sheet is glass that floats clear of the screen's edges, as iOS 26's do.
  const liquid = useGlassMode() === 'liquid'
  const inset = Math.max(insets.bottom - space.md, space.sm)

  // A sheet with a text field rides above the keyboard rather than under it; Android's window
  // already resizes for it.
  useEffect(() => {
    if (!mounted || Platform.OS !== 'ios') return
    const show = Keyboard.addListener('keyboardWillShow', (e) =>
      setKeyboard(e.endCoordinates.height),
    )
    const hide = Keyboard.addListener('keyboardWillHide', () => setKeyboard(0))
    return () => {
      show.remove()
      hide.remove()
    }
  }, [mounted])

  useEffect(() => {
    if (props.visible) {
      setMounted(true)
      Animated.timing(shown, {
        toValue: 1,
        duration: reduce ? motion.fast : motion.normal,
        useNativeDriver: true,
      }).start()
    } else {
      Animated.timing(shown, {
        toValue: 0,
        duration: motion.fast,
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) setMounted(false)
      })
    }
  }, [props.visible, reduce, shown])

  if (!mounted) return null
  const Surface = liquid ? GlassSheet : View

  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={props.onClose}
    >
      <Animated.View
        style={[StyleSheet.absoluteFill, { opacity: shown, backgroundColor: c.scrim }]}
      >
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={props.onClose}
          accessibilityLabel="关闭"
        />
      </Animated.View>
      <View style={styles.dock} pointerEvents="box-none">
        <Animated.View
          style={[
            {
              marginBottom: keyboard + (liquid ? (keyboard > 0 ? space.sm : inset) : 0),
              opacity: reduce ? shown : 1,
              transform: [
                {
                  translateY: reduce
                    ? 0
                    : shown.interpolate({ inputRange: [0, 1], outputRange: [travel, 0] }),
                },
              ],
            },
            liquid ? styles.floating : null,
          ]}
        >
          <Surface
            style={[
              styles.sheet,
              liquid
                ? styles.glassSheet
                : {
                    backgroundColor: c.surfaceRaised,
                    borderColor: c.border,
                    paddingBottom: keyboard > 0 ? space.md : Math.max(insets.bottom, space.lg),
                  },
            ]}
          >
            <View style={[styles.grabber, { backgroundColor: c.borderStrong }]} />
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
                  props.maxHeight ?? Dimensions.get('window').height * 0.7,
                  Dimensions.get('window').height - keyboard - insets.top - 120,
                ),
              }}
              contentContainerStyle={styles.body}
              bounces={false}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="interactive"
            >
              {props.children}
            </ScrollView>
          </Surface>
        </Animated.View>
      </View>
      <LockLayer />
    </Modal>
  )
}

function GlassSheet(props: { style?: StyleProp<ViewStyle>; children?: ReactNode }) {
  return (
    <Glass radius={SHEET_RADIUS} style={props.style}>
      {props.children}
    </Glass>
  )
}

const SHEET_RADIUS = 36

const styles = StyleSheet.create({
  dock: { flex: 1, justifyContent: 'flex-end' },
  floating: { marginHorizontal: space.sm },
  glassSheet: {
    borderWidth: 0,
    borderTopLeftRadius: SHEET_RADIUS,
    borderTopRightRadius: SHEET_RADIUS,
    paddingBottom: space.lg,
  },
  sheet: {
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: 0,
    paddingTop: space.sm,
  },
  grabber: { alignSelf: 'center', width: 36, height: 5, borderRadius: 3, marginBottom: space.sm },
  head: {
    paddingHorizontal: space.xl,
    paddingTop: space.sm,
    paddingBottom: space.md,
    gap: space.xs,
  },
  body: { paddingHorizontal: space.lg, gap: space.md },
})
