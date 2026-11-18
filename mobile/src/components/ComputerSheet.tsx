// The paired computers, from the top bar's computer mark: which one the app shows, whether each
// can be reached, and switching, renaming, adding and unpairing. Settings › 已配对的电脑 uses the
// same rows and actions.

import { useEffect, useState } from 'react'
import { ActivityIndicator, Alert, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import { currentAddress, probe, routeKind } from '../connection'
import { useComputers } from '../host'
import { linkStatusOf, platformOf, ROUTE_NAMES, type LinkTone } from '../linkInfo'
import { ago } from '../sessions'
import { computerName, type SavedHost } from '../store'
import { BottomSheet } from '../ui/BottomSheet'
import { ContextMenu, SYSTEM_MENUS, TapMenu } from '../ui/ContextMenu'
import { haptic } from '../ui/haptics'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { ListGroup, ListRow } from '../ui/ListRow'
import type { MenuNode } from '../ui/menu'
import { OsIcon } from '../ui/OsIcon'
import { Press } from '../ui/Press'
import { radius, space, type as typeScale, useTokens, type Palette } from '../ui/tokens'
import { RenameDialog } from './RenameDialog'

export type Reach = 'checking' | 'online' | 'offline'

const noop = () => {}

/** Whether each computer the app keeps no link to answers, checked while `watching`. */
export function useReach(watching: boolean): Map<string, Reach> {
  const host = useComputers()
  const [reach, setReach] = useState<Map<string, Reach>>(new Map())
  const others = host.computers.filter((h) => h.id !== host.host?.id)
  const key = others.map((h) => h.id).join(',')
  useEffect(() => {
    if (!watching) return
    let live = true
    const list = host.computers.filter((h) => h.id !== host.host?.id)
    setReach(new Map(list.map((h) => [h.id, 'checking' as const])))
    for (const h of list) {
      void probe(h.addresses).then((up) => {
        if (live) setReach((map) => new Map(map).set(h.id, up ? 'online' : 'offline'))
      })
    }
    return () => {
      live = false
    }
    // The ids stand for the list; a computer's other fields changing is no reason to check again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watching, key])
  return reach
}

export interface ComputerLine {
  text: string
  tone: LinkTone
}

/** What a computer's row says about it: the link for the active one, a check for the others. */
export function useComputerLine(reach: Map<string, Reach>): (h: SavedHost) => ComputerLine {
  const host = useComputers()
  return (h) => {
    if (h.id === host.host?.id) {
      const status = linkStatusOf(host.state, host.unreachable)
      const address = host.state.kind === 'connected' ? currentAddress() : null
      const route = address ? ` · ${ROUTE_NAMES[routeKind(address)]}` : ''
      return { text: `正在使用 · ${status.text}${route}`, tone: status.tone }
    }
    const seen = h.lastSeen ? `上次在线 ${ago(h.lastSeen)}` : '还没连上过'
    const state = reach.get(h.id)
    if (state === 'online') return { text: `可以连接 · ${seen}`, tone: 'ok' }
    if (state === 'offline') return { text: `现在连不上 · ${seen}`, tone: 'off' }
    return { text: `正在检查… · ${seen}`, tone: 'busy' }
  }
}

export function lineColor(c: Palette, tone: LinkTone): string {
  return tone === 'ok'
    ? c.success
    : tone === 'busy'
      ? c.warning
      : tone === 'down'
        ? c.danger
        : c.textTertiary
}

/** Switching, renaming and unpairing a computer, with the dialog renaming needs. */
export function useComputerActions() {
  const host = useComputers()
  const [renaming, setRenaming] = useState<SavedHost | null>(null)
  const [busy, setBusy] = useState<Set<string>>(new Set())

  const switchTo = (h: SavedHost) => {
    if (h.id === host.host?.id) return
    haptic.select()
    host.switchTo(h.id)
  }

  /** `after` runs once it is done, as leaving the screen about that computer. */
  const unpair = (h: SavedHost, after?: () => void) => {
    haptic.warning()
    const active = h.id === host.host?.id
    const last = host.computers.length === 1
    Alert.alert(
      `解除与「${computerName(h)}」的配对？`,
      `电脑连得上时会移除这台手机；连不上时，可以之后在电脑的「设置 › 远程访问」里移除它。这台手机上存的会话缓存也会删掉。${
        last ? '这是最后一台电脑，之后要重新扫码配对。' : ''
      }`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '解除配对',
          style: 'destructive',
          onPress: () => {
            setBusy((set) => new Set(set).add(h.id))
            void host.unpair(h.id).finally(() => {
              setBusy((set) => {
                const next = new Set(set)
                next.delete(h.id)
                return next
              })
              if (active && last) {
                if (router.canDismiss()) router.dismissAll()
              } else after?.()
            })
          },
        },
      ],
    )
  }

  /** The row's menu; `then` runs before a choice opens something of its own, as closing a sheet. */
  const menu = (h: SavedHost, then?: () => void): MenuNode[] => {
    const active = h.id === host.host?.id
    return [
      ...(active
        ? []
        : [
            {
              key: 'switch',
              label: '切换到这台电脑',
              icon: 'arrow.left.arrow.right' as const,
              onPress: () => switchTo(h),
            },
          ]),
      {
        key: 'rename',
        label: '重命名',
        icon: 'pencil',
        onPress: () => {
          then?.()
          // A dialog cannot open over a sheet that is still on screen.
          setTimeout(() => setRenaming(h), then ? 320 : 0)
        },
      },
      {
        key: 'details',
        label: '连接详情',
        icon: 'info.circle',
        onPress: () => {
          then?.()
          router.push({ pathname: '/settings/computer', params: { id: h.id } })
        },
      },
      { kind: 'divider', key: 'danger' },
      {
        key: 'unpair',
        label: '解除配对',
        icon: 'minus.circle',
        destructive: true,
        onPress: () => unpair(h),
      },
    ]
  }

  const element = (
    <RenameDialog
      visible={renaming !== null}
      heading="这台电脑在手机上的名称"
      placeholder={renaming?.name ?? '名称'}
      noReset
      maxLength={64}
      title={renaming ? computerName(renaming) : ''}
      onClose={() => setRenaming(null)}
      onSave={async (name) => {
        if (!renaming) return
        // Clearing the name, or giving the computer's own, goes back to what the computer says.
        host.rename(renaming.id, name && name !== renaming.name ? name : null)
      }}
    />
  )

  return { switchTo, unpair, rename: (h: SavedHost) => setRenaming(h), menu, busy, element }
}

/** One computer: its system, its name, how it is, and its menu. */
export function ComputerRow(props: {
  computer: SavedHost
  line: ComputerLine
  active: boolean
  busy: boolean
  onPress(): void
  /** What its long press and its 更多操作 button offer. */
  menu: MenuNode[]
  /**
   * In a sheet, only the button opens the menu on iOS: the sheet is presented in a view
   * controller of its own, where a context menu's hosted row would not get its taps.
   */
  inSheet?: boolean
}) {
  const { c } = useTokens()
  const h = props.computer
  const name = computerName(h)
  return (
    <ContextMenu
      items={props.menu}
      title={name}
      disabled={props.busy || (props.inSheet && SYSTEM_MENUS)}
    >
      {(longPress) => (
        // Opaque, so the row lifts as itself when its context menu opens. The button sits beside
        // the row's press rather than in it, so its menu's tap is not the row's too.
        <View style={[styles.row, { backgroundColor: c.surface }]}>
          <Press
            onPress={props.onPress}
            {...(longPress ? { onLongPress: longPress } : {})}
            scale={false}
            disabled={props.busy}
            accessibilityRole="button"
            accessibilityLabel={`${name}，${props.line.text}`}
            accessibilityState={{ selected: props.active }}
            accessibilityHint={props.active ? undefined : '点按切换到这台电脑，长按查看更多操作'}
            containerStyle={styles.flex}
            style={styles.main}
          >
            <View style={[styles.icon, { backgroundColor: props.active ? c.tintSoft : c.fill }]}>
              <OsIcon platform={platformOf(h)} size={22} color={props.active ? c.tint : c.text} />
            </View>
            <View style={styles.text}>
              <Text style={[typeScale.rowTitle, { color: c.text }]} numberOfLines={1}>
                {name}
              </Text>
              <View style={styles.line}>
                {props.busy ? (
                  <ActivityIndicator size="small" color={c.textSecondary} />
                ) : (
                  <View style={[styles.dot, { backgroundColor: lineColor(c, props.line.tone) }]} />
                )}
                <Text style={[typeScale.footnote, styles.flex, { color: c.textSecondary }]}>
                  {props.busy ? '正在解除配对…' : props.line.text}
                </Text>
              </View>
            </View>
            {props.active ? <Icon name="check" size={18} color={c.tint} weight="semibold" /> : null}
          </Press>
          <TapMenu items={props.menu} title={name} disabled={props.busy}>
            {(open) => (
              <IconButton
                icon="more"
                tone="plain"
                size={36}
                iconSize={18}
                label="更多操作"
                disabled={props.busy}
                onPress={open ?? noop}
              />
            )}
          </TapMenu>
        </View>
      )}
    </ContextMenu>
  )
}

export function ComputerSheet(props: { visible: boolean; onClose(): void }) {
  const { c } = useTokens()
  const host = useComputers()
  const reach = useReach(props.visible)
  const lineOf = useComputerLine(reach)
  const actions = useComputerActions()
  const connected = host.state.kind === 'connected'

  return (
    <>
      <BottomSheet
        visible={props.visible}
        onClose={props.onClose}
        title="电脑"
        message="纸鸢一次显示一台电脑的会话、Artifacts、定时任务和用量。"
      >
        <View style={[styles.group, { backgroundColor: c.surface, borderColor: c.border }]}>
          {host.computers.map((h, i) => (
            <View key={h.id}>
              {i > 0 && <View style={[styles.separator, { backgroundColor: c.border }]} />}
              <ComputerRow
                computer={h}
                line={lineOf(h)}
                active={h.id === host.host?.id}
                busy={actions.busy.has(h.id)}
                onPress={() => {
                  if (h.id === host.host?.id) return
                  actions.switchTo(h)
                  props.onClose()
                }}
                menu={actions.menu(h, props.onClose)}
                inSheet
              />
            </View>
          ))}
        </View>
        <ListGroup>
          {!connected ? (
            <ListRow
              title="立即重连"
              icon="refresh"
              iconTint={c.tint}
              action
              onPress={() => {
                haptic.tap()
                host.retry()
              }}
            />
          ) : null}
          <ListRow
            title="添加电脑"
            icon="plus"
            iconTint={c.accent}
            action
            onPress={() => {
              props.onClose()
              router.push('/pair')
            }}
          />
          <ListRow
            title="管理已配对的电脑"
            icon="desktop"
            chevron
            onPress={() => {
              props.onClose()
              router.push('/settings/computers')
            }}
          />
        </ListGroup>
      </BottomSheet>
      {actions.element}
    </>
  )
}

const styles = StyleSheet.create({
  group: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 64 },
  row: { flexDirection: 'row', alignItems: 'center', paddingRight: space.sm },
  main: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 64,
    paddingLeft: space.lg,
    paddingRight: space.md,
    paddingVertical: space.md,
  },
  icon: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { flex: 1, gap: 3 },
  line: { flexDirection: 'row', alignItems: 'center', gap: space.sm - 2 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  flex: { flex: 1 },
})
