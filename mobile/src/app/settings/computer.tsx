// Settings › 已配对的电脑 › one computer: how the phone reaches it, the addresses it tries, and
// switching to it, renaming, reconnecting or unpairing. Without an `id`, the active computer.

import { useEffect, useState } from 'react'
import { Animated, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router, useLocalSearchParams } from 'expo-router'
import type { DirectAddress } from '@shared/remote/protocol'
import {
  lineColor,
  useComputerActions,
  useComputerLine,
  useReach,
} from '../../components/ComputerSheet'
import { currentAddress, routeKind, usableAddresses } from '../../connection'
import { useHost } from '../../host'
import { hostPort, osName, platformOf, ROUTE_NAMES } from '../../linkInfo'
import { ago } from '../../sessions'
import { computerName } from '../../store'
import { EmptyState } from '../../ui/EmptyState'
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
  const params = useLocalSearchParams<{ id?: string }>()
  const header = useCollapsingHeader()
  const insets = useSafeAreaInsets()
  const computer = params.id ? (host.computers.find((h) => h.id === params.id) ?? null) : host.host
  const active = !!computer && computer.id === host.host?.id
  const reach = useReach(!active)
  const line = useComputerLine(reach)
  const actions = useComputerActions()
  const [address, setAddress] = useState<DirectAddress | null>(() => currentAddress())
  const welcome = active && host.state.kind === 'connected' ? host.state.welcome : null
  const connected = welcome !== null

  useEffect(() => {
    if (!active) return
    setAddress(currentAddress())
    const timer = setInterval(() => setAddress(currentAddress()), 2000)
    return () => clearInterval(timer)
  }, [active, host.state])

  if (!computer) {
    return (
      <Screen readable>
        <View style={{ paddingTop: header.height }}>
          <EmptyState
            icon="desktop"
            title="这台电脑已解除配对"
            action={{ label: '返回', onPress: () => router.back() }}
          />
        </View>
        <NavBar header={header} title="电脑" titleAlways />
      </Screen>
    )
  }

  const status = line(computer)
  const platform = platformOf(computer, welcome?.host.platform)
  const addresses = usableAddresses(computer.addresses)
  const current = connected && address ? hostPort(address) : null
  const busy = actions.busy.has(computer.id)

  return (
    <Screen readable>
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
          <Text style={[typeScale.title, styles.center, { color: c.text }]} numberOfLines={2}>
            {computerName(computer)}
          </Text>
          <View style={styles.statusLine}>
            <View style={[styles.dot, { backgroundColor: lineColor(c, status.tone) }]} />
            <Text style={[typeScale.subhead, styles.shrink, { color: c.textSecondary }]}>
              {status.text}
            </Text>
          </View>
        </View>

        <ListGroup>
          <ListRow
            title="在手机上的名称"
            value={computerName(computer)}
            chevron
            onPress={() => actions.rename(computer)}
          />
          {computer.label ? <ListRow title="电脑自己的名称" value={computer.name} /> : null}
          <ListRow title="系统" value={osName(platform)} />
          {welcome ? <ListRow title="电脑上的 Huli" value={welcome.host.version} /> : null}
          <ListRow title="这台 iPhone 在电脑上叫" value={computer.deviceName || '—'} />
          {!active ? (
            <ListRow
              title="上次在线"
              value={computer.lastSeen ? ago(computer.lastSeen) : '还没连上过'}
            />
          ) : null}
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
          {!active ? (
            <ListRow
              title="切换到这台电脑"
              icon="desktop"
              plainIcon
              action
              disabled={busy}
              onPress={() => actions.switchTo(computer)}
            />
          ) : null}
          {active && !connected ? (
            <ListRow
              title="立即重连"
              icon="refresh"
              plainIcon
              action
              onPress={() => {
                haptic.tap()
                host.retry()
              }}
            />
          ) : null}
          <ListRow
            title={busy ? '正在解除配对…' : '解除配对'}
            destructive
            disabled={busy}
            leading={<Icon name="close" size={18} color={c.danger} />}
            onPress={() =>
              actions.unpair(computer, () => {
                if (router.canGoBack()) router.back()
              })
            }
          />
        </ListGroup>
      </Animated.ScrollView>
      <NavBar header={header} title={computerName(computer)} titleAlways />
      {actions.element}
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
  center: { textAlign: 'center' },
  statusLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm - 2 },
  shrink: { flexShrink: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
})
