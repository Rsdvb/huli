// The session list's notice that the connected computer runs an older app than this phone, so
// some features fail there. Closing it hides it for that computer and version until the app restarts.

import { useSyncExternalStore } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { isOlderApp } from '@shared/remote/app-version'
import { APP_VERSION } from '../connection'
import { sameFields, useHostSelector, type HostData } from '../host'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { radius, space, type as typeScale, useTokens } from '../ui/tokens'

const dismissed = new Set<string>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function dismiss(key: string): void {
  dismissed.add(key)
  for (const listener of listeners) listener()
}

/** What to tell the user of the computer's version, or null when it is not older than ours. */
function hostVersionNotice(version: string | undefined): string | null {
  if (!version) return '电脑上的纸鸢是旧版，部分功能用不了。请更新电脑上的纸鸢。'
  if (!isOlderApp(version, APP_VERSION)) return null
  return `电脑上的纸鸢是旧版（${version}），部分功能用不了。请更新电脑上的纸鸢。`
}

const pick = (d: HostData) => ({
  computer: d.computers.active,
  version: d.state.kind === 'connected' ? d.state.welcome.host.version : null,
})

export function HostVersionBanner() {
  const { c } = useTokens()
  const { computer, version } = useHostSelector(pick, sameFields)
  const key = `${computer ?? ''}\n${version ?? ''}`
  const closed = useSyncExternalStore(subscribe, () => dismissed.has(key))
  if (version === null || closed) return null
  const text = hostVersionNotice(version)
  if (!text) return null

  return (
    <View
      style={[styles.banner, { backgroundColor: c.surface, borderColor: c.border }]}
      accessibilityLiveRegion="polite"
    >
      <View style={[styles.badge, { backgroundColor: c.fill }]}>
        <Icon name="info" size={16} color={c.warning} />
      </View>
      <Text style={[typeScale.footnote, styles.flex, { color: c.textSecondary }]}>{text}</Text>
      <IconButton
        icon="close"
        tone="plain"
        size={32}
        iconSize={14}
        color={c.textTertiary}
        label="关闭提示"
        onPress={() => dismiss(key)}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginTop: space.md,
    paddingLeft: space.md,
    paddingRight: space.xs,
    paddingVertical: space.sm,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  badge: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
