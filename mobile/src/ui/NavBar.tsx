// A pushed or presented screen's floating bar: a round glass back or close button, the title in
// the middle once the large title scrolls away, and an optional action on the right.

import type { ReactNode } from 'react'
import { Animated, StyleSheet, View } from 'react-native'
import { router } from 'expo-router'
import { GlassButton } from './Glass'
import { Icon } from './Icon'
import { FloatingHeader, type CollapsingHeader } from './ScrollHeader'
import { FONT_SCALE, type as typeScale, useTokens } from './tokens'

export function NavBar(props: {
  header: CollapsingHeader
  title: string
  /** Close for a modal, back for a pushed screen. */
  kind?: 'back' | 'close'
  right?: ReactNode
  /** Show the title at rest too, for a screen without a large title. */
  titleAlways?: boolean
}) {
  const { c } = useTokens()
  const close = props.kind === 'close'
  return (
    <FloatingHeader header={props.header}>
      <GlassButton
        silent
        accessibilityLabel={close ? '关闭' : '返回'}
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
      >
        <Icon name={close ? 'close' : 'chevronLeft'} size={close ? 18 : 20} color={c.text} />
      </GlassButton>
      <View style={styles.titleWrap} pointerEvents="none">
        <Animated.Text
          numberOfLines={1}
          maxFontSizeMultiplier={FONT_SCALE.dense}
          style={[
            typeScale.headline,
            { color: c.text, opacity: props.titleAlways ? 1 : props.header.progress },
          ]}
        >
          {props.title}
        </Animated.Text>
      </View>
      <View style={styles.right}>{props.right}</View>
    </FloatingHeader>
  )
}

const styles = StyleSheet.create({
  titleWrap: { flex: 1, alignItems: 'center' },
  right: { minWidth: 44, alignItems: 'flex-end' },
})
