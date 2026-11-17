// The tabs' shared state and their top bar: the project filter every list applies, and the sheets
// the top bar opens (projects, and the paired computers).

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Platform, StyleSheet, View } from 'react-native'
import { router, useNavigation } from 'expo-router'
import type { SessionSummary } from '@shared/agent-host'
import { useHost } from '../host'
import { linkStatusOf, platformOf, type LinkTone } from '../linkInfo'
import type { SearchScope } from '../search'
import { folder } from '../sessions'
import { computerName } from '../store'
import { haptic } from '../ui/haptics'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { OsIcon } from '../ui/OsIcon'
import { Pill } from '../ui/Pill'
import { Press } from '../ui/Press'
import { FloatingHeader, type CollapsingHeader } from '../ui/ScrollHeader'
import { size as sizes, space, useTokens, type Palette } from '../ui/tokens'
import { ComputerSheet } from './ComputerSheet'
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
  openProjects(): void
  openHost(): void
}

const ShellContext = createContext<ShellValue | null>(null)

export function useShell(): ShellValue {
  const value = useContext(ShellContext)
  if (!value) throw new Error('useShell outside ShellProvider')
  return value
}

/** The link's dot: green connected, orange connecting, grey unreachable, red stopped. */
export function toneColor(c: Palette, tone: LinkTone): string {
  return tone === 'ok'
    ? c.success
    : tone === 'busy'
      ? c.warning
      : tone === 'off'
        ? c.textTertiary
        : c.danger
}

export function ShellProvider(props: { children: ReactNode }) {
  const host = useHost()
  const [filter, setFilter] = useState<ProjectFilter>({ kind: 'all' })
  const [sheet, setSheet] = useState<'projects' | 'host' | null>(null)

  // A project belongs to one computer: another computer starts with everything shown.
  const activeId = host.host?.id
  useEffect(() => {
    setFilter({ kind: 'all' })
  }, [activeId])

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
      <ComputerSheet visible={sheet === 'host'} onClose={() => setSheet(null)} />
    </ShellContext.Provider>
  )
}

/**
 * The top bar of every tab: account, project filter, the computer, search. The home tab names the
 * computer in a pill; the others (`compact`) name the project filter and mark the computer only.
 * The computer opens the sheet of paired computers; search opens the search page.
 */
export function TopBar(props: {
  header: CollapsingHeader
  filter?: boolean
  compact?: boolean
  /** The tab's own search, for a list the search page does not cover; replaces the button's. */
  search?: { active: boolean; onPress(): void }
  /** The scope the search page opens in. */
  searchScope?: SearchScope
}) {
  const { c } = useTokens()
  const host = useHost()
  const shell = useShell()
  const status = linkStatusOf(host.state, host.unreachable)
  const name = computerName(host.host)
  const platform = platformOf(
    host.host,
    host.state.kind === 'connected' ? host.state.welcome.host.platform : undefined,
  )
  const several = host.computers.length > 1
  const openSearch = () => {
    haptic.tap()
    router.push({
      pathname: '/search',
      params: props.searchScope ? { scope: props.searchScope } : {},
    })
  }
  const avatar = (
    <Press
      onPress={() => router.push('/settings')}
      accessibilityRole="button"
      accessibilityLabel="账户与设置"
      style={[styles.avatar, { backgroundColor: c.avatar, borderColor: c.borderStrong }]}
    >
      <Icon name="person" size={17} color={c.textSecondary} />
    </Press>
  )
  // The OS mark with the link's dot at its top right, as the reference app draws it.
  const mark = (color?: string) => (
    <View style={styles.markBox}>
      <OsIcon platform={platform} size={16} {...(color ? { color } : {})} />
      <View
        style={[
          styles.statusDot,
          { backgroundColor: toneColor(c, status.tone), borderColor: c.bg },
        ]}
      />
    </View>
  )
  const hostLabel = `${name}，${status.text}${several ? '，点按切换电脑' : ''}`
  const search = props.search ? (
    <IconButton
      icon={props.search.active ? 'close' : 'search'}
      label={props.search.active ? '结束搜索' : '搜索'}
      size={sizes.barButton}
      iconSize={19}
      onPress={props.search.onPress}
    />
  ) : (
    <IconButton
      icon="search"
      label="搜索"
      size={sizes.barButton}
      iconSize={19}
      onPress={openSearch}
    />
  )
  if (props.compact) {
    return (
      <FloatingHeader header={props.header}>
        {avatar}
        <Pill
          tone="glass"
          size="bar"
          onPress={shell.openProjects}
          accessibilityLabel={`按项目查看，当前：${shell.filterName ?? '全部项目'}`}
          leading={
            <Icon
              name="layers"
              size={16}
              color={shell.filterName ? c.tint : c.text}
              weight="medium"
            />
          }
          label={shell.filterName ?? '全部'}
        />
        <Press
          onPress={shell.openHost}
          accessibilityRole="button"
          accessibilityLabel={hostLabel}
          hitSlop={10}
          style={styles.mark}
        >
          {mark(c.textSecondary)}
        </Press>
        <View style={styles.spacer} />
        {search}
      </FloatingHeader>
    )
  }
  return (
    <FloatingHeader header={props.header}>
      {avatar}
      {props.filter !== false && (
        <IconButton
          icon="layers"
          tone="plain"
          size={28}
          iconSize={19}
          label={shell.filterName ? `项目：${shell.filterName}` : '按项目查看'}
          color={shell.filterName ? c.tint : c.textSecondary}
          onPress={shell.openProjects}
        />
      )}
      <Pill
        tone="glass"
        size="bar"
        onPress={shell.openHost}
        accessibilityLabel={hostLabel}
        leading={mark()}
        trailing={
          several ? (
            <Icon name="upDown" size={12} color={c.textSecondary} weight="semibold" />
          ) : undefined
        }
        label={name}
      />
      <View style={styles.spacer} />
      {search}
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
    width: sizes.barAvatar,
    height: sizes.barAvatar,
    borderRadius: sizes.barAvatar / 2,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markBox: { width: 16, height: 16 },
  statusDot: {
    position: 'absolute',
    top: -3,
    right: -4,
    width: 8,
    height: 8,
    borderRadius: 4,
    borderWidth: 1.5,
  },
  spacer: { flex: 1 },
  mark: { padding: space.xs },
  filterNote: { flexDirection: 'row', marginTop: space.md },
})
