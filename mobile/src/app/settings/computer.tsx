// Settings › 已配对的电脑: the computer this phone is paired with, the addresses it tries, and
// reconnecting or unpairing.

import { useEffect, useState } from 'react'
import { Alert, Animated, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import type { DirectAddress } from '@shared/remote/protocol'
import { admin } from '../../admin'
import { toneColor } from '../../components/shell'
import { currentAddress, routeKind, usableAddresses } from '../../connection'
import { useHost } from '../../host'
import { hostPort, linkStatus, osName, ROUTE_NAMES } from '../../linkInfo'
import { haptic } from '../../ui/haptics'
import { Icon } from '../../ui/Icon'
import { ListGroup, ListRow } from '../../ui/ListRow'
import { NavBar } from '../../ui/NavBar'
import { OsIcon } from '../../ui/OsIcon'
import { Screen } from '../../ui/Screen'
import { useCollapsingHeader } from '../../ui/ScrollHeader'
import { radius, space, type as typeScale, useTokens } from '../../ui/tokens'

export default function Computer() {
  const { c } = useTokens()
  const host = useHost()
  const header = useCollapsingHeader()
  const insets = useSafeAreaInsets()
  const [address, setAddress] = useState<DirectAddress | null>(() => currentAddress())
  const welcome = host.state.kind === 'connected' ? host.state.welcome : null
  const connected = welcome !== null
  const status = linkStatus(host.state)
  const platform = welcome?.host.platform ?? host.host?.platform

  useEffect(() => {
    setAddress(currentAddress())
    const timer = setInterval(() => setAddress(currentAddress()), 2000)
    return () => clearInterval(timer)
  }, [host.state])

  const addresses = usableAddresses(host.host?.addresses ?? [])
  const current = connected && address ? hostPort(address) : null

  const unpair = () => {
    haptic.warning()
    const link = host.link
    Alert.alert(
      '解除配对？',
      connected
        ? '电脑会移除这台 iPhone，这台 iPhone 也会忘掉这台电脑。之后要重新扫码配对。'
        : '这台 iPhone 会忘掉这台电脑，之后要重新扫码配对。电脑那边可以在设置 › 远程访问里移除它。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '解除配对',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              if (link && welcome) {
                const timeout = new Promise((resolve) => setTimeout(resolve, 4000))
                await Promise.race([
                  admin(link, 'remote.removeDevice', { id: welcome.device.id }),
                  timeout,
                ]).catch(() => {})
              }
              if (router.canDismiss()) router.dismissAll()
              await host.forget(null)
            })()
          },
        },
      ],
    )
  }

  return (
    <Screen>
      <Animated.ScrollView
        {...header.scrollProps}
        contentContainerStyle={{
          paddingTop: header.contentTop + space.md,
          paddingHorizontal: space.lg,
          paddingBottom: insets.bottom + space.xxxl,
          gap: space.xxl,
        }}
      >
        <View style={styles.hero}>
          <View style={[styles.heroIcon, { backgroundColor: c.fill }]}>
            <OsIcon platform={platform} size={30} />
          </View>
          <Text style={[typeScale.title, { color: c.text }]} numberOfLines={1}>
            {host.host?.name ?? '电脑'}
          </Text>
          <View style={styles.statusLine}>
            <View style={[styles.dot, { backgroundColor: toneColor(c, status.tone) }]} />
            <Text style={[typeScale.subhead, { color: c.textSecondary }]}>{status.text}</Text>
          </View>
        </View>

        <ListGroup>
          <ListRow title="系统" value={osName(platform)} />
          <ListRow title="电脑上的 Huli" value={welcome?.host.version ?? '—'} />
          <ListRow title="这台 iPhone 在电脑上叫" value={host.host?.deviceName ?? '—'} />
        </ListGroup>

        <ListGroup
          header="地址"
          footer="手机先试 Tailscale 地址，再试局域网地址，连上哪个用哪个。内容在两端之间端到端加密，不经过任何中转服务器。"
        >
          {addresses.length === 0 ? (
            <ListRow title="电脑没有给出地址" />
          ) : (
            addresses.map((a) => {
              const text = hostPort(a)
              return (
                <ListRow
                  key={text}
                  title={ROUTE_NAMES[routeKind(a)]}
                  subtitle={text}
                  trailing={
                    text === current ? (
                      <Text style={[typeScale.footnote, { color: c.success }]}>当前线路</Text>
                    ) : undefined
                  }
                />
              )
            })
          )}
        </ListGroup>

        <ListGroup>
          {connected ? null : (
            <ListRow
              title="立即重连"
              icon="refresh"
              plainIcon
              action
              onPress={() => {
                haptic.tap()
                host.link?.wake()
              }}
            />
          )}
          <ListRow
            title="解除配对"
            destructive
            leading={<Icon name="close" size={18} color={c.danger} />}
            onPress={unpair}
          />
        </ListGroup>
      </Animated.ScrollView>
      <NavBar header={header} title="已配对的电脑" titleAlways />
    </Screen>
  )
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', gap: space.sm, paddingTop: space.md },
  heroIcon: {
    width: 72,
    height: 72,
    borderRadius: radius.xl,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xs,
  },
  statusLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm - 2 },
  dot: { width: 8, height: 8, borderRadius: 4 },
})
