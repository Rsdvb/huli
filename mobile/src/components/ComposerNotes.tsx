// Notes over a session's composer, as the desktop shows them at the box's top edge: the agent
// picked to take the session over with the next message (composer/switch-strip.tsx), and the
// prompt cache that expired while a message is being written (composer/cache-notice.tsx).

import { Pressable, StyleSheet, Switch, Text, View } from 'react-native'
import Reanimated, { FadeIn, FadeOut } from 'react-native-reanimated'
import type { ConfigOption } from '@shared/thread'
import { tokensText } from '../ui/session/limits'
import { G, Icon } from '../ui/session/icons'
import { useSessionTokens } from '../ui/session/palette'
import { optionName, shortModelName } from '../ui/session/optionText'
import { modelName, optionOf, shownChoice } from './ConfigMenus'

function shown(config: readonly ConfigOption[], category: 'model' | 'mode'): string | null {
  const option = optionOf(config, category)
  if (!option) return null
  const choice = shownChoice(option)
  if (!choice) return String(option.value)
  return category === 'model' ? shortModelName(choice) : optionName(modelName(choice.name))
}

export function SwitchStrip(props: {
  agentName: string
  /** The options it will start with, as the menus show them. */
  config: readonly ConfigOption[]
  summarize: boolean
  onSummarize(on: boolean): void
  onUndo(): void
}) {
  const { c, s } = useSessionTokens()
  const settings = [shown(props.config, 'model'), shown(props.config, 'mode')]
    .filter(Boolean)
    .join(' · ')
  return (
    <Reanimated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(140)}
      style={[styles.note, { backgroundColor: s.dockCard, borderColor: c.border }]}
      accessibilityLiveRegion="polite"
    >
      <View style={styles.head}>
        <Icon icon={G.swap} size={15} color={c.textTertiary} />
        <View style={styles.body}>
          <Text style={[styles.text, { color: c.text }]}>
            从下一条消息起由 {props.agentName} 接手，前面的对话会带过去。
          </Text>
          {settings ? (
            <Text style={[styles.small, { color: c.textTertiary }]}>{settings}</Text>
          ) : null}
        </View>
      </View>
      <View style={styles.actions}>
        <Pressable
          onPress={() => props.onSummarize(!props.summarize)}
          accessibilityRole="switch"
          accessibilityState={{ checked: props.summarize }}
          accessibilityLabel="先总结再接着做"
          accessibilityHint={`${props.agentName} 先读完前面的对话写一份总结再接着做，用的是它自己的额度。`}
          style={styles.toggle}
        >
          <Switch
            value={props.summarize}
            onValueChange={props.onSummarize}
            trackColor={{ true: c.accent, false: c.fillStrong }}
            style={styles.switch}
          />
          <Text style={[styles.small, { color: c.textSecondary }]}>先总结再接着做</Text>
        </Pressable>
        <Pressable
          onPress={props.onUndo}
          hitSlop={8}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.undo,
            { borderColor: c.border, backgroundColor: pressed ? c.fill : 'transparent' },
          ]}
        >
          <Text style={[styles.undoText, { color: c.text }]}>撤销</Text>
        </Pressable>
      </View>
    </Reanimated.View>
  )
}

/**
 * Over the box when a message is begun on a prompt cache that has expired: sending it reads the
 * whole context again at full price.
 */
export function CacheNotice(props: { estimate: boolean; used: number; onDismiss(): void }) {
  const { c, s } = useSessionTokens()
  const tokens = tokensText(props.used)
  return (
    <Reanimated.View
      entering={FadeIn.duration(180)}
      exiting={FadeOut.duration(140)}
      style={[styles.note, styles.head, { backgroundColor: s.warningSoft, borderColor: c.border }]}
      accessibilityRole="alert"
    >
      <Icon icon={G.timer} size={15} color={c.warning} />
      <View style={styles.body}>
        <Text style={[styles.title, { color: c.text }]}>
          {props.estimate ? '提示缓存可能已过期' : '提示缓存已过期'}
        </Text>
        <Text style={[styles.small, { color: c.textSecondary }]}>
          {props.estimate
            ? `如果已过期，下一条消息会按全价重新读取约 ${tokens} token。`
            : `下一条消息会按全价重新读取约 ${tokens} token。`}
        </Text>
      </View>
      <Pressable
        onPress={props.onDismiss}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="关闭"
      >
        <Icon icon={G.close} size={13} color={c.textSecondary} weight="semibold" />
      </Pressable>
    </Reanimated.View>
  )
}

const styles = StyleSheet.create({
  note: {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  body: { flex: 1, minWidth: 0, gap: 2 },
  text: { fontSize: 14, lineHeight: 20 },
  title: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
  small: { fontSize: 12.5, lineHeight: 17 },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingLeft: 25 },
  toggle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  switch: { transform: [{ scale: 0.75 }], marginVertical: -6, marginLeft: -6 },
  undo: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 12,
    height: 28,
    justifyContent: 'center',
  },
  undoText: { fontSize: 13, fontWeight: '600' },
})
