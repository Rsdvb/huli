// Settings › 设备: the phones and computers paired with the computer, and taking one's access away;
// and the simulators and phones its agents may always use, and taking one off that list.

import { StyleSheet, View } from 'react-native'
import type { RemoteStatus } from '@shared/remote/status'
import { admin } from '../../admin'
import { useHost } from '../../host'
import {
  Button,
  call,
  confirm,
  GroupNote,
  ManagePage,
  ReadState,
  Tag,
  useActions,
  useConnected,
  useRead,
} from '../../manage/kit'
import { ago } from '../../sessions'
import { ListGroup, ListRow } from '../../ui/ListRow'
import { space } from '../../ui/tokens'

export default function DevicesSettings() {
  const host = useHost()
  const connected = useConnected()
  const remote = useRead<RemoteStatus>('remote', (link) => admin(link, 'remote.status'), [
    'remote.changed',
  ])
  const allowed = useRead<string[]>('allowed', (link) =>
    call(link, 'devices.allowed', {}).then((r) => r.deviceIds),
  )
  const actions = useActions()
  const me = host.state.kind === 'connected' ? host.state.welcome.device.id : null

  const removeDevice = async (id: string, name: string) => {
    const ok = await confirm({
      title: `移除「${name}」？`,
      message: '它会立刻断开，不能再使用这台电脑的会话。要再用，得重新配对。',
      confirm: '移除',
    })
    if (!ok || !host.link) return
    const done = await actions.run(
      `device:${id}`,
      async () => {
        const answer = await admin(host.link!, 'remote.removeDevice', { id })
        if (answer === 'not_removed') throw new Error('电脑没有移除这台设备。')
      },
      '没能移除',
    )
    if (done)
      remote.set((status) => ({ ...status, devices: status.devices.filter((d) => d.id !== id) }))
  }

  const forget = async (deviceId: string) => {
    if (!host.link) return
    const done = await actions.run(
      `allowed:${deviceId}`,
      () => call(host.link!, 'devices.forget', { deviceId }),
      '没能移除',
    )
    if (done) allowed.set((ids) => ids.filter((id) => id !== deviceId))
  }

  const devices = remote.value
    ? [...remote.value.devices].sort(
        (a, b) => (b.lastConnectedAt ?? b.addedAt) - (a.lastConnectedAt ?? a.addedAt),
      )
    : null

  return (
    <ManagePage title="设备" onRefresh={() => Promise.all([remote.reload(), allowed.reload()])}>
      {devices === null ? (
        <ReadState read={remote} what="设备" icon="phone" rows={2} />
      ) : (
        <ListGroup
          header="已配对的设备"
          footer="这些设备能使用这台电脑的会话。要移除这台手机，请到「已配对的电脑」里解除配对。"
        >
          {devices.map((device) => {
            const online = remote.value?.online.includes(device.id) ?? false
            const mine = device.id === me
            return (
              <ListRow
                key={device.id}
                title={device.name}
                subtitle={[
                  device.model || null,
                  device.platform || null,
                  online
                    ? '在线'
                    : device.lastConnectedAt
                      ? `${ago(device.lastConnectedAt)}连接过`
                      : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                icon={device.kind === 'desktop' || device.kind === 'web' ? 'laptop' : 'phone'}
                plainIcon
                trailing={
                  mine ? (
                    <Tag label="这台手机" tone="tint" />
                  ) : (
                    <Button
                      label="移除"
                      tone="danger"
                      busy={actions.busy(`device:${device.id}`)}
                      disabled={!connected}
                      onPress={() => void removeDevice(device.id, device.name)}
                    />
                  )
                }
              />
            )
          })}
        </ListGroup>
      )}

      <View style={styles.section}>
        {allowed.value === null ? (
          allowed.error ? (
            <GroupNote tone="error">{allowed.error}</GroupNote>
          ) : connected ? (
            <GroupNote>正在读取…</GroupNote>
          ) : null
        ) : allowed.value.length === 0 ? (
          <ListGroup
            header="始终允许的设备"
            footer="Agent 使用这些设备前不再询问。移除后，下一次使用时会重新询问。"
          >
            <ListRow
              title="还没有始终允许的设备"
              subtitle="Agent 询问时选“始终允许这台设备”即可。"
            />
          </ListGroup>
        ) : (
          <ListGroup
            header="始终允许的设备"
            footer="Agent 使用这些设备前不再询问。移除后，下一次使用时会重新询问。"
          >
            {allowed.value.map((deviceId) => (
              <ListRow
                key={deviceId}
                title={deviceId}
                icon="phone"
                plainIcon
                trailing={
                  <Button
                    label="移除"
                    busy={actions.busy(`allowed:${deviceId}`)}
                    disabled={!connected}
                    onPress={() => void forget(deviceId)}
                  />
                }
              />
            ))}
          </ListGroup>
        )}
      </View>
    </ManagePage>
  )
}

const styles = StyleSheet.create({
  section: { gap: space.sm },
})
