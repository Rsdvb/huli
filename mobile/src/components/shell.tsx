// The tabs' shared state and their top bar: the project filter every list applies, the system
// menu the layers button opens (projects), and the sheet of the paired computers.

import {
  createContext,
  useCallback,
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
import {
  sameFields,
  useActiveHost,
  useComputerId,
  useHostSelector,
  useProjects,
  useSessions,
  type HostData,
} from '../host'
import { linkStatusOf, platformOf, type LinkTone } from '../linkInfo'
import type { SearchScope } from '../search'
import { folder } from '../sessions'
import { computerName } from '../store'
import { GlassButton } from '../ui/Glass'
import { haptic } from '../ui/haptics'
import { Icon } from '../ui/Icon'
import { IconButton } from '../ui/IconButton'
import { OsIcon } from '../ui/OsIcon'
import { Pill } from '../ui/Pill'
import { Press } from '../ui/Press'
import { FloatingHeader, type CollapsingHeader } from '../ui/ScrollHeader'
import { size as sizes, space, useTokens, type Palette } from '../ui/tokens'
import { TapMenu } from '../ui/ContextMenu'
import type { MenuNode } from '../ui/menu'
import { ComputerSheet } from './ComputerSheet'

const noop = () => {}

/** What the computer's mark beside the compact bar's project pill takes: itself, its pad, a gap. */
const MARK_ROOM = 16 + space.xs * 2 + space.sm + 2

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
  openHost(): void
}

/** The layers button's menu, apart from the filter so the lists do not redraw with its counts. */
const ProjectMenuContext = createContext<MenuNode[]>([])

/** The project filter's choices as menu items: 全部项目, each project with its count, 无项目. */
export function projectMenuNodes(
  filter: ProjectFilter,
  projects: readonly { path: string; name: string; count: number }[],
  scratch: number,
  choose: (filter: ProjectFilter) => void,
): MenuNode[] {
  return [
    {
      key: '__all',
      label: '全部项目',
      icon: 'square.3.layers.3d',
      checked: filter.kind === 'all',
      onPress: () => choose({ kind: 'all' }),
    },
    { kind: 'divider', key: '__projects', title: '项目' },
    ...projects.map((p) => ({
      key: p.path,
      label: p.name,
      subtitle: `${p.count} 个会话`,
      icon: 'folder' as const,
      checked: filter.kind === 'project' && filter.path === p.path,
      onPress: () => choose({ kind: 'project', path: p.path }),
    })),
    ...(scratch > 0
      ? [
          {
            key: '__scratch',
            label: '无项目',
            subtitle: `${scratch} 个会话`,
            icon: 'tray' as const,
            checked: filter.kind === 'scratch',
            onPress: () => choose({ kind: 'scratch' }),
          },
        ]
      : []),
  ]
}

interface ProjectCounts {
  list: { path: string; count: number; name: string }[]
  scratch: number
}

function sameProjectCounts(a: ProjectCounts, b: ProjectCounts): boolean {
  return (
    a.scratch === b.scratch &&
    a.list.length === b.list.length &&
    a.list.every(
      (p, i) =>
        p.path === b.list[i]!.path && p.count === b.list[i]!.count && p.name === b.list[i]!.name,
    )
  )
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
  const sessions = useSessions()
  const hostProjects = useProjects()
  const [filter, setFilter] = useState<ProjectFilter>({ kind: 'all' })
  const [sheet, setSheet] = useState<'host' | null>(null)
  const opened = useRef(false)
  if (sheet === 'host') opened.current = true

  // A project belongs to one computer: another computer starts with everything shown.
  const activeId = useComputerId()
  useEffect(() => {
    setFilter({ kind: 'all' })
  }, [activeId])

  // The projects the listed sessions are in, latest first, named as the computer names them. The
  // same list keeps its identity, so the menu and the top bars that read it do not redraw on every
  // session's turn, which changes the sessions but seldom their projects.
  const lastProjects = useRef<ProjectCounts | null>(null)
  const projects = useMemo(() => {
    const names = new Map(hostProjects.map((p) => [p.path, p.name]))
    const latest = new Map<string, { updated: number; count: number }>()
    let scratch = 0
    for (const s of sessions.values()) {
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
    const next = { list, scratch }
    const last = lastProjects.current
    if (last && sameProjectCounts(last, next)) return last
    lastProjects.current = next
    return next
  }, [sessions, hostProjects])

  const filterName =
    filter.kind === 'all'
      ? null
      : filter.kind === 'scratch'
        ? '无项目'
        : (projects.list.find((p) => p.path === filter.path)?.name ?? folder(filter.path))

  const choose = useCallback((next: ProjectFilter) => {
    haptic.select()
    setFilter(next)
  }, [])
  const projectMenu = useMemo(
    () => projectMenuNodes(filter, projects.list, projects.scratch, choose),
    [filter, projects, choose],
  )

  // The lists read this on every render, so it changes only with the filter.
  const value = useMemo<ShellValue>(
    () => ({
      filter,
      setFilter: choose,
      filterName,
      openHost: () => setSheet('host'),
    }),
    [filter, choose, filterName],
  )

  return (
    <ShellContext.Provider value={value}>
      <ProjectMenuContext.Provider value={projectMenu}>
        {props.children}
        {/* Mounted once first opened: until then the computers' sheet costs the app nothing. */}
        {opened.current ? (
          <ComputerSheet visible={sheet === 'host'} onClose={() => setSheet(null)} />
        ) : null}
      </ProjectMenuContext.Provider>
    </ShellContext.Provider>
  )
}

const pickLink = (d: HostData) => ({
  state: d.state,
  unreachable: d.unreachable,
  several: d.computers.hosts.length > 1,
})

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
  /** The layers button's menu, when the tab has its own (home); the project filter's otherwise. */
  layers?: MenuNode[]
  /** The computer pill's menu (home): 全部电脑 and each computer, instead of the sheet. */
  computers?: { items: MenuNode[]; all: boolean }
}) {
  const { c } = useTokens()
  const link = useHostSelector(pickLink, sameFields)
  const active = useActiveHost()
  const shell = useShell()
  const projectMenu = useContext(ProjectMenuContext)
  const status = linkStatusOf(link.state, link.unreachable)
  const name = computerName(active)
  const platform = platformOf(
    active,
    link.state.kind === 'connected' ? link.state.welcome.host.platform : undefined,
  )
  const several = link.several
  // The room between the buttons, which a long computer or project name must not run past: the
  // system menu around a pill sizes it to its content, so the pill takes this as its width's limit.
  const [room, setRoom] = useState<number | null>(null)
  const middle = (children: ReactNode) => (
    <View style={styles.middle} onLayout={(e) => setRoom(e.nativeEvent.layout.width)}>
      {children}
    </View>
  )
  const fit = (reserve: number) => (room === null ? undefined : { maxWidth: room - reserve })
  const openSearch = () => {
    haptic.tap()
    router.push({
      pathname: '/search',
      params: props.searchScope ? { scope: props.searchScope } : {},
    })
  }
  // A grey disc of glass, as the reference app's account button.
  const avatar = (
    <GlassButton
      silent
      elevated={false}
      size={sizes.barAvatar}
      tint={c.textTertiary}
      systemImage="person.fill"
      symbolColor={c.onAccent}
      onPress={() => router.push('/settings')}
      accessibilityLabel="账户与设置"
    >
      <Icon name="person" size={17} color={c.onAccent} />
    </GlassButton>
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
  const layers = props.layers ?? projectMenu
  if (props.compact) {
    return (
      <FloatingHeader header={props.header}>
        {avatar}
        {middle(
          <>
            <TapMenu items={layers} title="按项目查看">
              {(open) => (
                <Pill
                  tone="glass"
                  size="bar"
                  style={fit(MARK_ROOM)}
                  {...(open ? { onPress: open } : {})}
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
              )}
            </TapMenu>
            <Press
              onPress={shell.openHost}
              accessibilityRole="button"
              accessibilityLabel={hostLabel}
              hitSlop={10}
              style={styles.mark}
            >
              {mark(c.textSecondary)}
            </Press>
          </>,
        )}
        {search}
      </FloatingHeader>
    )
  }
  return (
    <FloatingHeader header={props.header}>
      {avatar}
      {props.filter !== false && (
        <TapMenu items={layers}>
          {(open) => (
            <IconButton
              icon="layers"
              tone="plain"
              size={28}
              iconSize={19}
              label={shell.filterName ? `项目：${shell.filterName}` : '按项目查看'}
              color={shell.filterName ? c.tint : c.textSecondary}
              onPress={open ?? noop}
            />
          )}
        </TapMenu>
      )}
      {middle(
        props.computers ? (
          <TapMenu items={props.computers.items}>
            {(open) => (
              <Pill
                tone="glass"
                size="bar"
                style={fit(0)}
                {...(open ? { onPress: open } : {})}
                accessibilityLabel={
                  props.computers?.all ? '全部电脑，点按切换' : `${hostLabel}，点按切换电脑`
                }
                leading={
                  props.computers?.all ? <Icon name="layers" size={16} color={c.text} /> : mark()
                }
                trailing={
                  <Icon name="upDown" size={12} color={c.textSecondary} weight="semibold" />
                }
                label={props.computers?.all ? '全部电脑' : name}
              />
            )}
          </TapMenu>
        ) : (
          <Pill
            tone="glass"
            size="bar"
            style={fit(0)}
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
        ),
      )}
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
  middle: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: space.sm + 2 },
  mark: { padding: space.xs },
  filterNote: { flexDirection: 'row', marginTop: space.md },
})
