// The tabs' shared state and their top bar: the project filter every list applies, the search the
// home tab shows, and the sheets the top bar opens.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Platform, StyleSheet, Text, View } from 'react-native'
import { router, useNavigation } from 'expo-router'
import type { SessionSummary } from '@shared/agent-host'
import { currentAddress, routeKind } from '../connection'
import { useHost } from '../host'
import { hostPort, linkStatus, osName, ROUTE_NAMES, type LinkTone } from '../linkInfo'
import { folder } from '../sessions'
import { BottomSheet } from '../ui/BottomSheet'
import { haptic } from '../ui/haptics'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { ListGroup, ListRow } from '../ui/ListRow'
import { OsIcon } from '../ui/OsIcon'
import { Pill } from '../ui/Pill'
import { Press } from '../ui/Press'
import { FloatingHeader, type CollapsingHeader } from '../ui/ScrollHeader'
import {
  radius,
  size as sizes,
  space,
  type as typeScale,
  useTokens,
  type Palette,
} from '../ui/tokens'
import { Sheet, type SheetItem } from './Sheet'

export type ProjectFilter =
  { kind: 'all' } | { kind: 'scratch' } | { kind: 'project'; path: string }

/** Whether something in a project, or under No project, passes the filter. */
export function inFilter(filter: ProjectFilter, item: { scratch: boolean; path: string }): boolean {
  if (filter.kind === 'all') return true
  if (filter.kind === 'scratch') return item.scratch
  return !item.scratch && item.path === filter.path
}

interface ShellValue {
  filter: ProjectFilter
  setFilter(filter: ProjectFilter): void
  /** The filter's name, or null while it shows everything. */
  filterName: string | null
  searching: boolean
  setSearching(on: boolean): void
  openProjects(): void
  openHost(): void
}

const ShellContext = createContext<ShellValue | null>(null)

export function useShell(): ShellValue {
  const value = useContext(ShellContext)
  if (!value) throw new Error('useShell outside ShellProvider')
  return value
}

export function toneColor(c: Palette, tone: LinkTone): string {
  return tone === 'ok' ? c.success : tone === 'busy' ? c.warning : c.danger
}

export function ShellProvider(props: { children: ReactNode }) {
  const host = useHost()
  const [filter, setFilter] = useState<ProjectFilter>({ kind: 'all' })
  const [searching, setSearching] = useState(false)
  const [sheet, setSheet] = useState<'projects' | 'host' | null>(null)

  // The projects the listed sessions are in, latest first, named as the computer names them.
  const projects = useMemo(() => {
    const names = new Map(host.projects.map((p) => [p.path, p.name]))
    const latest = new Map<string, { updated: number; count: number }>()
    let scratch = 0
    for (const s of host.sessions.values()) {
      if (s.parentId !== null || s.archivedAt !== null) continue
      if (s.scratch) {
        scratch++
        continue
      }
      const seen = latest.get(s.projectPath)
      latest.set(s.projectPath, {
        updated: Math.max(seen?.updated ?? 0, s.updatedAt),
        count: (seen?.count ?? 0) + 1,
      })
    }
    const list = [...latest.entries()]
      .sort((a, b) => b[1].updated - a[1].updated)
      .map(([path, { count }]) => ({ path, count, name: names.get(path) ?? folder(path) }))
    return { list, scratch }
  }, [host.sessions, host.projects])

  const filterName =
    filter.kind === 'all'
      ? null
      : filter.kind === 'scratch'
        ? '无项目'
        : (projects.list.find((p) => p.path === filter.path)?.name ?? folder(filter.path))

  const choose = (next: ProjectFilter) => {
    haptic.select()
    setFilter(next)
  }
  const items: SheetItem[] = [
    {
      key: '__all',
      label: '全部项目',
      checked: filter.kind === 'all',
      onPress: () => choose({ kind: 'all' }),
    },
    ...projects.list.map((p) => ({
      key: p.path,
      label: p.name,
      detail: `${p.count} 个会话`,
      checked: filter.kind === 'project' && filter.path === p.path,
      onPress: () => choose({ kind: 'project', path: p.path }),
    })),
    ...(projects.scratch > 0
      ? [
          {
            key: '__scratch',
            label: '无项目',
            detail: `${projects.scratch} 个会话`,
            checked: filter.kind === 'scratch',
            onPress: () => choose({ kind: 'scratch' }),
          },
        ]
      : []),
  ]

  const value: ShellValue = {
    filter,
    setFilter: choose,
    filterName,
    searching,
    setSearching,
    openProjects: () => setSheet('projects'),
    openHost: () => setSheet('host'),
  }

  return (
    <ShellContext.Provider value={value}>
      {props.children}
      <Sheet
        visible={sheet === 'projects'}
        title="按项目查看"
        message="会话、Artifacts 和定时任务都只显示这个项目的。"
        items={items}
        onClose={() => setSheet(null)}
      />
      <HostSheet visible={sheet === 'host'} onClose={() => setSheet(null)} />
    </ShellContext.Provider>
  )
}

function HostSheet(props: { visible: boolean; onClose(): void }) {
  const { c } = useTokens()
  const host = useHost()
  const status = linkStatus(host.state)
  const welcome = host.state.kind === 'connected' ? host.state.welcome : null
  const address = props.visible && welcome ? currentAddress() : null
  const platform = welcome?.host.platform ?? host.host?.platform
  return (
    <BottomSheet visible={props.visible} onClose={props.onClose}>
      <View style={styles.hostHead}>
        <View style={[styles.hostIcon, { backgroundColor: c.fill }]}>
          <OsIcon platform={platform} size={28} />
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
        <ListRow
          title="线路"
          value={address ? `${ROUTE_NAMES[routeKind(address)]} · ${hostPort(address)}` : '—'}
        />
        {welcome ? <ListRow title="电脑上的 Huli" value={welcome.host.version} /> : null}
        <ListRow title="这台手机叫" value={host.host?.deviceName ?? '—'} />
      </ListGroup>
      <ListGroup>
        {host.state.kind !== 'connected' ? (
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
        <ListRow
          title="连接设置"
          icon="link"
          chevron
          onPress={() => {
            props.onClose()
            router.push('/settings')
          }}
        />
      </ListGroup>
    </BottomSheet>
  )
}

/** The top bar of every tab: account, project filter, the computer, search. */
export function TopBar(props: { header: CollapsingHeader; filter?: boolean }) {
  const { c } = useTokens()
  const host = useHost()
  const shell = useShell()
  const status = linkStatus(host.state)
  const platform =
    (host.state.kind === 'connected' ? host.state.welcome.host.platform : undefined) ??
    host.host?.platform
  return (
    <FloatingHeader header={props.header}>
      <Press
        onPress={() => router.push('/settings')}
        accessibilityRole="button"
        accessibilityLabel="账户与设置"
        style={[styles.avatar, { backgroundColor: c.avatar, borderColor: c.borderStrong }]}
      >
        <Icon name="person" size={22} color={c.textSecondary} />
      </Press>
      {props.filter !== false && (
        <IconButton
          icon="layers"
          tone="plain"
          size={40}
          iconSize={22}
          label={shell.filterName ? `项目：${shell.filterName}` : '按项目查看'}
          color={shell.filterName ? c.tint : c.textSecondary}
          onPress={shell.openProjects}
        />
      )}
      <Pill
        tone="glass"
        size="lg"
        onPress={shell.openHost}
        accessibilityLabel={`${host.host?.name ?? '电脑'}，${status.text}`}
        leading={
          <View>
            <OsIcon platform={platform} size={18} />
            <View
              style={[
                styles.statusDot,
                { backgroundColor: toneColor(c, status.tone), borderColor: c.bg },
              ]}
            />
          </View>
        }
        label={host.host?.name ?? '电脑'}
      />
      <View style={styles.spacer} />
      <IconButton
        icon="search"
        label="搜索会话"
        onPress={() => {
          shell.setSearching(true)
          router.navigate('/')
        }}
      />
    </FloatingHeader>
  )
}

/** A sentence about what the filter hides, with a way out, under a tab's title. */
export function FilterNote(props: { what: string }) {
  const { c } = useTokens()
  const shell = useShell()
  if (!shell.filterName) return null
  return (
    <View style={styles.filterNote}>
      <Pill
        tone="tint"
        onPress={() => shell.setFilter({ kind: 'all' })}
        accessibilityLabel={`只看 ${shell.filterName} 的${props.what}，点按显示全部`}
        leading={<Icon name="folder" size={14} color={c.tint} />}
        trailing={<Icon name="close" size={12} color={c.tint} weight="semibold" />}
        label={shell.filterName}
      />
    </View>
  )
}

/** Scrolls a tab's list back to its top when its tab is tapped again, as iOS apps do. */
export function useScrollTopOnTabPress(
  scrollTo: (offset: number) => void,
  header: CollapsingHeader,
) {
  const navigation = useNavigation()
  const latest = useRef(scrollTo)
  latest.current = scrollTo
  useEffect(() => {
    const listen = navigation.addListener.bind(navigation) as unknown as (
      event: 'tabPress',
      callback: () => void,
    ) => () => void
    return listen('tabPress', () => {
      if (navigation.isFocused()) latest.current(Platform.OS === 'ios' ? -header.height : 0)
    })
  }, [navigation, header.height])
}

export function sessionFilterItem(s: SessionSummary) {
  return { scratch: s.scratch, path: s.projectPath }
}

const styles = StyleSheet.create({
  avatar: {
    width: sizes.iconButton,
    height: sizes.iconButton,
    borderRadius: sizes.iconButton / 2,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusDot: {
    position: 'absolute',
    top: -4,
    right: -4,
    width: 9,
    height: 9,
    borderRadius: 5,
    borderWidth: 1.5,
  },
  spacer: { flex: 1 },
  hostHead: { alignItems: 'center', gap: space.sm, paddingBottom: space.sm },
  hostIcon: {
    width: 64,
    height: 64,
    borderRadius: radius.xl,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm - 2 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  filterNote: { flexDirection: 'row', marginTop: space.md },
})
