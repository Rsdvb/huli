// Settings › 账号: this phone's Huli Cloud sign-in. Signed out, signing in through the system's
// sign-in sheet; signed in, the account, this phone, the account's other devices and computers
// with when each was last seen, signing others out, the web page for the rest, and signing out.

import { useState } from 'react'
import { Linking, StyleSheet, Text, View } from 'react-native'
import type { AccountDevice, DeviceKind } from '@shared/huli-cloud'
import {
  ACCOUNT_PAGE_URL,
  revokeDevices,
  SIGN_IN_FAILURES,
  signIn,
  signOut,
  useAccountDevices,
  useCloudStatus,
} from '../../cloud'
import { AccountComputers } from '../../components/AccountComputers'
import { Button, confirm, GroupNote, ManagePage, SkeletonGroup, Tag } from '../../manage/kit'
import { ago } from '../../sessions'
import { haptic } from '../../ui/haptics'
import { HuliIcon } from '../../ui/HuliMark'
import { ListGroup, ListRow } from '../../ui/ListRow'
import { radius, space, type as typeScale, useTokens } from '../../ui/tokens'

const KIND_TEXT: Record<DeviceKind, string> = {
  desktop: 'Huli 桌面端',
  daemon: 'Huli 命令行',
  web: '网页版',
  mobile: '手机',
  other: '其他',
}

function deviceLine(device: AccountDevice): string {
  return [
    KIND_TEXT[device.kind],
    device.os,
    device.current ? '正在使用' : `最近使用 ${ago(device.lastUsedAt)}`,
  ]
    .filter(Boolean)
    .join(' · ')
}

export default function AccountSettings() {
  const { c } = useTokens()
  const cloud = useCloudStatus()
  const { list, reload } = useAccountDevices()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (key: string, work: () => Promise<unknown>, failed: string) => {
    setBusy(key)
    setError(null)
    try {
      await work()
    } catch (e) {
      haptic.warning()
      setError(`${failed}：${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const startSignIn = async () => {
    setError(null)
    const result = await signIn()
    if (result === 'signed-in') haptic.success()
    else if (result !== 'cancelled') {
      haptic.warning()
      setError(SIGN_IN_FAILURES[result])
    }
  }

  if (cloud.state !== 'signed-in') {
    return (
      <ManagePage title="账号">
        <View style={[styles.hero, { backgroundColor: c.surface, borderColor: c.border }]}>
          <HuliIcon size={56} />
          <View style={styles.flex}>
            <Text style={[typeScale.headline, { color: c.text }]}>Huli Cloud 账号</Text>
            <Text style={[typeScale.footnote, { color: c.textSecondary }]}>
              {cloud.state === 'signed-out' && cloud.reason === 'revoked'
                ? '这台手机已在别处退出登录。重新登录后，才能经中转连接电脑、看到账号里的电脑。'
                : '登录后，不在同一个网络也能经中转连上电脑，还能直接添加账号里的电脑，不用扫码。'}
            </Text>
          </View>
        </View>
        {error ? <GroupNote tone="error">{error}</GroupNote> : null}
        <Button
          label={cloud.state === 'signing-in' ? '正在登录…' : '登录 Huli Cloud'}
          tone="primary"
          wide
          busy={cloud.state === 'signing-in'}
          onPress={() => void startSignIn()}
        />
        <Text style={[typeScale.footnote, styles.note, { color: c.textTertiary }]}>
          登录在系统的登录页里完成，Huli 看不到你的密码。登录凭据只存在这台 iPhone
          的钥匙串里，不会同步到别的设备。
        </Text>
      </ManagePage>
    )
  }

  const account = cloud.account
  const devices = list.state === 'ready' ? list.devices.devices : null
  const me = devices?.find((d) => d.current) ?? null
  const others = devices?.filter((d) => !d.current) ?? []

  const revoke = async (device: AccountDevice) => {
    const ok = await confirm({
      title: `让「${device.name ?? KIND_TEXT[device.kind]}」退出登录？`,
      message:
        device.kind === 'desktop' || device.kind === 'daemon'
          ? '这台电脑会在一分钟内离开中转，账号里的电脑列表也不再有它，直到它重新登录。'
          : '它要重新登录才能再用这个账号。',
      confirm: '退出登录',
    })
    if (ok) await run(device.id, () => revokeDevices({ device: device.id }), '没能退出')
  }

  const revokeOthers = async () => {
    const ok = await confirm({
      title: '让其他设备都退出登录？',
      message: '除了这台 iPhone，账号下的手机、浏览器和电脑都要重新登录；电脑会离开中转。',
      confirm: '全部退出',
    })
    if (ok) await run('others', () => revokeDevices({ others: true }), '没能退出')
  }

  const leave = async () => {
    const ok = await confirm({
      title: '退出 Huli Cloud？',
      message: '这台 iPhone 不再经中转连接电脑；局域网和 Tailscale 照常。已配对的电脑都会留着。',
      confirm: '退出登录',
    })
    if (ok) await run('signout', () => signOut(), '没能退出')
  }

  return (
    <ManagePage title="账号" onRefresh={reload}>
      <View style={[styles.hero, { backgroundColor: c.surface, borderColor: c.border }]}>
        <HuliIcon size={56} />
        <View style={styles.flex}>
          <Text style={[typeScale.headline, { color: c.text }]} numberOfLines={1}>
            {account.name ?? account.email}
          </Text>
          <Text style={[typeScale.footnote, { color: c.textSecondary }]} numberOfLines={1}>
            {account.name ? account.email : 'Huli Cloud 账号'}
          </Text>
        </View>
      </View>

      {error ? <GroupNote tone="error">{error}</GroupNote> : null}

      {list.state === 'loading' ? <SkeletonGroup rows={3} header /> : null}
      {list.state === 'failed' ? (
        <GroupNote tone="error">读不到账号里的设备，下拉重试。</GroupNote>
      ) : null}

      {me ? (
        <ListGroup header="这台 iPhone">
          <ListRow
            title={me.name ?? 'iPhone'}
            subtitle={`登录于 ${ago(me.createdAt)}`}
            icon="phone"
            plainIcon
            trailing={<Tag label="这台" tone="tint" />}
          />
        </ListGroup>
      ) : null}

      {list.state === 'ready' ? (
        <AccountComputers
          header="电脑"
          footer="登录了这个账号、开着远程访问和中转的电脑。点未配对的电脑，在电脑上同意后就能连接，不用扫码。"
        />
      ) : null}

      {devices ? (
        <ListGroup header="其他设备" footer="登录了这个账号的手机、浏览器和电脑上的 Huli。">
          {others.length === 0 ? (
            <ListRow title="没有其他设备" />
          ) : (
            others.map((device) => (
              <ListRow
                key={device.id}
                title={device.name ?? KIND_TEXT[device.kind]}
                subtitle={deviceLine(device)}
                icon={
                  device.kind === 'mobile' ? 'phone' : device.kind === 'web' ? 'globe' : 'laptop'
                }
                plainIcon
                trailing={
                  <Button
                    label="退出"
                    tone="danger"
                    busy={busy === device.id}
                    onPress={() => void revoke(device)}
                  />
                }
              />
            ))
          )}
        </ListGroup>
      ) : null}

      <ListGroup footer="密码和两步验证在服务器上用 huli-cloud passwd / totp 修改；网页上能看到同样的设备列表。">
        {others.length > 0 ? (
          <ListRow
            title="让其他设备都退出登录"
            icon="signOut"
            plainIcon
            destructive
            disabled={busy !== null}
            onPress={() => void revokeOthers()}
          />
        ) : null}
        <ListRow
          title="在网页上管理账号"
          icon="globe"
          plainIcon
          external
          onPress={() => void Linking.openURL(ACCOUNT_PAGE_URL)}
        />
        <ListRow
          title="退出登录"
          icon="signOut"
          plainIcon
          destructive
          disabled={busy !== null}
          onPress={() => void leave()}
        />
      </ListGroup>
    </ManagePage>
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
  note: { marginHorizontal: space.lg },
})
