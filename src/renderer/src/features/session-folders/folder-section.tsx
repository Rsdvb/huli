// Huli: the sidebar's Folders, above or below the projects: each folder as a group of its
// sessions, pinned ones first, with a header that folds it and takes dropped sessions. Huli's own;
// see tools/huli/README.md.

import { isParked } from '@shared/session-tidy'
import { useMemo, useState } from 'react'
import {
  Add01Icon,
  ArrowRight01Icon,
  Delete02Icon,
  Folder01Icon,
  FolderAddIcon,
  FolderOpenIcon,
  FolderPinIcon,
  MoreHorizontalIcon,
  PencilEdit02Icon,
  PinIcon,
  PinOffIcon,
  SlidersHorizontalIcon,
} from '@hugeicons/core-free-icons'
import { AnimatePresence } from 'motion/react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { shownFolders, type SessionFolder } from '@shared/session-folders'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { useEntry } from '@renderer/lib/features'
import { GroupOrderItems } from '@renderer/features/sidebar/group-order-menu'
import { GroupRenameHints } from '@renderer/features/sidebar/rename-hints'
import { useRowGroup, type RowGroup } from '@renderer/features/sidebar/row-drag'
import { RenameScope } from '@renderer/features/sidebar/rename-scope'
import { limitRows, rowInSight, ROWS_SHOWN } from '@renderer/features/sidebar/row-limit'
import { INDENT_PAD, SessionRow } from '@renderer/features/sidebar/session-row'
import { RunGroupRow } from '@renderer/features/sidebar/run-group-row'
import { Glyph, MenuGlyph } from '@renderer/features/shell/glyph'
import { cn } from '@renderer/lib/utils'
import {
  byGroupOrder,
  hostOfSession,
  keepSameNodes,
  listedOrigin,
  liveTree,
  sidebarRows,
  useSessionsStore,
  type SessionNode,
  type SidebarTabStop,
} from '@renderer/stores/sessions'
import { showAllRows, useViewStore } from '@renderer/stores/view'
import { useDraggingFoldered, useFolderDrop } from './drag'
import {
  askFolderDialog,
  hostKey,
  setFolderPlace,
  updateFolder,
  useHostFolders,
  useSessionFoldersStore,
  type FolderPlace,
} from './store'

/**
 * The host's folders where the sidebar places them: `at` is the place this slot stands for, so a
 * list has one slot above its projects and one below, and only the chosen one shows. Nothing shows
 * for a host without folders.
 */
export function FolderSection({
  hostId,
  at,
  stop,
}: {
  hostId: string | null
  at: FolderPlace
  stop: SidebarTabStop | null
}) {
  const place = useSessionFoldersStore((s) => s.place)
  const folders = useHostFolders(hostId)
  if (place !== at || !folders) return null
  return <FolderList hostId={hostId} folders={folders} stop={stop} />
}

function FolderList({
  hostId,
  folders,
  stop,
}: {
  hostId: string | null
  folders: SessionFolder[]
  stop: SidebarTabStop | null
}) {
  const { t } = useTranslation('sessionFolders')
  const key = hostKey(hostId)
  const shown = useMemo(() => shownFolders(folders), [folders])
  const { attach: newTarget, over: newOver } = useFolderDrop(`new:${key}`, { kind: 'new', hostId })
  const { attach: ungroupTarget, over: ungroupOver } = useFolderDrop(`ungroup:${key}`, {
    kind: 'ungroup',
    hostId,
  })
  const dragging = useDraggingFoldered(hostId)
  const [optionsOpen, setOptionsOpen] = useState(false)
  // The host's listed sessions, with the sub-sessions a folder's rows show under them.
  const summaries = useSessionsStore(
    useShallow((s) =>
      Object.values(s.byId).filter((x) => listedOrigin(x) && hostOfSession(x) === hostId),
    ),
  )
  // A pinned session shows under Pinned, as it does for its project.
  const roots = useMemo(() => {
    const nodes = liveTree(Object.fromEntries(summaries.map((x) => [x.id, x])))
    // Huli: and a snoozed or settled one in its group out of the list.
    return new Map(
      nodes
        .filter((n) => !n.summary.pinnedAt && !isParked(n.summary))
        .map((n) => [n.summary.id, n]),
    )
  }, [summaries])
  const place = useSessionFoldersStore((s) => s.place)
  const newFolder = () => askFolderDialog({ kind: 'create', hostId, sessionIds: [] })

  return (
    <section aria-label={t('section')} className="ui-as-side__group">
      <div
        ref={newTarget}
        data-drop={newOver || undefined}
        className="rounded-md data-drop:bg-(--hover) data-drop:text-(--ink)"
      >
        <div
          // As a group's first label, which this wrapper keeps it from being.
          className="group/folders ui-as-side__label mt-1.5! flex items-center gap-1"
          data-menu={optionsOpen || undefined}
        >
          <span className="min-w-0 flex-1 truncate">{t('section')}</span>
          <span
            className={cn(
              '-my-1 flex shrink-0 gap-0.5 opacity-0 transition-opacity duration-(--duration-fast)',
              'hover-folders:opacity-100 focus-within-folders:opacity-100',
              optionsOpen && 'opacity-100',
            )}
          >
            <DropdownMenu open={optionsOpen} onOpenChange={setOptionsOpen}>
              <DropdownMenuTrigger
                render={
                  <button
                    type="button"
                    aria-label={t('actions.options')}
                    title={t('actions.options')}
                    className="ui-as-chat-row__tool"
                  />
                }
              >
                <Glyph icon={SlidersHorizontalIcon} size={14} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuGroup>
                  <DropdownMenuItem onClick={newFolder}>
                    <MenuGlyph icon={FolderAddIcon} />
                    {t('actions.newMore')}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{t('place.label')}</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={place}
                    onValueChange={(value: string) =>
                      setFolderPlace(value === 'below' ? 'below' : 'above')
                    }
                  >
                    <DropdownMenuRadioItem value="above">{t('place.above')}</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="below">{t('place.below')}</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              type="button"
              aria-label={t('actions.new')}
              title={t('actions.new')}
              onClick={newFolder}
              className="ui-as-chat-row__tool"
            >
              <Glyph icon={Add01Icon} size={14} />
            </button>
          </span>
        </div>
        {shown.length === 0 && <span className="ui-as-side__empty block">{t('empty')}</span>}
      </div>
      {shown.map((folder) => (
        <FolderGroup key={folder.id} folder={folder} hostId={hostId} roots={roots} stop={stop} />
      ))}
      {dragging && (
        <div
          ref={ungroupTarget}
          data-drop={ungroupOver || undefined}
          title={t('ungroupHint')}
          className="ui-as-side__item ui-as-chat-folder border border-dashed border-(--line-strong)"
        >
          <Glyph icon={Folder01Icon} size={16} />
          <span className="ui-as-side__text">{t('ungrouped')}</span>
        </div>
      )}
    </section>
  )
}

/** A folder's header and, while it is open, its sessions, the latest active first. */
function FolderGroup({
  folder,
  hostId,
  roots,
  stop,
}: {
  folder: SessionFolder
  hostId: string | null
  roots: ReadonlyMap<string, SessionNode>
  stop: SidebarTabStop | null
}) {
  const { t } = useTranslation(['sessionFolders', 'sidebar'])
  const key = `huli-folder:${hostKey(hostId)}:${folder.id}`
  const open = !folder.collapsed
  const allShown = useViewStore((s) => !!s.allRowsShown[key])
  const shownId = useViewStore((s) => (s.main.kind === 'session' ? s.main.sessionId : null))
  const [moreOpen, setMoreOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const { attach: dropTarget, over: dropOver } = useFolderDrop(key, {
    kind: 'folder',
    hostId,
    folderId: folder.id,
  })
  const nodes = useKeptNodes(
    useMemo(
      () => folder.sessionIds.flatMap((id) => (roots.has(id) ? [roots.get(id)!] : [])),
      [folder.sessionIds, roots],
    ),
  )
  const fold = useEntry('sidebar.runGroup')
  // Huli: the user's own order once a row was dragged (shared/session-order.ts), else activity.
  const order = folderOrder(folder)
  const rows = useMemo(
    () => sidebarRows(nodes, [], byGroupOrder(order), fold),
    [nodes, order, fold],
  )
  useRowGroup(
    useMemo(
      (): RowGroup => ({
        key,
        kind: 'folder',
        hostId,
        path: null,
        folderId: folder.id,
        name: folder.name,
        rows: rows.map((row) => row.id),
        sessions: new Map(
          rows.flatMap((row) =>
            row.kind === 'group' ? [[row.id, row.runs.map((run) => run.summary.id)]] : [],
          ),
        ),
        order,
        away: false,
        missing: false,
      }),
      [key, hostId, folder.id, folder.name, rows, order],
    ),
  )
  const limited = limitRows(rows, allShown, (row) => rowInSight(row, shownId))
  const tabStopId = stop?.kind === 'session' ? stop.id : null
  const toggle = () => void updateFolder(hostId, folder.id, { collapsed: open })
  const icon = folder.pinned ? FolderPinIcon : open ? FolderOpenIcon : Folder01Icon

  const header = (
    <button
      ref={dropTarget}
      type="button"
      data-sidebar-row=""
      tabIndex={-1}
      aria-expanded={open}
      data-drop={dropOver || undefined}
      title={folder.name}
      onClick={toggle}
      onKeyDown={(event) => {
        // The context menu key opens the More menu, the row's menu for the keyboard.
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault()
          setMoreOpen(true)
        } else if (event.key === 'ArrowRight' && !open) toggle()
        else if (event.key === 'ArrowLeft' && open) toggle()
      }}
      className="ui-as-side__item ui-as-chat-folder"
    >
      <Glyph icon={icon} size={16} />
      <span className="ui-as-side__text">{folder.name}</span>
      {folder.pinned && <span className="sr-only">{t('pinnedFolder')}</span>}
      <span className="ui-as-chat-folder__arrow" aria-hidden>
        <Glyph icon={ArrowRight01Icon} size={13} />
      </span>
      <span
        aria-label={t('sessions', { count: rows.length })}
        className="ml-auto shrink-0 text-[12px] font-normal text-(--faint) tabular-nums"
      >
        {rows.length}
      </span>
    </button>
  )
  const items = <FolderMenuItems folder={folder} hostId={hostId} />

  return (
    <>
      <div className="ui-as-chat-folder-row" data-menu={moreOpen || menuOpen || undefined}>
        <ContextMenu onOpenChange={setMenuOpen}>
          <ContextMenuTrigger render={header} />
          <ContextMenuContent>{items}</ContextMenuContent>
        </ContextMenu>
        <span className="ui-as-chat-row__tools">
          <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
            <DropdownMenuTrigger
              render={
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label={t('actions.moreFor', { name: folder.name })}
                  title={t('sidebar:row.more')}
                  className="ui-as-chat-row__tool"
                />
              }
            >
              <Glyph icon={MoreHorizontalIcon} size={15} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">{items}</DropdownMenuContent>
          </DropdownMenu>
        </span>
      </div>
      {open && (
        <ul className="ui-as-chat-folder__chats" data-row-group={key}>
          {rows.length === 0 && (
            <li className="ui-as-side__empty" style={{ paddingLeft: INDENT_PAD }}>
              {t('folderEmpty')}
            </li>
          )}
          <RenameScope value={key}>
            <AnimatePresence initial={false}>
              {limited.rows.map((row) =>
                row.kind === 'session' ? (
                  <SessionRow key={row.id} node={row.node} tabStopId={tabStopId} indent />
                ) : row.kind === 'group' ? (
                  <RunGroupRow
                    key={row.id}
                    group={row.group}
                    runs={row.runs}
                    tabStopId={tabStopId}
                    indent
                  />
                ) : null,
              )}
            </AnimatePresence>
          </RenameScope>
          {(limited.hidden > 0 || allShown) && rows.length > ROWS_SHOWN && (
            <li className="flex">
              <button
                type="button"
                data-sidebar-row=""
                tabIndex={-1}
                onClick={() => showAllRows(key, !allShown)}
                className="ui-as-side__item kettu-side-more"
              >
                <span className="ui-as-side__text">
                  {allShown
                    ? t('sidebar:list.showLess')
                    : t('sidebar:list.showMore', { count: limited.hidden })}
                </span>
              </button>
            </li>
          )}
          <GroupRenameHints scope={key} />
        </ul>
      )}
    </>
  )
}

/** A folder's actions, for its header's context menu and its More button alike. */
function FolderMenuItems({ folder, hostId }: { folder: SessionFolder; hostId: string | null }) {
  const { t } = useTranslation('sessionFolders')
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuItem onClick={() => askFolderDialog({ kind: 'rename', hostId, folder })}>
          <MenuGlyph icon={PencilEdit02Icon} />
          {t('actions.rename')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => void updateFolder(hostId, folder.id, { pinned: !folder.pinned })}
        >
          <MenuGlyph icon={folder.pinned ? PinOffIcon : PinIcon} />
          {folder.pinned ? t('actions.unpin') : t('actions.pin')}
        </DropdownMenuItem>
      </DropdownMenuGroup>
      <GroupOrderItems
        groupKey={`huli-folder:${hostKey(hostId)}:${folder.id}`}
        order={folderOrder(folder)}
      />
      <DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => askFolderDialog({ kind: 'create', hostId, sessionIds: [] })}
        >
          <MenuGlyph icon={FolderAddIcon} />
          {t('actions.newMore')}
        </DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => askFolderDialog({ kind: 'delete', hostId, folder })}
        >
          <Glyph icon={Delete02Icon} size={15} />
          {t('actions.delete')}
        </DropdownMenuItem>
      </DropdownMenuGroup>
    </>
  )
}

/** The folder's order as a group's: its sessions once manual, null by activity, none on an old host. */
function folderOrder(folder: SessionFolder): readonly string[] | null | undefined {
  return folder.manual === undefined ? undefined : folder.manual ? folder.sessionIds : null
}

/** `next`, with the nodes of rows that did not change kept from before, so those rows skip a render. */
function useKeptNodes(next: SessionNode[]): SessionNode[] {
  const [kept, setKept] = useState({ from: next, nodes: next })
  if (kept.from === next) return kept.nodes
  const nodes = keepSameNodes(kept.nodes, next)
  setKept({ from: next, nodes })
  return nodes
}
