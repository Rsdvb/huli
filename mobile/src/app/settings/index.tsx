// Settings: who this phone is on the computer, how it reaches it, notifications, unpairing, and
// the app's version.

import { useEffect, useState } from 'react'
import { Alert, Animated, StyleSheet, Text, View } from 'react-native'
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context'
import Constants from 'expo-constants'
import { router } from 'expo-router'
import type { DirectAddress } from '@shared/remote/protocol'
import { toneColor } from '../components/shell'
import { useUpdateRows } from '../components/UpdateRows'
import { APP_VERSION, currentAddress, routeKind } from '../connection'
import { useHost } from '../host'
import { hostPort, linkStatus, osName, ROUTE_NAMES } from '../linkInfo'
import { pushStatusText, usePushStatus } from '../push/sync'
import { haptic } from '../ui/haptics'
import { Icon } from '../ui/Icon'
import { LargeTitle } from '../ui/LargeTitle'
import { ListGroup, ListRow } from '../ui/ListRow'
import { NavBar } from '../ui/NavBar'
import { OsIcon } from '../ui/OsIcon'
import { Screen } from '../ui/Screen'
import { useCollapsingHeader } from '../ui/ScrollHeader'
import { radius, space, type as typeScale, useTokens } from '../ui/tokens'
import { UPDATES_SUPPORTED } from '../update'

// A sheet measures its own safe area: under the root's, its top would leave a status bar's gap.
export default function Settings() {
  return (
    <SafeAreaProvider>
      <SettingsPage />
    </SafeAreaProvider>
  )
}

function SettingsPage() {
  const { c } = useTokens()
  const host = useHost()
  const header = useCollapsingHeader()
  const insets = useSafeAreaInsets()
  const pushText = pushStatusText(usePushStatus())
  const updateRows = useUpdateRows()
  const [address, setAddress] = useState<DirectAddress | null>(() => currentAddress())
  const connected = host.state.kind === 'connected'

  // The route can change under a kept link, as when the phone leaves the Wi-Fi.
  useEffect(() => {
    setAddress(currentAddress())
    const timer = setInterval(() => setAddress(currentAddress()), 2000)
    return () => clearInterval(timer)
  }, [host.state])

  const welcome = host.state.kind === 'connected' ? host.state.welcome : null
  const saved = host.host
  const status = linkStatus(host.state)
  const platform = welcome?.host.platform ?? saved?.platform
  const archived = [...host.sessions.values()].filter(
    (s) => s.parentId === null && s.archivedAt !== null,
  ).length

  const unpair = () => {
    haptic.warning()
    Alert.alert(
      '解除配对？',
      '这台手机会忘掉这台电脑，之后要重新扫码配对。电脑那边可以在设置 › 远程访问里移除这台手机。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '解除配对',
          style: 'destructive',
          onPress: () => {
            if (router.canDismiss()) router.dismissAll()
            void host.forget(null)
          },
        },
      ],
    )
  }

  const version = Constants.expoConfig?.version ?? APP_VERSION

  return (
    <Screen>
      <Animated.ScrollView
        {...header.scrollProps}
        contentContainerStyle={{
          paddingTop: header.contentTop,
          paddingHorizontal: space.lg,
          paddingBottom: insets.bottom + space.xxxl,
          gap: space.xxl,
        }}
      >
        <View style={styles.titlePad}>
          <LargeTitle title="设置" />
        </View>

        <View style={[styles.hero, { backgroundColor: c.surface, borderColor: c.border }]}>
          <View style={[styles.heroIcon, { backgroundColor: c.fill }]}>
            <OsIcon platform={platform} size={26} />
          </View>
          <View style={styles.flex}>
            <Text style={[typeScale.headline, { color: c.text }]} numberOfLines={1}>
              {saved?.name ?? '电脑'}
            </Text>
            <View style={styles.statusLine}>
              <View style={[styles.dot, { backgroundColor: toneColor(c, status.tone) }]} />
              <Text style={[typeScale.footnote, { color: c.textSecondary }]} numberOfLines={1}>
                {status.text}
                {welcome ? ` · Huli ${welcome.host.version}` : ''}
              </Text>
            </View>
          </View>
        </View>

        <ListGroup header="电脑">
          <ListRow title="系统" value={osName(platform)} icon="desktop" />
          <ListRow title="这台手机在电脑上叫" value={saved?.deviceName ?? '—'} icon="phone" />
        </ListGroup>

        <ListGroup header="连接" footer="手机先试 Tailscale 地址，再试局域网地址，连上哪个用哪个。">
          <ListRow
            title="线路"
            icon="wifi"
            value={
              connected && address
                ? `${ROUTE_NAMES[routeKind(address)]} · ${hostPort(address)}`
                : '—'
            }
          />
          {!connected ? (
            <ListRow
              title="立即重连"
              icon="refresh"
              iconTint={c.tint}
              action
              onPress={() => {
                haptic.tap()
                host.link?.wake()
              }}
            />
          ) : null}
        </ListGroup>

        {pushText ? (
          <ListGroup header="通知">
            <ListRow title={pushText} icon="bell" />
          </ListGroup>
        ) : null}

        <ListGroup header="会话">
          <ListRow
            title="已归档的会话"
            icon="archive"
            value={archived > 0 ? String(archived) : undefined}
            chevron
            onPress={() => {
              // A card pushed under a modal would open behind it, so the modal leaves first.
              router.dismiss()
              router.push('/archived')
            }}
          />
        </ListGroup>

        <ListGroup header="关于">
          <ListRow title="App 版本" value={version} icon="info" />
          {UPDATES_SUPPORTED ? updateRows : null}
        </ListGroup>

        <ListGroup>
          <ListRow title="解除配对" destructive onPress={unpair} />
        </ListGroup>

        <View style={styles.footer}>
          <Icon name="sparkles" size={14} color={c.textTertiary} />
          <Text style={[typeScale.caption, { color: c.textTertiary }]}>Huli {version}</Text>
        </View>
      </Animated.ScrollView>
      <NavBar header={header} title="设置" kind="close" />
    </Screen>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  titlePad: { paddingHorizontal: space.xs },
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md + 2,
    padding: space.lg,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  heroIcon: {
    width: 52,
    height: 52,
    borderRadius: radius.md + 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm - 2, marginTop: 2 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs + 2,
  },
})
