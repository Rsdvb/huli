// Settings: the computer's Huli Cloud account, this iPhone (its name there, notifications, the app
// lock), appearance, the paired computer and how the phone reaches it, and about.

import { useEffect, useState } from 'react'
import { Alert, Animated, Linking, StyleSheet, Switch, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Application from 'expo-application'
import Constants from 'expo-constants'
import { router } from 'expo-router'
import type { DirectAddress } from '@shared/remote/protocol'
import { GITHUB_URL, PRIVACY_URL } from '../../about'
import { admin } from '../../admin'
import { RenameDialog } from '../../components/RenameDialog'
import { Sheet } from '../../components/Sheet'
import { useUpdateRows } from '../../components/UpdateRows'
import { APP_VERSION, currentAddress, routeKind } from '../../connection'
import { useHost } from '../../host'
import { computerName } from '../../store'
import { ROUTE_NAMES } from '../../linkInfo'
import { LIVE_SUPPORTED, useLiveAllowed } from '../../live/activities'
import { authenticate, useBiometryName } from '../../lock'
import { setPrefs, usePrefs, type ThemePref } from '../../prefs'
import { usePushStatus, type PushStatus } from '../../push/sync'
import { useRoutineList } from '../../routines'
import { haptic } from '../../ui/haptics'
import { HuliIcon } from '../../ui/HuliMark'
import { Icon } from '../../ui/Icon'
import { ListGroup, ListRow } from '../../ui/ListRow'
import { NavBar } from '../../ui/NavBar'
import { Press } from '../../ui/Press'
import { Screen } from '../../ui/Screen'
import { useCollapsingHeader } from '../../ui/ScrollHeader'
import { radius, space, type as typeScale, useTokens } from '../../ui/tokens'
import { UPDATES_SUPPORTED } from '../../update'

const THEME_TEXT: Record<ThemePref, string> = { system: '跟随系统', light: '浅色', dark: '深色' }

const PUSH_TEXT: Record<PushStatus, string> = {
  pending: '—',
  unsupported: '不可用',
  off: '关闭',
  'signed-out': '暂收不到',
  on: '开启',
}

/** The computer's Huli Cloud account, as far as the phone can learn it. */
type Account = { kind: 'unknown' } | { kind: 'signed-out' } | { kind: 'signed-in'; email: string }

function useAccount(push: PushStatus): Account {
  const host = useHost()
  const [account, setAccount] = useState<Account>({ kind: 'unknown' })
  const connected = host.state.kind === 'connected'
  useEffect(() => {
    if (!connected || !host.link) return
    let live = true
    admin(host.link, 'sharing.status').then(
      (status) => {
        if (!live) return
        const email = status.kettu.account?.email
        setAccount(email ? { kind: 'signed-in', email } : { kind: 'signed-out' })
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [connected, host.link])
  // A computer that cannot say (the daemon) still tells notifications whether it is signed in.
  if (account.kind === 'unknown' && push === 'signed-out') return { kind: 'signed-out' }
  return account
}

export default function Settings() {
  const { c } = useTokens()
  const host = useHost()
  const prefs = usePrefs()
  const header = useCollapsingHeader()
  const insets = useSafeAreaInsets()
  const push = usePushStatus()
  const account = useAccount(push)
  const biometry = useBiometryName()
  const liveAllowed = useLiveAllowed()
  const updateRows = useUpdateRows()
  const routines = useRoutineList()
  const [address, setAddress] = useState<DirectAddress | null>(() => currentAddress())
  const [sheet, setSheet] = useState<'theme' | 'language' | null>(null)
  const [renaming, setRenaming] = useState(false)
  const connected = host.state.kind === 'connected'
  const welcome = host.state.kind === 'connected' ? host.state.welcome : null

  // The route can change under a kept link, as when the phone leaves the Wi-Fi.
  useEffect(() => {
    setAddress(currentAddress())
    const timer = setInterval(() => setAddress(currentAddress()), 2000)
    return () => clearInterval(timer)
  }, [host.state])

  const version =
    Application.nativeApplicationVersion ?? Constants.expoConfig?.version ?? APP_VERSION
  const build = Application.nativeBuildVersion
  const enabledRoutines = routines.data?.routines.filter((r) => r.enabled).length

  const toggleLock = async (on: boolean) => {
    const result = await authenticate(on ? `开启${biometry}锁定` : `关闭${biometry}锁定`)
    if (result.ok) {
      haptic.select()
      setPrefs({ lock: on })
    } else if (result.error === 'passcode_not_set' || result.error === 'not_available') {
      haptic.warning()
      Alert.alert('这台 iPhone 没有设置密码', '先在系统设置里设置锁屏密码，才能用它锁定 Huli。')
    }
  }

  const accountCard = (() => {
    if (account.kind === 'signed-in') {
      return { title: account.email, body: '电脑已登录 Huli Cloud，通知经它送到这台 iPhone。' }
    }
    if (account.kind === 'signed-out') {
      return {
        title: '未登录 Huli Cloud',
        body: '在电脑上的 Huli 里登录 Huli Cloud 后，这台 iPhone 才能收到通知。',
      }
    }
    return { title: 'Huli', body: '在 iPhone 上看你电脑上的智能体在做什么，随时接着聊。' }
  })()

  const route = connected && address ? ROUTE_NAMES[routeKind(address)] : '未连接'

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
        <View
          style={[styles.hero, { backgroundColor: c.surface, borderColor: c.border }]}
          accessible
          accessibilityLabel={`${accountCard.title}。${accountCard.body}`}
        >
          <HuliIcon size={56} />
          <View style={styles.flex}>
            <Text
              style={[
                typeScale.headline,
                { color: account.kind === 'signed-out' ? c.tint : c.text },
              ]}
              numberOfLines={1}
            >
              {accountCard.title}
            </Text>
            <Text style={[typeScale.footnote, { color: c.textSecondary }]}>{accountCard.body}</Text>
          </View>
        </View>

        <ListGroup
          header="这台 iPhone"
          footer={
            prefs.lock
              ? `离开 Huli 后它会锁定，再打开时需要${biometry}。`
              : `开启后，离开 Huli 一段时间它就会锁定，再打开时需要${biometry}。`
          }
        >
          <ListRow
            title="名称"
            icon="phone"
            plainIcon
            value={host.host?.deviceName ?? '—'}
            chevron={connected}
            disabled={!connected}
            onPress={() => setRenaming(true)}
          />
          <ListRow
            title="通知"
            icon="bell"
            plainIcon
            value={PUSH_TEXT[push]}
            chevron
            onPress={() => void Linking.openSettings()}
          />
          {LIVE_SUPPORTED ? (
            <ListRow
              title="实时活动"
              subtitle="在锁屏和灵动岛上显示会话进度"
              icon="timer"
              plainIcon
              {...(liveAllowed
                ? {
                    trailing: (
                      <Switch
                        value={prefs.liveActivities}
                        onValueChange={(on) => {
                          haptic.select()
                          setPrefs({ liveActivities: on })
                        }}
                        trackColor={{ true: c.success }}
                        accessibilityLabel="实时活动"
                      />
                    ),
                  }
                : {
                    value: '已在系统设置中关闭',
                    chevron: true,
                    onPress: () => void Linking.openSettings(),
                  })}
            />
          ) : null}
          <ListRow
            title={`需要${biometry}`}
            icon="faceId"
            plainIcon
            trailing={
              <Switch
                value={prefs.lock}
                onValueChange={(on) => void toggleLock(on)}
                trackColor={{ true: c.success }}
                accessibilityLabel={`需要${biometry}`}
              />
            }
          />
          <ListRow
            title={`${biometry}与锁定`}
            icon="lock"
            plainIcon
            chevron
            onPress={() => router.push('/settings/lock')}
          />
        </ListGroup>

        <ListGroup header="外观">
          <ListRow
            title="主题"
            icon="theme"
            plainIcon
            value={THEME_TEXT[prefs.theme]}
            trailing={<Icon name="upDown" size={14} color={c.textTertiary} weight="semibold" />}
            onPress={() => setSheet('theme')}
          />
          <ListRow
            title="语言"
            icon="language"
            plainIcon
            value="简体中文"
            chevron
            onPress={() => setSheet('language')}
          />
        </ListGroup>

        <ListGroup
          header="电脑"
          footer="定时任务按计划在你的电脑上运行，无论这台 iPhone 是否连得上。"
        >
          <ListRow
            title="已配对的电脑"
            icon="desktop"
            plainIcon
            value={
              host.computers.length > 1
                ? `${host.computers.length} 台 · 正在用 ${computerName(host.host)}`
                : computerName(host.host)
            }
            chevron
            onPress={() => router.push('/settings/computers')}
          />
          <ListRow
            title="定时任务"
            icon="history"
            plainIcon
            value={enabledRoutines === undefined ? '—' : `${enabledRoutines} 个开着`}
            chevron
            onPress={() => router.navigate('/routines')}
          />
          <ListRow
            title="已归档的会话"
            icon="archive"
            plainIcon
            chevron
            onPress={() => router.push('/archived')}
          />
        </ListGroup>

        <ListGroup
          header="连接"
          footer="手机先试 Tailscale 地址，再试局域网地址，连上哪个用哪个。电脑与这台 iPhone 之间的一切内容都经过端到端加密。"
        >
          <ListRow
            title="线路"
            icon="network"
            plainIcon
            value={route}
            chevron
            onPress={() => router.push('/settings/computer')}
          />
        </ListGroup>

        <ListGroup header="关于">
          <ListRow
            title="版本"
            icon="info"
            plainIcon
            value={build ? `${version} (${build})` : version}
          />
          {UPDATES_SUPPORTED ? updateRows : null}
          <ListRow
            title="GitHub"
            icon="code"
            plainIcon
            external
            onPress={() => void Linking.openURL(GITHUB_URL)}
          />
          <ListRow
            title="隐私"
            icon="hand"
            plainIcon
            external
            onPress={() => void Linking.openURL(PRIVACY_URL)}
          />
          <ListRow
            title="致谢"
            icon="doc"
            plainIcon
            chevron
            onPress={() => router.push('/settings/licenses')}
          />
        </ListGroup>

        <Press
          onPress={() => void Linking.openURL(GITHUB_URL)}
          scale={false}
          accessibilityRole="link"
          style={styles.footer}
        >
          <Text style={[typeScale.caption, { color: c.textTertiary }]}>
            Huli {version} · 基于 Kettu，AGPL-3.0
          </Text>
        </Press>
      </Animated.ScrollView>
      <NavBar header={header} title="设置" titleAlways />

      <Sheet
        visible={sheet === 'theme'}
        title="主题"
        items={(Object.keys(THEME_TEXT) as ThemePref[]).map((key) => ({
          key,
          label: THEME_TEXT[key],
          checked: prefs.theme === key,
          onPress: () => {
            haptic.select()
            setPrefs({ theme: key })
          },
        }))}
        onClose={() => setSheet(null)}
      />
      <Sheet
        visible={sheet === 'language'}
        title="语言"
        message="Huli 目前只有简体中文。"
        items={[{ key: 'zh', label: '简体中文', checked: true, onPress: () => {} }]}
        onClose={() => setSheet(null)}
      />
      <RenameDialog
        visible={renaming}
        heading="这台 iPhone 的名称"
        placeholder="名称"
        noReset
        maxLength={64}
        title={host.host?.deviceName ?? ''}
        onClose={() => setRenaming(false)}
        onSave={async (name) => {
          if (!name || !host.link || !welcome) throw new Error('名称不能为空。')
          const answer = await admin(host.link, 'remote.renameDevice', {
            id: welcome.device.id,
            name,
          })
          if (answer === 'not_renamed') throw new Error('电脑没有接受这个名称。')
          host.renamedDevice(name)
        }}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1, gap: 2 },
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    padding: space.lg,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  footer: { alignItems: 'center', paddingVertical: space.sm },
})
