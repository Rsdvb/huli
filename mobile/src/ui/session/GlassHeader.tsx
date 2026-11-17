// The session screens' header: a round back button, a centered title that may open a menu, and
// round buttons on the right, over frosted glass the conversation scrolls under.

import type { ReactNode } from 'react'
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { BlurView } from 'expo-blur'
import { router } from 'expo-router'
import { useSessionPane } from '../../components/SessionPane'
import { G, Icon } from './icons'
import { useSessionTokens } from './palette'
import { RoundButton } from './Press'

export const HEADER_BAR = 60

export function useHeaderHeight(modal = false): number {
  const insets = useSafeAreaInsets()
  return (modal && Platform.OS === 'ios' ? 8 : insets.top) + HEADER_BAR
}

export function goBack(): void {
  if (router.canGoBack()) router.back()
  else router.replace('/')
}

export function GlassHeader(props: {
  title: string
  subtitle?: string | null
  /** Cuts a long subtitle at its start, as a path wants. */
  subtitlePath?: boolean
  /** Over the content, which scrolls under the glass; otherwise it takes its own room. */
  floating?: boolean
  /** A sheet presented modally: a close button instead of back, and no status bar room. */
  modal?: boolean
  onTitlePress?: () => void
  right?: ReactNode
}) {
  const { c, scheme } = useSessionTokens()
  const insets = useSafeAreaInsets()
  // In the iPad split's pane there is nothing to go back to; the button empties the pane.
  const pane = useSessionPane()
  const top = props.modal && Platform.OS === 'ios' ? 8 : insets.top
  const glass = props.floating && Platform.OS === 'ios'
  return (
    <View
      style={[
        styles.root,
        { paddingTop: top, height: top + HEADER_BAR },
        props.floating ? styles.floating : null,
        !glass ? { backgroundColor: props.floating ? c.glass : c.bg } : null,
      ]}
    >
      {glass && (
        <BlurView
          style={StyleSheet.absoluteFill}
          intensity={60}
          tint={scheme === 'dark' ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'}
        />
      )}
      {props.floating && (
        <View style={[styles.hairline, { backgroundColor: c.border }]} pointerEvents="none" />
      )}
      <View style={styles.bar}>
        <RoundButton
          tone="glass"
          size={44}
          onPress={props.modal ? () => router.back() : (pane?.close ?? goBack)}
          accessibilityLabel={props.modal || pane ? '关闭' : '返回'}
        >
          {props.modal || pane ? (
            <Icon icon={G.close} size={17} color={c.text} weight="semibold" />
          ) : (
            <Icon
              icon={G.back}
              size={19}
              color={c.text}
              weight="semibold"
              style={{ marginLeft: -2 }}
            />
          )}
        </RoundButton>
        <Pressable
          style={styles.titleBox}
          onPress={props.onTitlePress}
          disabled={!props.onTitlePress}
          accessibilityRole={props.onTitlePress ? 'button' : 'header'}
          hitSlop={4}
        >
          {({ pressed }) => (
            <View style={{ alignItems: 'center', opacity: pressed ? 0.55 : 1 }}>
              <View style={styles.titleRow}>
                <Text style={[styles.title, { color: c.text }]} numberOfLines={1}>
                  {props.title}
                </Text>
                {props.onTitlePress && (
                  <View style={[styles.chevron, { backgroundColor: c.fill }]}>
                    <Icon
                      icon={G.down}
                      size={10}
                      color={c.textSecondary}
                      weight="bold"
                      strokeWidth={2.6}
                    />
                  </View>
                )}
              </View>
              {props.subtitle ? (
                <Text
                  style={[styles.subtitle, { color: c.textSecondary }]}
                  numberOfLines={1}
                  ellipsizeMode={props.subtitlePath ? 'head' : 'tail'}
                >
                  {props.subtitle}
                </Text>
              ) : null}
            </View>
          )}
        </Pressable>
        <View style={styles.right}>{props.right}</View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { zIndex: 10 },
  floating: { position: 'absolute', top: 0, left: 0, right: 0 },
  hairline: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
  },
  bar: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    gap: 8,
  },
  titleBox: { flex: 1, alignItems: 'center', justifyContent: 'center', minWidth: 0 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '100%' },
  title: { fontSize: 17, lineHeight: 22, fontWeight: '600', flexShrink: 1 },
  chevron: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  subtitle: { fontSize: 12, lineHeight: 16, marginTop: 1 },
  right: {
    minWidth: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
  },
})
