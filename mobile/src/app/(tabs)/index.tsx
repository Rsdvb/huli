// Home: a greeting and what needs the user, then the sessions in order: 需要你处理, 正在运行, 置顶,
// then the user's folders and the projects, each a group that folds and shows its latest few
// (按项目分组), or one list by time (按时间). The layers button's menu filters by project and
// chooses how the list shows; the computer pill's chooses one computer or 全部电脑, which lists
// every paired computer's sessions together, each row marked with its computer (fleet.ts). A long
// press opens a session's system menu; 选择 selects sessions to move into a folder (also by
// dragging them onto its header), archive or delete together. Search is a page of its own
// (search.tsx). On a wide window (iPad) the list keeps a column on the left and the chosen session
// opens beside it, in the session screen itself.

import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Platform, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router } from 'expo-router'
import type { SessionSummary } from '@shared/agent-host'
import type { HostLink } from '@shared/remote/link'
import { folderOfSession, type SessionFolder } from '@shared/session-folders'
import { forkSession, useSessionActions, type MenuExtras } from '../../components/SessionActions'
import { SessionPaneProvider } from '../../components/SessionPane'
import {
  SessionRow,
  SessionRowSkeleton,
  subagentCounts,
  type SubagentCount,
} from '../../components/SessionRow'
import { TaskRow } from '../../components/tasks/TaskRow'
import {
  FilterNote,
  inFilter,
  projectMenuNodes,
  sessionFilterItem,
  TopBar,
  useScrollTopOnTabPress,
  useShell,
} from '../../components/shell'
import { HostVersionBanner } from '../../components/HostVersionBanner'
import { SyncNote } from '../../components/SyncNote'
import { UpdateBanner } from '../../components/UpdateBanner'
import { fleetLink, useFleet, useFleetLinks, wakeFleet } from '../../fleet'
import { moveToFolderNodes, useFolderActions } from '../../folders'
import {
  homeItems,
  placedKey,
  projectKey,
  type Group,
  type HomeItem,
  type Placed,
} from '../../homeList'
import {
  sameFields,
  useActiveHost,
  useAgents,
  useFolders,
  useHost,
  useHostActions,
  useHostSelector,
  useMaybeLink,
  useProjects,
  useSessions,
  type HostData,
} from '../../host'
import { linkProblem, linkStatusOf, platformOf } from '../../linkInfo'
import { openLink } from '../../links'
import { setPrefs, usePrefs } from '../../prefs'
import {
  errorText,
  folder as folderName,
  greeting,
  needsYou,
  sessionTitle,
  withChildWaits,
} from '../../sessions'
import { isRunning as turnRunning } from '../../sessionMenu'
import { computerName, type SavedHost } from '../../store'
import { needsAttention, useTaskList } from '../../tasks'
import { ContextMenu, TapMenu } from '../../ui/ContextMenu'
import { DragProvider, DragSource, DropTarget } from '../../ui/DragToFolder'
import { EmptyState } from '../../ui/EmptyState'
import { Icon } from '../../ui/Icon'
import { IconButton } from '../../ui/IconButton'
import { LIST_COLUMN, useWide } from '../../ui/layout'
import { joinGroups, type MenuNode } from '../../ui/menu'
import { showNotice } from '../../ui/NoticeBar'
import { OsIcon } from '../../ui/OsIcon'
import { Press } from '../../ui/Press'
import { AnimatedFlashList, type FlashListRef } from '../../ui/AnimatedList'
import { Screen } from '../../ui/Screen'
import { countRender } from '../../ui/renders'
import { FloatingHeader, useCollapsingHeader } from '../../ui/ScrollHeader'
import { SectionHeader } from '../../ui/SectionHeader'
import { haptic } from '../../ui/haptics'
import { Pill } from '../../ui/Pill'
import { AgentAvatar } from '../../ui/AgentAvatar'
import {
  radius,
  size as sizes,
  space,
  TAB_BAR_CLEARANCE,
  type as typeScale,
  useTokens,
} from '../../ui/tokens'

// The session screen beside the list is for a wide window only; a phone never loads it here, so
// the conversation, the composer and their menus stay off the start's path.
const SessionScreen = lazy(() => import('../session/[id]'))

function isRunning(s: SessionSummary): boolean {
  return s.status === 'running' || s.status === 'starting'
}

/** The agents of some sessions as small overlapping avatars, inside a line of the greeting. */
function Inline(props: { agents: SessionSummary[] }) {
  const { c } = useTokens()
  const ids = [...new Set(props.agents.map((s) => s.agentId))].slice(0, 3)
  return (
    <View style={styles.inline}>
      {ids.map((id, i) => (
        <View
          key={id}
          style={[styles.inlineAvatar, { marginLeft: i === 0 ? 0 : -8, borderColor: c.bg }]}
        >
          <AgentAvatar agentId={id} size={24} />
        </View>
      ))}
    </View>
  )
}

export default function Home() {
  const wide = useWide()
  const { c } = useTokens()
  const [selected, setSelected] = useState<string | null>(null)

  // A session that went away on the computer leaves the pane.
  const gone = useHostSelector(
    useCallback(
      (d: HostData) => selected !== null && d.loaded && !d.sessions.has(selected),
      [selected],
    ),
  )
  useEffect(() => {
    if (gone) setSelected(null)
  }, [gone])
  const close = useCallback(() => setSelected(null), [])

  if (!wide) {
    return <SessionList selected={null} onOpen={openScreen} />
  }
  return (
    <View style={[styles.split, { backgroundColor: c.bg }]}>
      <View style={styles.column}>
        <SessionList selected={selected} onOpen={setSelected} />
      </View>
      <View style={[styles.divider, { backgroundColor: c.border }]} />
      <View style={styles.pane}>
        {selected ? (
          <SessionPaneProvider id={selected} open={setSelected} close={close}>
            <Suspense fallback={<View style={[styles.pane, { backgroundColor: c.bg }]} />}>
              <SessionScreen key={selected} />
            </Suspense>
          </SessionPaneProvider>
        ) : (
          <Screen edges={['top']}>
            <View style={styles.placeholder}>
              <EmptyState
                icon="message"
                title="选一个会话"
                message="左边列表里的会话会在这里打开，列表一直留在旁边。"
              />
            </View>
          </Screen>
        )}
      </View>
    </View>
  )
}

const openScreen = (id: string) => router.push(`/session/${id}`)

/** What a row can do, the same functions for the list's whole life so rows can skip renders. */
interface RowActions {
  open(p: Placed): void
  /** The session's context menu. */
  menu(p: Placed): MenuNode[]
  /** Android's long press: the same menu as a sheet. */
  more(p: Placed): void
  togglePin(p: Placed): void
  archive(p: Placed): void
  toggleCheck(p: Placed): void
  /** What a drag that starts on this row carries. */
  drag(p: Placed): { label: string; ids: string[] }
}

interface Mark {
  platform: string | undefined
  name: string
  offline: boolean
}

interface HomeRowProps {
  placed: Placed
  taskTitle: string | undefined
  subagents: SubagentCount | undefined
  agentName: string | undefined
  projectName: string | undefined
  selected: boolean
  appear: boolean
  connected: boolean
  mark: Mark | undefined
  /** Undefined unless the list selects. */
  check: boolean | undefined
  /** The folders of its computer, so the row's menu follows them. */
  folders: readonly SessionFolder[]
  actions: RowActions
}

function sameHomeRow(a: HomeRowProps, b: HomeRowProps): boolean {
  return (
    // A parent whose child waits is a copy with the count added; its fields are what matter.
    sameFields(a.placed.session, b.placed.session) &&
    a.placed.computer === b.placed.computer &&
    a.taskTitle === b.taskTitle &&
    a.subagents?.count === b.subagents?.count &&
    a.subagents?.running === b.subagents?.running &&
    a.agentName === b.agentName &&
    a.projectName === b.projectName &&
    a.selected === b.selected &&
    a.appear === b.appear &&
    a.connected === b.connected &&
    a.mark?.name === b.mark?.name &&
    a.mark?.offline === b.mark?.offline &&
    a.mark?.platform === b.mark?.platform &&
    a.check === b.check &&
    a.folders === b.folders &&
    a.actions === b.actions
  )
}

/** A session's row in the list: redraws only when what it shows changed. */
const HomeRow = memo(function HomeRow(props: HomeRowProps) {
  countRender('HomeRow')
  const { c } = useTokens()
  const { placed, actions } = props
  const s = placed.session
  const selecting = props.check !== undefined
  const row = (longPress: (() => void) | undefined) => (
    <SessionRow
      session={s}
      task={s.task ? { id: s.task.taskId, title: props.taskTitle ?? '需求' } : undefined}
      subagents={props.subagents}
      agentName={props.agentName}
      projectName={props.projectName}
      selected={props.selected}
      appear={props.appear}
      {...(props.mark ? { mark: props.mark } : {})}
      {...(selecting ? { check: props.check } : {})}
      onPress={() => (selecting ? actions.toggleCheck(placed) : actions.open(placed))}
      {...(longPress ? { onLongPress: longPress } : {})}
      start={
        props.connected && !selecting
          ? {
              label: s.pinnedAt !== null ? '取消置顶' : '置顶',
              icon: s.pinnedAt !== null ? 'unpin' : 'pin',
              color: c.accent,
              onPress: () => actions.togglePin(placed),
            }
          : undefined
      }
      end={
        props.connected && !selecting
          ? {
              label: '归档',
              icon: 'archive',
              color: c.tint,
              onPress: () => actions.archive(placed),
            }
          : undefined
      }
    />
  )
  if (selecting) {
    return (
      <DragSource enabled what={() => actions.drag(placed)}>
        <View>{row(undefined)}</View>
      </DragSource>
    )
  }
  return (
    <ContextMenu items={props.connected ? actions.menu(placed) : []} title={sessionTitle(s)}>
      {(longPress) => row(longPress)}
    </ContextMenu>
  )
}, sameHomeRow)

/** A folder's or a project's header: it folds, takes dropped sessions, and has its own menu. */
function GroupHeader(props: {
  group: Group
  mark: Mark | undefined
  menu: MenuNode[]
  onToggle(): void
  onDrop: ((ids: string[]) => void) | null
}) {
  const { c } = useTokens()
  const { group } = props
  const icon =
    group.kind === 'folder' ? 'folderFill' : group.kind === 'scratch' ? 'inbox' : 'folder'
  const header = (over: boolean, longPress: (() => void) | undefined) => (
    <Press
      onPress={props.onToggle}
      {...(longPress ? { onLongPress: longPress, delayLongPress: 350 } : {})}
      scale={false}
      accessibilityRole="button"
      accessibilityLabel={`${group.title}，${group.count} 个会话${props.mark ? `，${props.mark.name}` : ''}`}
      accessibilityState={{ expanded: !group.collapsed }}
      accessibilityHint={group.collapsed ? '点按展开' : '点按收起'}
      style={[
        styles.group,
        { backgroundColor: over ? c.tintSoft : c.bg, borderColor: over ? c.tint : 'transparent' },
      ]}
    >
      <Icon name={icon} size={17} color={group.kind === 'folder' ? c.tint : c.textSecondary} />
      <Text style={[typeScale.headline, styles.groupTitle, { color: c.text }]} numberOfLines={1}>
        {group.title}
      </Text>
      {group.folder?.pinned ? <Icon name="pin" size={12} color={c.accent} /> : null}
      {props.mark ? (
        <View style={styles.groupMark}>
          <OsIcon platform={props.mark.platform} size={11} color={c.textTertiary} />
          <Text style={[typeScale.footnote, { color: c.textTertiary }]} numberOfLines={1}>
            {props.mark.name}
          </Text>
        </View>
      ) : null}
      <View style={styles.spacer} />
      <Text style={[typeScale.subhead, styles.count, { color: c.textTertiary }]}>
        {group.count}
      </Text>
      <Icon
        name={group.collapsed ? 'chevronRight' : 'chevronDown'}
        size={12}
        color={c.textTertiary}
        weight="semibold"
      />
    </Press>
  )
  const withMenu = (over: boolean) => (
    <ContextMenu items={props.menu} title={group.title}>
      {(longPress) => header(over, longPress)}
    </ContextMenu>
  )
  if (!props.onDrop) return withMenu(false)
  return (
    <DropTarget id={group.key} onDrop={props.onDrop}>
      {(over) => withMenu(over)}
    </DropTarget>
  )
}

const pickLink = (d: HostData) => ({
  state: d.state,
  loaded: d.loaded,
  unreachable: d.unreachable,
  computers: d.computers.hosts,
})

const itemType = (item: HomeItem) => item.kind
const itemKey = (item: HomeItem) => item.key

/** A composite key's computer and session ids. */
function splitKey(key: string): { computer: string; id: string } {
  const at = key.indexOf('\0')
  return { computer: key.slice(0, at), id: key.slice(at + 1) }
}

function SessionList(props: { selected: string | null; onOpen(id: string): void }) {
  countRender('SessionList')
  const { c } = useTokens()
  const sessions = useSessions()
  const projects = useProjects()
  const ownFolders = useFolders()
  const agents = useAgents()
  const host = useHostSelector(pickLink, sameFields)
  const active = useActiveHost()
  const activeLink = useMaybeLink()
  const { retry, refresh, switchTo } = useHostActions()
  const prefs = usePrefs()
  const shell = useShell()
  const header = useCollapsingHeader()
  const insets = useSafeAreaInsets()
  const list = useRef<FlashListRef<HomeItem>>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [selection, setSelection] = useState<ReadonlySet<string> | null>(null)
  const activeId = active?.id ?? ''
  const several = host.computers.length > 1
  const allComputers = several && prefs.homeScope === 'all'
  useFleetLinks(host.computers, active?.id ?? null, allComputers)
  const fleet = useFleet()
  const connected = host.state.kind === 'connected'

  /** The link of a computer other than the active one; undefined for the active one's sessions. */
  const linkFor = useCallback(
    (computer: string): HostLink | null | undefined =>
      computer === activeId ? undefined : fleetLink(computer),
    [activeId],
  )
  const placedOf = useRef(new Map<string, string>())
  const actions = useSessionActions('list', undefined, (s) => {
    const computer = placedOf.current.get(s.id)
    return computer ? linkFor(computer) : undefined
  })
  const folderActions = useFolderActions()
  useScrollTopOnTabPress(
    (offset) => list.current?.scrollToOffset({ offset, animated: true }),
    header,
  )

  // Every computer shown: the active one's lists, and in 全部电脑 the others' light ones.
  const byComputer = useMemo(() => {
    const out = new Map<
      string,
      { sessions: ReadonlyMap<string, SessionSummary>; folders: readonly SessionFolder[] }
    >()
    out.set(activeId, { sessions, folders: ownFolders })
    if (allComputers) {
      for (const [id, f] of fleet) out.set(id, { sessions: f.sessions, folders: f.folders })
    }
    return out
  }, [activeId, sessions, ownFolders, allComputers, fleet])

  const marks = useMemo(() => {
    const out = new Map<string, Mark>()
    if (!allComputers) return out
    for (const h of host.computers) {
      const offline =
        h.id === activeId ? !connected && host.unreachable : fleet.get(h.id)?.state === 'offline'
      out.set(h.id, { platform: platformOf(h), name: computerName(h), offline })
    }
    return out
  }, [allComputers, host.computers, host.unreachable, activeId, connected, fleet])

  // A sub-session's or sub-agent's wait counts on the session the list shows, as on the desktop.
  const placedAll = useMemo(() => {
    const out: Placed[] = []
    for (const [computer, { sessions: map }] of byComputer) {
      for (const s of withChildWaits(map).values()) {
        if (s.parentId === null) out.push({ session: s, computer })
      }
    }
    return out
  }, [byComputer])
  placedOf.current = new Map(placedAll.map((p) => [p.session.id, p.computer]))

  const archivedCount = placedAll.filter((p) => p.session.archivedAt !== null).length
  const listed = useMemo(
    () =>
      placedAll.filter(
        (p) =>
          (prefs.homeShowArchived || p.session.archivedAt === null) &&
          inFilter(shell.filter, sessionFilterItem(p.session)),
      ),
    [placedAll, prefs.homeShowArchived, shell.filter],
  )
  const live = useMemo(() => listed.filter((p) => p.session.archivedAt === null), [listed])

  const projectNames = useMemo(() => {
    const out = new Map<string, string>()
    for (const p of projects) out.set(projectKey(activeId, p.path), p.name)
    if (allComputers) {
      for (const [id, f] of fleet)
        for (const p of f.projects) out.set(projectKey(id, p.path), p.name)
    }
    return out
  }, [projects, activeId, allComputers, fleet])

  // Tasks that wait for the user count with the sessions that do, as the desktop's Needs you
  // group lists both; a step's session that asks is counted on its task.
  const { tasks, views: taskViews } = useTaskList()
  const taskTitles = useMemo(() => new Map(tasks.map((t) => [t.id, t.title])), [tasks])
  const needingTasks = useMemo(() => tasks.filter(needsAttention), [tasks])
  const needingTaskIds = useMemo(() => new Set(needingTasks.map((t) => t.id)), [needingTasks])

  const waiting =
    live.filter(
      (p) => needsYou(p.session) && !(p.session.task && needingTaskIds.has(p.session.task.taskId)),
    ).length + needingTasks.length
  const runningNow = live.filter((p) => !needsYou(p.session) && isRunning(p.session))
  const subagents = useMemo(
    () => subagentCounts([...byComputer.values()].flatMap((v) => [...v.sessions.values()])),
    [byComputer],
  )
  const problem = linkProblem(host.state)
  const collapsed = useMemo(() => new Set(prefs.homeCollapsed), [prefs.homeCollapsed])
  const foldersOf = useMemo(
    () => new Map([...byComputer].map(([id, v]) => [id, v.folders])),
    [byComputer],
  )

  const items = useMemo<HomeItem[]>(
    () =>
      homeItems({
        sessions: listed,
        folders: foldersOf,
        projectNames,
        tasks: needingTasks.filter((t) =>
          inFilter(shell.filter, { scratch: false, path: t.projectPath }),
        ),
        taskIds: needingTaskIds,
        grouping: prefs.homeGrouping,
        collapsed,
        expanded,
        showEmptyFolders: shell.filter.kind === 'all',
      }),
    [
      listed,
      foldersOf,
      projectNames,
      needingTasks,
      needingTaskIds,
      prefs.homeGrouping,
      collapsed,
      expanded,
      shell.filter,
    ],
  )

  const selecting = selection !== null
  const select = useCallback((keys: Iterable<string> | null) => {
    setSelection(keys === null ? null : new Set(keys))
  }, [])

  /** The folder each shown session is in, by composite key. */
  const sessionFolder = useMemo(() => {
    const out = new Map<string, string>()
    for (const [computer, folders] of foldersOf) {
      for (const [id, f] of folderOfSession(folders)) out.set(`${computer}\0${id}`, f)
    }
    return out
  }, [foldersOf])

  /** Moves sessions (composite keys) of one computer into a folder of it, or out with null. */
  const moveTo = useCallback(
    (computer: string, keys: readonly string[], folderId: string | null) => {
      const ids = keys
        .map(splitKey)
        .filter((k) => k.computer === computer)
        .map((k) => k.id)
      if (ids.length < keys.length) {
        showNotice({ text: '只能移到同一台电脑上的文件夹，其他电脑的会话没有移动。' })
      }
      const link = computer === activeId ? activeLink : fleetLink(computer)
      return folderActions.move(ids, folderId, link)
    },
    [activeId, activeLink, folderActions],
  )

  // The rows call through these, so they need not redraw when the list's own state changes.
  const latest = useRef({
    actions,
    folderActions,
    onOpen: props.onOpen,
    foldersOf,
    sessionFolder,
    selection,
    moveTo,
    agents,
    link: activeLink,
  })
  latest.current = {
    actions,
    folderActions,
    onOpen: props.onOpen,
    foldersOf,
    sessionFolder,
    selection,
    moveTo,
    agents,
    link: activeLink,
  }
  const rowActions = useMemo<RowActions>(() => {
    const menuOf = (p: Placed): MenuNode[] => {
      const l = latest.current
      const key = placedKey(p)
      const folders = l.foldersOf.get(p.computer) ?? []
      const here = p.computer === activeId
      const agent = here ? l.agents.get(p.session.agentId) : undefined
      const canFork = !!agent?.capabilities.forkSession || !!agent?.capabilities.forkAtMessage
      const extras: MenuExtras = {
        folders: moveToFolderNodes(
          folders,
          [l.sessionFolder.get(key) ?? null],
          (folderId) => void l.moveTo(p.computer, [key], folderId),
          () => l.folderActions.create([p.session.id], here ? undefined : fleetLink(p.computer)),
        ),
        select: () => {
          haptic.select()
          select([key])
        },
        ...(here && canFork ? { fork: () => forkSession(l.link, p.session) } : {}),
      }
      return l.actions.menu(p.session, extras)
    }
    return {
      open: (p) => {
        if (p.computer === activeId) return latest.current.onOpen(p.session.id)
        // Another computer's session: that computer becomes the active one, as a link to it does.
        openLink({ target: { kind: 'session', id: p.session.id }, host: p.computer })
      },
      menu: menuOf,
      more: (p) => latest.current.actions.open(p.session),
      togglePin: (p) => latest.current.actions.togglePin(p.session),
      archive: (p) => latest.current.actions.archive(p.session),
      toggleCheck: (p) => {
        haptic.select()
        const key = placedKey(p)
        setSelection((was) => {
          const next = new Set(was ?? [])
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
      },
      drag: (p) => {
        const key = placedKey(p)
        const chosen = latest.current.selection
        const ids = chosen?.has(key) ? [...chosen] : [key]
        return {
          label: ids.length > 1 ? `${ids.length} 个会话` : sessionTitle(p.session),
          ids,
        }
      },
    }
  }, [activeId, select])

  const toggleGroup = (group: Group) => {
    haptic.select()
    if (group.kind === 'folder' && group.folder) {
      const link = group.computer === activeId ? activeLink : fleetLink(group.computer)
      folderActions.toggleCollapsed(group.folder, link)
      return
    }
    const next = new Set(prefs.homeCollapsed)
    if (next.has(group.key)) next.delete(group.key)
    else next.add(group.key)
    setPrefs({ homeCollapsed: [...next] })
  }

  const groupMenu = (group: Group): MenuNode[] => {
    const link = group.computer === activeId ? activeLink : fleetLink(group.computer)
    const fold: MenuNode = {
      key: 'fold',
      label: group.collapsed ? '展开' : '收起',
      icon: group.collapsed ? 'chevron.down' : 'chevron.up',
      onPress: () => toggleGroup(group),
    }
    const f = group.folder
    if (group.kind === 'folder' && f) {
      // Up and down among the folders shown beside it: the pinned ones, or the others.
      const beside = (foldersOf.get(group.computer) ?? []).filter((x) => x.pinned === f.pinned)
      const at = beside.findIndex((x) => x.id === f.id)
      const order: MenuNode[] = [
        ...(at > 0
          ? [
              {
                key: 'up',
                label: '上移',
                icon: 'arrow.up' as const,
                onPress: () => folderActions.shift(beside, f, -1, link),
              },
            ]
          : []),
        ...(at >= 0 && at < beside.length - 1
          ? [
              {
                key: 'down',
                label: '下移',
                icon: 'arrow.down' as const,
                onPress: () => folderActions.shift(beside, f, 1, link),
              },
            ]
          : []),
      ]
      return joinGroups([
        [
          {
            key: 'rename',
            label: '重命名…',
            icon: 'pencil',
            onPress: () => folderActions.rename(f, link),
          },
          {
            key: 'pin',
            label: f.pinned ? '取消置顶' : '置顶',
            icon: f.pinned ? 'pin.slash' : 'pin',
            onPress: () => folderActions.togglePin(f, link),
          },
          fold,
        ],
        order,
        [
          {
            key: 'delete',
            label: '删除文件夹…',
            icon: 'trash',
            destructive: true,
            onPress: () => folderActions.remove(f, link),
          },
        ],
      ])
    }
    const path = group.projectPath
    return [
      fold,
      ...(group.computer === activeId
        ? [
            {
              key: 'only',
              label: '只看这个项目',
              icon: 'line.3.horizontal.decrease' as const,
              onPress: () =>
                shell.setFilter(path ? { kind: 'project', path } : { kind: 'scratch' }),
            },
          ]
        : []),
    ]
  }

  const groupDrop = (group: Group): ((ids: string[]) => void) | null => {
    if (group.kind === 'folder' && group.folder) {
      const id = group.folder.id
      return (keys) => void moveTo(group.computer, keys, id)
    }
    // A project's header takes sessions out of their folders.
    return (keys) => {
      const inFolder = keys.filter((k) => sessionFolder.has(k))
      if (inFolder.length > 0) void moveTo(group.computer, inFolder, null)
    }
  }

  // ---- The menus of the top bar ----

  const projectCounts = useMemo(() => {
    const names = new Map<string, string>()
    const latestOf = new Map<string, { updated: number; count: number }>()
    let scratch = 0
    for (const p of placedAll) {
      const s = p.session
      if (s.archivedAt !== null) continue
      if (s.scratch) {
        scratch++
        continue
      }
      const seen = latestOf.get(s.projectPath)
      latestOf.set(s.projectPath, {
        updated: Math.max(seen?.updated ?? 0, s.updatedAt),
        count: (seen?.count ?? 0) + 1,
      })
      if (!names.has(s.projectPath)) {
        names.set(
          s.projectPath,
          projectNames.get(projectKey(p.computer, s.projectPath)) ?? folderName(s.projectPath),
        )
      }
    }
    const list = [...latestOf.entries()]
      .sort((a, b) => b[1].updated - a[1].updated)
      .map(([path, { count }]) => ({ path, count, name: names.get(path) ?? folderName(path) }))
    return { list, scratch }
  }, [placedAll, projectNames])

  const startSelecting = () => {
    haptic.select()
    select([])
  }

  const layers: MenuNode[] = [
    ...projectMenuNodes(shell.filter, projectCounts.list, projectCounts.scratch, shell.setFilter),
    { kind: 'divider', key: '__view', title: '显示方式' },
    {
      key: 'by-project',
      label: '按项目分组',
      icon: 'folder',
      checked: prefs.homeGrouping === 'project',
      onPress: () => setPrefs({ homeGrouping: 'project' }),
    },
    {
      key: 'by-time',
      label: '按时间',
      icon: 'clock',
      checked: prefs.homeGrouping === 'time',
      onPress: () => setPrefs({ homeGrouping: 'time' }),
    },
    {
      key: 'archived',
      label: '显示已归档',
      icon: 'archivebox',
      checked: prefs.homeShowArchived,
      onPress: () => setPrefs({ homeShowArchived: !prefs.homeShowArchived }),
    },
    { kind: 'divider', key: '__organize' },
    { key: 'select', label: '选择', icon: 'checkmark.circle', onPress: startSelecting },
    {
      key: 'new-folder',
      label: '新建文件夹…',
      icon: 'folder.badge.plus',
      disabled: !connected,
      onPress: () => folderActions.create(),
    },
  ]

  const computerItems = (h: SavedHost): MenuNode => {
    const isActive = h.id === activeId
    const status = isActive
      ? linkStatusOf(host.state, host.unreachable).text
      : fleet.get(h.id)?.state === 'connected'
        ? '已连接'
        : fleet.get(h.id)?.state === 'offline'
          ? '连不上'
          : allComputers
            ? '正在连接…'
            : '点按切换'
    return {
      key: `computer:${h.id}`,
      label: computerName(h),
      subtitle: status,
      icon: platformOf(h) === 'darwin' ? 'laptopcomputer' : 'desktopcomputer',
      checked: !allComputers && isActive,
      onPress: () => {
        haptic.select()
        if (prefs.homeScope !== 'one') setPrefs({ homeScope: 'one' })
        if (!isActive) switchTo(h.id)
      },
    }
  }
  const computers: MenuNode[] = joinGroups([
    several
      ? [
          {
            key: 'all',
            label: '全部电脑',
            subtitle: '同时显示每台电脑的会话',
            icon: 'square.stack.3d.up',
            checked: allComputers,
            onPress: () => {
              haptic.select()
              setPrefs({ homeScope: 'all' })
            },
          },
        ]
      : [],
    host.computers.map(computerItems),
    [
      { key: 'add', label: '添加电脑', icon: 'plus', onPress: () => router.push('/pair') },
      {
        key: 'manage',
        label: '管理电脑…',
        icon: 'gearshape',
        onPress: shell.openHost,
      },
    ],
  ])

  // ---- Selecting ----

  const chosen = useMemo(() => [...(selection ?? [])], [selection])
  const chosenPlaced = useMemo(() => {
    const byKey = new Map(placedAll.map((p) => [placedKey(p), p]))
    return chosen.flatMap((key) => {
      const p = byKey.get(key)
      return p ? [p] : []
    })
  }, [chosen, placedAll])
  const chosenComputers = [...new Set(chosenPlaced.map((p) => p.computer))]

  const linkOfComputer = (computer: string) =>
    computer === activeId ? activeLink : fleetLink(computer)

  const bulk = async (
    what: string,
    run: (link: HostLink, s: SessionSummary) => Promise<unknown>,
    list: Placed[],
  ): Promise<Placed[]> => {
    const done: Placed[] = []
    let failure: unknown = null
    for (const p of list) {
      const link = linkOfComputer(p.computer)
      if (!link) {
        failure ??= new Error('现在连不上这个会话所在的电脑。')
        continue
      }
      try {
        await run(link, p.session)
        done.push(p)
      } catch (error) {
        failure ??= error
      }
    }
    if (failure) {
      haptic.warning()
      Alert.alert(`有的会话没能${what}`, errorText(failure))
    } else haptic.success()
    return done
  }

  const archiveChosen = () => {
    const list = chosenPlaced.filter((p) => p.session.archivedAt === null)
    select(null)
    void bulk(
      '归档',
      (link, s) => link.request('sessions.archive', { sessionId: s.id }),
      list,
    ).then((done) => {
      if (done.length === 0) return
      showNotice({
        text: `已归档 ${done.length} 个会话`,
        action: {
          label: '撤销',
          onPress: () =>
            void bulk(
              '恢复',
              (link, s) => link.request('sessions.unarchive', { sessionId: s.id }),
              done,
            ),
        },
      })
    })
  }

  const deleteChosen = () => {
    const list = chosenPlaced.filter((p) => !turnRunning(p.session))
    const skipped = chosenPlaced.length - list.length
    if (list.length === 0) {
      Alert.alert('它们正在运行', '先停止这些会话，才能删除。')
      return
    }
    haptic.warning()
    Alert.alert(
      `删除 ${list.length} 个会话？`,
      `它们的对话和子会话会从电脑上删除，无法恢复。${skipped > 0 ? `正在运行的 ${skipped} 个不会删除。` : ''}`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            select(null)
            void bulk(
              '删除',
              (link, s) => link.request('sessions.delete', { sessionId: s.id }),
              list,
            ).then((done) => {
              if (done.length > 0) showNotice({ text: `已删除 ${done.length} 个会话` })
            })
          },
        },
      ],
    )
  }

  const moveMenu: MenuNode[] = chosenComputers.flatMap((computer, index) => {
    const keys = chosenPlaced.filter((p) => p.computer === computer).map(placedKey)
    const folders = foldersOf.get(computer) ?? []
    const title =
      chosenComputers.length > 1
        ? computerName(host.computers.find((h) => h.id === computer))
        : undefined
    const nodes = moveToFolderNodes(
      folders,
      keys.map((k) => sessionFolder.get(k) ?? null),
      (folderId) =>
        void moveTo(computer, keys, folderId).then((ok) => {
          if (ok) select(null)
        }),
      () => {
        folderActions.create(
          keys.map((k) => splitKey(k).id),
          computer === activeId ? undefined : fleetLink(computer),
        )
        select(null)
      },
    )
    return [
      ...(index > 0 || title
        ? [{ kind: 'divider' as const, key: `computer:${computer}`, ...(title ? { title } : {}) }]
        : []),
      ...nodes.map((node) => ({ ...node, key: `${computer}:${node.key}` })),
    ]
  })

  // ---- The list ----

  // With the cache's lists the summary still says what they said; the note under it says when.
  const summary =
    !connected && !host.loaded
      ? host.unreachable && host.state.kind !== 'stopped'
        ? `连不上「${computerName(active)}」。`
        : problem
      : null
  // Connected, it says what waits and what runs, each with its agents' avatars, as Kettu's does.
  const counts =
    summary === null ? (
      <Text style={[typeScale.lead, { color: c.textSecondary }]}>
        {waiting === 0 && runningNow.length === 0 ? (
          '这里没有需要你处理的。'
        ) : (
          <>
            你有
            {waiting > 0 ? (
              <>
                {' '}
                <Inline agents={live.map((p) => p.session).filter(needsYou)} />
                <Text style={{ color: c.text }}> {waiting} 个在等你</Text>
              </>
            ) : null}
            {waiting > 0 && runningNow.length > 0 ? '，' : null}
            {runningNow.length > 0 ? (
              <>
                {' '}
                <Inline agents={runningNow.map((p) => p.session)} />
                <Text style={{ color: c.text }}> {runningNow.length} 个运行中</Text>
              </>
            ) : null}
            。
          </>
        )}
      </Text>
    ) : (
      <Text style={[typeScale.lead, { color: c.textSecondary }]}>{summary}</Text>
    )

  const top = (
    <View style={styles.top}>
      <View style={styles.greeting} accessibilityRole="header">
        <Text style={[typeScale.lead, { color: c.textSecondary }]}>{greeting()}。</Text>
        {counts}
        {host.loaded ? <SyncNote /> : null}
      </View>
      <UpdateBanner />
      <HostVersionBanner />
      <FilterNote what="会话" />
    </View>
  )

  const empty = () => {
    if (!host.loaded && !allComputers) {
      if (!connected && host.unreachable && host.state.kind !== 'stopped') return <Unreachable />
      return <SessionRowSkeleton />
    }
    if (shell.filter.kind !== 'all') {
      return (
        <EmptyState
          icon="folder"
          title="这个项目里没有会话"
          action={{ label: '查看全部项目', onPress: () => shell.setFilter({ kind: 'all' }) }}
        />
      )
    }
    return (
      <EmptyState
        icon="message"
        title="还没有会话"
        message="在手机上开一个，电脑上的 Agent 就会开始干活。"
        action={
          host.state.kind !== 'stopped'
            ? { label: '新会话', onPress: () => router.push('/new') }
            : undefined
        }
      />
    )
  }

  const footer =
    archivedCount > 0 && !prefs.homeShowArchived ? (
      <Press
        onPress={() => router.push('/archived')}
        scale={false}
        accessibilityRole="button"
        style={styles.archived}
      >
        <Icon name="archive" size={18} color={c.textSecondary} />
        <Text style={[typeScale.callout, { color: c.textSecondary, flex: 1 }]}>已归档的会话</Text>
        <Text style={[typeScale.callout, styles.count, { color: c.textTertiary }]}>
          {archivedCount}
        </Text>
        <Icon name="chevronRight" size={13} color={c.textTertiary} weight="semibold" />
      </Press>
    ) : null

  // Sessions new to the list since it first showed come in with an animation; rows the list only
  // mounts again as it scrolls do not.
  const seen = useRef<Set<string> | null>(null)
  const fresh = useRef(new Set<string>())
  const ids = items.flatMap((item) => (item.kind === 'session' ? [item.key] : []))
  if (seen.current === null) {
    if (ids.length > 0) seen.current = new Set(ids)
  } else {
    for (const sid of ids) {
      if (!seen.current.has(sid)) {
        seen.current.add(sid)
        fresh.current.add(sid)
      }
    }
  }
  useEffect(() => {
    fresh.current.clear()
  })

  const renderItem = ({ item }: { item: HomeItem }) => {
    if (item.kind === 'section') {
      return (
        <View style={styles.pad}>
          <SectionHeader
            title={item.title}
            count={item.count}
            color={item.waiting ? c.warning : undefined}
            right={
              item.key === '__folders' && connected ? (
                <IconButton
                  icon="folderPlus"
                  tone="plain"
                  size={32}
                  iconSize={18}
                  label="新建文件夹"
                  color={c.textSecondary}
                  onPress={() => folderActions.create()}
                />
              ) : undefined
            }
          />
        </View>
      )
    }
    if (item.kind === 'group') {
      return (
        <View style={styles.groupPad}>
          <GroupHeader
            group={item.group}
            mark={marks.get(item.group.computer)}
            menu={groupMenu(item.group)}
            onToggle={() => toggleGroup(item.group)}
            onDrop={selecting ? groupDrop(item.group) : null}
          />
        </View>
      )
    }
    if (item.kind === 'more') {
      const open = expanded.has(item.group)
      return (
        <Press
          onPress={() => {
            haptic.select()
            setExpanded((was) => {
              const next = new Set(was)
              if (next.has(item.group)) next.delete(item.group)
              else next.add(item.group)
              return next
            })
          }}
          scale={false}
          accessibilityRole="button"
          style={styles.more}
        >
          <Text style={[typeScale.subhead, { color: c.tint }]}>
            {open ? '收起' : `显示全部 ${item.total} 个`}
          </Text>
        </Press>
      )
    }
    if (item.kind === 'task') {
      const t = item.task
      return (
        <TaskRow
          task={t}
          view={taskViews.get(t.id)}
          projectName={projectNames.get(projectKey(activeId, t.projectPath))}
          onPress={() => router.push(`/task/${t.id}`)}
        />
      )
    }
    const p = item.placed
    const s = p.session
    const here = p.computer === activeId
    return (
      <HomeRow
        placed={p}
        taskTitle={s.task && here ? taskTitles.get(s.task.taskId) : undefined}
        subagents={subagents.get(s.id)}
        agentName={here ? agents.get(s.agentId)?.name : undefined}
        projectName={projectNames.get(projectKey(p.computer, s.projectPath))}
        selected={here && props.selected === s.id}
        appear={fresh.current.has(item.key)}
        connected={here ? connected : fleet.get(p.computer)?.state === 'connected'}
        mark={marks.get(p.computer)}
        check={selection ? selection.has(item.key) : undefined}
        folders={foldersOf.get(p.computer) ?? NO_FOLDERS}
        actions={rowActions}
      />
    )
  }

  return (
    <Screen>
      <DragProvider>
        <AnimatedFlashList
          ref={list}
          data={items}
          extraData={[props.selected, selection, marks]}
          keyExtractor={itemKey}
          getItemType={itemType}
          renderItem={renderItem}
          {...header.scrollProps}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            paddingTop: header.contentTop,
            paddingBottom: insets.bottom + TAB_BAR_CLEARANCE + (selecting ? SELECT_BAR : 0),
          }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              tintColor={c.textSecondary}
              progressViewOffset={header.height}
              onRefresh={() => {
                setRefreshing(true)
                retry()
                if (allComputers) wakeFleet()
                void refresh()
                  .catch(() => {})
                  .finally(() => setRefreshing(false))
              }}
            />
          }
          ListHeaderComponent={top}
          ListEmptyComponent={empty()}
          ListFooterComponent={footer ?? undefined}
        />
      </DragProvider>
      {selecting ? (
        <FloatingHeader header={header}>
          <Pill tone="glass" size="bar" label="完成" onPress={() => select(null)} />
          <View style={styles.spacer} />
          <Text style={[typeScale.headline, { color: c.text }]}>
            {chosen.length > 0 ? `已选择 ${chosen.length} 个` : '选择会话'}
          </Text>
          <View style={styles.spacer} />
          <Pill
            tone="glass"
            size="bar"
            label="全选"
            onPress={() => {
              haptic.select()
              select(items.flatMap((item) => (item.kind === 'session' ? [item.key] : [])))
            }}
          />
        </FloatingHeader>
      ) : (
        <TopBar
          header={header}
          layers={layers}
          computers={{ items: computers, all: allComputers }}
        />
      )}
      {selecting ? (
        <View
          style={[
            styles.selectBar,
            {
              // Over iOS's floating tab bar; Android's takes its own room below the screen.
              bottom: insets.bottom + (Platform.OS === 'ios' ? sizes.tabBar : 0) + space.sm,
              backgroundColor: c.surfaceRaised,
              borderColor: c.border,
              shadowColor: c.shadow,
            },
          ]}
        >
          <TapMenu items={moveMenu} title="移到文件夹" disabled={chosen.length === 0}>
            {(open) => (
              <BarButton
                icon="folder"
                label="移到文件夹"
                disabled={chosen.length === 0}
                onPress={open ?? noop}
              />
            )}
          </TapMenu>
          <BarButton
            icon="archive"
            label="归档"
            disabled={chosen.length === 0}
            onPress={archiveChosen}
          />
          <BarButton
            icon="trash"
            label="删除"
            danger
            disabled={chosen.length === 0}
            onPress={deleteChosen}
          />
        </View>
      ) : null}
      {actions.element}
      {folderActions.element}
    </Screen>
  )
}

const NO_FOLDERS: readonly SessionFolder[] = []
const SELECT_BAR = 64
const noop = () => {}

function BarButton(props: {
  icon: 'folder' | 'archive' | 'trash'
  label: string
  danger?: boolean
  disabled?: boolean
  onPress(): void
}) {
  const { c } = useTokens()
  const color = props.disabled ? c.textTertiary : props.danger ? c.danger : c.tint
  return (
    <Press
      onPress={props.onPress}
      disabled={props.disabled}
      scale={false}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      style={styles.barButton}
    >
      <Icon name={props.icon} size={20} color={color} />
      <Text style={[typeScale.caption, { color }]}>{props.label}</Text>
    </Press>
  )
}

const REASONS = [
  '电脑上的纸鸢没开，或者电脑睡着了',
  '手机和电脑不在同一个网络，或者 Tailscale 没连上',
  '电脑上的「设置 › 远程访问」被关掉了',
]

/** Nothing cached and no link for a while: why that may be, and a way to try again. */
function Unreachable() {
  const { c } = useTokens()
  const host = useHost()
  const several = host.computers.length > 1
  return (
    <View style={styles.pad}>
      <View style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}>
        <View style={[styles.badge, { backgroundColor: c.fill }]}>
          <Icon name="wifi" size={24} color={c.textSecondary} />
        </View>
        <Text style={[typeScale.headline, { color: c.text }]}>
          连不上「{computerName(host.host)}」
        </Text>
        <Text style={[typeScale.footnote, { color: c.textSecondary }]}>可能是：</Text>
        {REASONS.map((reason) => (
          <View key={reason} style={styles.reason}>
            <Text style={[typeScale.callout, { color: c.textSecondary }]}>·</Text>
            <Text style={[typeScale.callout, styles.flex, { color: c.text }]}>{reason}</Text>
          </View>
        ))}
        <Text style={[typeScale.footnote, { color: c.textTertiary }]}>
          纸鸢会在后台继续尝试，连上后这里会自动出现会话。
        </Text>
        <View style={styles.buttons}>
          <Pill
            tone="tint"
            label="重试"
            leading={<Icon name="refresh" size={14} color={c.tint} />}
            onPress={() => {
              haptic.tap()
              host.retry()
            }}
          />
          {several ? (
            <Pill
              tone="fill"
              label="换一台电脑"
              onPress={() => router.push('/settings/computers')}
            />
          ) : null}
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  inline: { flexDirection: 'row', alignItems: 'center', transform: [{ translateY: 5 }] },
  inlineAvatar: { borderWidth: 2, borderRadius: 14 },
  card: {
    marginTop: space.lg,
    padding: space.lg,
    gap: space.sm,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  badge: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xs,
  },
  reason: { flexDirection: 'row', gap: space.sm },
  flex: { flex: 1 },
  spacer: { flex: 1 },
  buttons: { flexDirection: 'row', gap: space.sm, marginTop: space.sm },
  split: { flex: 1, flexDirection: 'row' },
  column: { width: LIST_COLUMN },
  divider: { width: StyleSheet.hairlineWidth },
  pane: { flex: 1 },
  placeholder: { flex: 1, justifyContent: 'center' },
  pad: { paddingHorizontal: space.xl },
  groupPad: { paddingHorizontal: space.md },
  group: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: sizes.hit,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
    borderWidth: 1.5,
  },
  groupTitle: { flexShrink: 1 },
  groupMark: { flexDirection: 'row', alignItems: 'center', gap: 3, flexShrink: 1 },
  more: { paddingHorizontal: space.xl + sizes.rowAvatar + space.md + 2, paddingVertical: space.sm },
  top: { paddingHorizontal: space.xl, paddingTop: space.sm },
  greeting: { gap: space.xs, paddingTop: space.md, paddingBottom: space.sm },
  archived: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginTop: space.lg,
    paddingHorizontal: space.xl,
    paddingVertical: space.lg,
  },
  count: { fontVariant: ['tabular-nums'] },
  selectBar: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    height: SELECT_BAR,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  barButton: {
    alignItems: 'center',
    gap: 2,
    paddingHorizontal: space.lg,
    paddingVertical: space.xs,
  },
})
