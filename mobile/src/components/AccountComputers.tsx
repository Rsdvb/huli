// 全部电脑: the computers of the phone's Huli Cloud account, in the computer sheet and on the
// pairing screen. One the phone is paired with switches to it; one it is not is marked 未配对 and
// opens the request to pair with it, which its owner allows on the computer.

import { router } from 'expo-router'
import type { AccountComputer } from '@shared/huli-cloud'
import { pairedWith, useAccountDevices, useCloudStatus } from '../cloud'
import { useComputers } from '../host'
import { Tag } from '../manage/kit'
import { ago } from '../sessions'
import { computerName } from '../store'
import { ListGroup, ListRow } from '../ui/ListRow'
import { OsIcon } from '../ui/OsIcon'

export function computerLine(computer: AccountComputer): string {
  if (!computer.online) return `最近在线 ${ago(computer.lastSeen)}`
  return computer.pairable ? '在线' : '在线 · 没开「让账号下的设备找到这台电脑」'
}

/** Opens the request to pair with a computer of the account. */
export function pairAccountComputer(computer: AccountComputer): void {
  router.push({
    pathname: '/pair-computer',
    params: {
      id: computer.id,
      name: computer.name ?? '电脑',
      ...(computer.platform ? { platform: computer.platform } : {}),
    },
  })
}

/**
 * The account's computers as one group; nothing while signed out unless `signInRow`, which then
 * offers signing in. `before` runs before a row opens something, as closing a sheet.
 */
export function AccountComputers(props: {
  header?: string
  footer?: string
  signInRow?: boolean
  /** Leaves out the computers this phone is paired with. */
  unpairedOnly?: boolean
  before?: () => void
}) {
  const cloud = useCloudStatus()
  const { list } = useAccountDevices()
  const computers = useComputers()

  if (cloud.state !== 'signed-in') {
    if (!props.signInRow) return null
    return (
      <ListGroup header={props.header}>
        <ListRow
          title="用 Kite Cloud 账号登录"
          subtitle="登录后列出账号里的电脑，点一下就能添加，不用扫码。"
          icon="person"
          plainIcon
          chevron
          onPress={() => {
            props.before?.()
            router.push('/settings/account')
          }}
        />
      </ListGroup>
    )
  }
  if (list.state === 'loading') {
    return (
      <ListGroup header={props.header}>
        <ListRow title="正在读取账号里的电脑…" />
      </ListGroup>
    )
  }
  if (list.state !== 'ready') {
    return (
      <ListGroup header={props.header}>
        <ListRow title="读不到账号里的电脑" subtitle="检查网络后再打开这里。" />
      </ListGroup>
    )
  }
  const rows = list.devices.computers
    .map((computer) => ({ computer, paired: pairedWith(computer, computers.computers) }))
    .filter((row) => !props.unpairedOnly || !row.paired)
  if (rows.length === 0 && props.unpairedOnly) return null
  return (
    <ListGroup header={props.header} footer={props.footer}>
      {rows.length === 0 ? (
        <ListRow
          title="账号里还没有电脑"
          subtitle="在电脑上的纸鸢里登录 Kite Cloud，并在「远程访问」里开着中转。"
        />
      ) : (
        rows.map(({ computer, paired }) => (
          <ListRow
            key={computer.id}
            title={paired ? computerName(paired) : (computer.name ?? '未命名的电脑')}
            subtitle={computerLine(computer)}
            leading={<OsIcon platform={computer.platform ?? undefined} size={22} />}
            trailing={
              paired ? <Tag label="已配对" tone="success" /> : <Tag label="未配对" tone="neutral" />
            }
            chevron={!paired && computer.pairable}
            disabled={!paired && !computer.pairable}
            onPress={() => {
              if (paired) {
                props.before?.()
                computers.switchTo(paired.id)
              } else if (computer.pairable) {
                props.before?.()
                pairAccountComputer(computer)
              }
            }}
          />
        ))
      )}
    </ListGroup>
  )
}
