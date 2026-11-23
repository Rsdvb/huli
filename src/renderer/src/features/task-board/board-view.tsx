// Huli: the task board, the Overview page's Board view. The user's own top-level sessions sit in
// four columns of their own workflow, dragged between them with dnd-kit; each card shows what
// Kite marks by itself too. Every read comes from the session list through selectors that return
// strings, so a card renders again only when its own session changes, and the columns only when a
// card comes, goes or moves. See tools/huli/README.md (Task board).

import { memo, useMemo, useState } from 'react'
import {
  DragDropProvider,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/react'
import { DragFeedback, lightPlugins } from '@renderer/components/drag-feedback'
import { ArrowDown01Icon, Folder01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { BOARD_STATUSES, type BoardStatus } from '@shared/session-board'
import { AgentMark } from '@renderer/components/agents/agent-mark'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Glyph } from '@renderer/features/shell/glyph'
import { WORKTREE_ICON } from '@renderer/features/session/worktree/worktree-icon'
import { basename } from '@renderer/lib/format'
import { hostPath } from '@renderer/lib/host-paths'
import { hostOfSession, sessionTitle, useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import { boardProject, columnsKey, columnsOf, kiteMark, projectsKey } from './model'
import { moveOnBoard } from './move'
import { BoardGlyph, BoardStatusItems } from './status'
import {
  useBoardLabel,
  useCardDrag,
  useColumnDrop,
  type CardData,
  type ColumnData,
} from './use-board'
import './board.css'

// A mouse press that moves starts a drag and one held in place still clicks; Space picks a card
// up from the keyboard, since Enter opens it.
const pointerDefaults = PointerSensor.defaults.activationConstraints
const sensors = [
  PointerSensor.configure({
    activationConstraints: (event, source) => {
      const constraints =
        typeof pointerDefaults === 'function' ? pointerDefaults(event, source) : pointerDefaults
      return event.pointerType === 'mouse' ? constraints?.slice(1) : constraints
    },
  }),
  KeyboardSensor.configure({
    keyboardCodes: { ...KeyboardSensor.defaults.keyboardCodes, start: ['Space'] },
  }),
]

/** The board of one project, or of every project with `project` null. */
export function BoardView({ project }: { project: string | null }) {
  const key = useSessionsStore((s) => columnsKey(s.byId, project))
  const columns = useMemo(() => columnsOf(key), [key])
  const [dragging, setDragging] = useState<string | null>(null)
  const start = (event: DragStartEvent) => {
    const data = event.operation.source?.data as CardData | undefined
    setDragging(data?.sessionId ?? null)
  }
  const end = (event: DragEndEvent) => {
    setDragging(null)
    const card = event.operation.source?.data as CardData | undefined
    const column = event.operation.target?.data as ColumnData | undefined
    if (event.canceled || !card?.sessionId || !column?.boardStatus) return
    void moveOnBoard(card.sessionId, column.boardStatus)
  }
  return (
    <DragDropProvider sensors={sensors} plugins={lightPlugins} onDragStart={start} onDragEnd={end}>
      <DragFeedback />
      <div className="kb-frame">
        <div className="kb-board">
          {BOARD_STATUSES.map((status) => (
            <BoardColumn
              key={status}
              status={status}
              ids={columns[status].join('\n')}
              showProject={project === null}
            />
          ))}
        </div>
      </div>
      <DragOverlay dropAnimation={null}>
        {dragging && <CardChip sessionId={dragging} />}
      </DragOverlay>
    </DragDropProvider>
  )
}

/** A column, its cards' ids as one string, so it renders again only when they change. */
const BoardColumn = memo(function BoardColumn({
  status,
  ids,
  showProject,
}: {
  status: BoardStatus
  ids: string
  showProject: boolean
}) {
  const { t } = useTranslation('overview')
  const label = useBoardLabel()
  const { attach, over } = useColumnDrop(status)
  const list = ids === '' ? [] : ids.split('\n')
  return (
    <section
      ref={attach}
      className="kb-col"
      data-over={over || undefined}
      aria-label={label(status)}
    >
      <h2 className="kb-col__head">
        <BoardGlyph status={status} size={14} />
        <b>{label(status)}</b>
        <span>{list.length}</span>
      </h2>
      {list.length === 0 ? (
        <p className="kb-col__empty">{t(`board.empty.${status}`)}</p>
      ) : (
        <ul className="kb-col__cards">
          {list.map((id) => (
            <BoardCard key={id} sessionId={id} showProject={showProject} />
          ))}
        </ul>
      )}
    </section>
  )
})

/** A session's card: its agent, title, project and worktree, and Kite's own mark for it. */
const BoardCard = memo(function BoardCard({
  sessionId,
  showProject,
}: {
  sessionId: string
  showProject: boolean
}) {
  const summary = useSessionsStore((s) => s.byId[sessionId])
  const { attach, dragging } = useCardDrag(sessionId)
  if (!summary) return null
  const project = boardProject(summary)
  const place = showProject ? projectName(project) : null
  const branch = summary.worktree?.branch ?? summary.branch
  const card = (
    <button
      ref={attach}
      type="button"
      className="kb-card"
      data-dragging={dragging || undefined}
      onClick={() => openSession(summary.id, summary.projectPath)}
    >
      <span className="kb-card__title">
        <AgentMark agent={summary.agentId} size={14} hostId={hostOfSession(summary)} />
        <span dir="auto">{sessionTitle(summary)}</span>
      </span>
      <span className="kb-card__meta">
        {place !== null && <span className="kb-card__place">{place}</span>}
        {branch && (
          <span className="kb-card__branch">
            {summary.worktree && <Glyph icon={WORKTREE_ICON} size={12} />}
            <span>{branch}</span>
          </span>
        )}
        <KiteMarkTag summary={summary} />
      </span>
    </button>
  )
  return (
    <li className="kb-card-item">
      <ContextMenu>
        <ContextMenuTrigger render={card} />
        <ContextMenuContent>
          <BoardStatusItems summary={summary} />
        </ContextMenuContent>
      </ContextMenu>
    </li>
  )
})

/** What Kite marks by itself, in the Overview's words and colors; nothing for an idle session. */
function KiteMarkTag({ summary }: { summary: Parameters<typeof kiteMark>[0] }) {
  const { t } = useTranslation('overview')
  const mark = kiteMark(summary)
  if (!mark) return null
  return (
    <span className="kb-card__mark" data-state={mark}>
      <i />
      {t(`states.${mark}`)}
    </span>
  )
}

/** The card under the pointer while it is dragged. */
function CardChip({ sessionId }: { sessionId: string }) {
  const summary = useSessionsStore((s) => s.byId[sessionId])
  if (!summary) return null
  return (
    <div className="kb-chip">
      <AgentMark agent={summary.agentId} size={14} hostId={hostOfSession(summary)} />
      <span>{sessionTitle(summary)}</span>
    </div>
  )
}

function projectName(project: string): string | null {
  return project === '' ? null : basename(hostPath(project))
}

/** The board's project filter in the page's head: every project, or the one chosen. */
export function BoardProjectFilter({
  project,
  onChange,
}: {
  project: string | null
  onChange: (project: string | null) => void
}) {
  const { t } = useTranslation('overview')
  const { t: ts } = useTranslation('sidebar')
  const key = useSessionsStore((s) => projectsKey(s.byId))
  const projects = useMemo(() => {
    const listed = JSON.parse(key) as string[]
    return project !== null && !listed.includes(project) ? [...listed, project] : listed
  }, [key, project])
  const name = (path: string) => projectName(path) ?? ts('project.noProject')
  const ALL = '\u0000all'
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<button type="button" className="kb-filter" aria-label={t('board.project')} />}
      >
        <Glyph icon={Folder01Icon} size={14} />
        <span>{project === null ? t('board.allProjects') : name(project)}</span>
        <Glyph icon={ArrowDown01Icon} size={12} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-96 w-60">
        <DropdownMenuRadioGroup
          value={project ?? ALL}
          onValueChange={(value: string) => onChange(value === ALL ? null : value)}
        >
          <DropdownMenuRadioItem value={ALL} closeOnClick>
            {t('board.allProjects')}
          </DropdownMenuRadioItem>
          {projects.length > 0 && <DropdownMenuSeparator />}
          {projects.map((path) => (
            <DropdownMenuRadioItem key={path} value={path} closeOnClick>
              <span className="min-w-0 truncate">{name(path)}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
