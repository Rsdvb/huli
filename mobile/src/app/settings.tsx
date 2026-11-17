// Settings: the paired computer, how the phone reaches it, unpairing, and the app's version.

import { useEffect, useState } from 'react'
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import Constants from 'expo-constants'
import { Stack, router } from 'expo-router'
import type { DirectAddress } from '@shared/remote/protocol'
import { APP_VERSION, currentAddress, routeKind } from '../connection'
import { useHost } from '../host'
import { pushStatusText, usePushStatus } from '../push/sync'
import { useTheme } from '../theme'

const ROUTE_NAMES = { tailscale: 'Tailscale', lan: '局域网', other: '直连' } as const

function hostPort(address: DirectAddress): string {
  return address.host.includes(':')
    ? `[${address.host}]:${address.port}`
    : `${address.host}:${address.port}`
}

export default function Settings() {
  const theme = useTheme()
  const host = useHost()
  const pushText = pushStatusText(usePushStatus())
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

  const status =
    host.state.kind === 'connected'
      ? '已连接'
      : host.state.kind === 'connecting'
        ? '正在连接…'
        : host.state.kind === 'reconnecting'
          ? '正在重连…'
          : '已断开'

  const unpair = () =>
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

  const row = (label: string, value: string, last = false) => (
    <View
      style={[
        styles.row,
        !last && { borderBottomColor: theme.line, borderBottomWidth: StyleSheet.hairlineWidth },
      ]}
    >
      <Text style={{ color: theme.text, fontSize: 15 }}>{label}</Text>
      <Text style={[styles.value, { color: theme.muted }]} numberOfLines={1}>
        {value}
      </Text>
    </View>
  )

  const version = Constants.expoConfig?.version ?? APP_VERSION

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.bg }}
      contentContainerStyle={{ padding: 16, gap: 8 }}
    >
      <Stack.Screen options={{ title: '设置' }} />

      <Text style={[styles.heading, { color: theme.muted }]}>电脑</Text>
      <View style={[styles.group, { backgroundColor: theme.card, borderColor: theme.line }]}>
        {row('名称', saved?.name ?? '—')}
        {welcome && row('Huli 版本', welcome.host.version)}
        {row('这台手机在电脑上叫', saved?.deviceName ?? '—', true)}
      </View>

      <Text style={[styles.heading, { color: theme.muted }]}>连接</Text>
      <View style={[styles.group, { backgroundColor: theme.card, borderColor: theme.line }]}>
        {row('状态', status)}
        {row(
          '线路',
          connected && address ? `${ROUTE_NAMES[routeKind(address)]} · ${hostPort(address)}` : '—',
          true,
        )}
      </View>
      <Text style={[styles.hint, { color: theme.muted }]}>
        手机先试 Tailscale 地址，再试局域网地址，连上哪个用哪个。
      </Text>

      {pushText && (
        <>
          <Text style={[styles.heading, { color: theme.muted }]}>通知</Text>
          <View
            style={[
              styles.group,
              styles.note,
              { backgroundColor: theme.card, borderColor: theme.line },
            ]}
          >
            <Text style={{ color: theme.text, fontSize: 15, lineHeight: 21 }}>{pushText}</Text>
          </View>
        </>
      )}

      <Pressable
        onPress={unpair}
        style={({ pressed }) => [
          styles.group,
          styles.danger,
          { backgroundColor: theme.card, borderColor: theme.line, opacity: pressed ? 0.7 : 1 },
        ]}
      >
        <Text style={{ color: theme.danger, fontSize: 16, fontWeight: '600' }}>解除配对</Text>
      </Pressable>

      <Text style={[styles.heading, { color: theme.muted }]}>关于</Text>
      <View style={[styles.group, { backgroundColor: theme.card, borderColor: theme.line }]}>
        {row('App 版本', version, true)}
      </View>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  heading: { fontSize: 13, marginTop: 12, marginLeft: 4 },
  group: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  value: { fontSize: 15, flexShrink: 1, textAlign: 'right' },
  hint: { fontSize: 12, marginLeft: 4, lineHeight: 17 },
  danger: { alignItems: 'center', paddingVertical: 14, marginTop: 16 },
  note: { paddingHorizontal: 16, paddingVertical: 13 },
})
