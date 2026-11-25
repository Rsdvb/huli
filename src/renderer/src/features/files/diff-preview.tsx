import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import type { SelectedLineRange } from '@pierre/diffs'
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  AtIcon,
  BubbleChatIcon,
  File01Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { FileDiff } from '@shared/git'
import { RenderCount } from '@renderer/features/diff-notes/notes'
import { NotesLayer, type NoteEditing } from '@renderer/features/diff-notes/notes-layer'
import { NotesTray } from '@renderer/features/diff-notes/notes-tray'
import { LineCounts } from '@renderer/features/git/rows'
import {
  FindingDetailLayer,
  FindingFocus,
  FindingsAbove,
} from '@renderer/features/review/diff-findings'
import { useDiffFindings } from '@renderer/features/review/use-diff-findings'
import { FindingsStrip } from '@renderer/features/review/findings-strip'
import { PaneReviewButton } from '@renderer/features/review/review-button'
import { useReview } from '@renderer/features/review/review'
import { useNoteCount } from '@renderer/features/session/composer/drafts'
import { PaneContext, PaneIcon, PanelButton } from '@renderer/features/shell/panel-button'
import {
  diffId,
  diffKey,
  openFile,
  showOpenDiff,
  useFilesStore,
  type DiffTarget,
  type DiffView,
} from '@renderer/stores/files'
import type { DocTab } from '@renderer/stores/view'
import { PathCopy } from './file-header'
import { Lines, Notice } from './file-preview'
import { stepChange, useParsedDiff } from './diff-nav'
import { FilesDiff } from './files-diff'
import { mentionLines, selectedLines, type MentionMiss } from './mention-lines'

const UNREAD: DiffView = { result: null, error: null }
const FROM_PANEL = { fromPanel: true }

/**
 * A diff tab's content: its context bar, then a file's change, uncommitted against `HEAD` or at a
 * commit. Huli: its lines take comments for `sessionId`'s agent, the session whose side panel
 * shows it, when there is one, and show that session's review findings.
 */
export function DiffPreview({
  projectPath,
  tab,
  sessionId,
}: {
  projectPath: string
  tab: Extract<DocTab, { kind: 'diff' }>
  sessionId: string | null
}) {
  const { path, oldPath, ref, projectFile } = tab
  const view = useFilesStore((s) => s.diffs[diffKey(projectPath, diffId(tab))] ?? UNREAD)
  // Read as the tab shows: again after it was left, and after a restart brought it back.
  useEffect(() => {
    showOpenDiff(projectPath, { path, oldPath, ref, projectFile })
  }, [projectPath, path, oldPath, ref, projectFile])
  const { result, error } = view
  const drawn =
    result && !result.binary && !result.tooLarge && result.oldText !== result.newText
      ? result
      : null
  return (
    <div className="kp-doc">
      {drawn ? (
        <Changes
          key={`${drawn.path}\0${ref ?? ''}`}
          projectPath={projectPath}
          diff={tab}
          result={drawn}
          sessionId={sessionId}
        />
      ) : (
        <>
          <Bar projectPath={projectPath} diff={tab} sessionId={sessionId} />
          <div className="kp-doc__body">
            <Body result={result} error={error} />
          </div>
        </>
      )}
    </div>
  )
}

/**
 * The diff's context bar: its path, the commit and line counts, the change steps, Huli's Review
 * changes for the session whose side panel shows it, and Open file.
 */
function Bar({
  projectPath,
  diff,
  counts,
  hunks = 0,
  scroller,
  sessionId,
}: {
  projectPath: string
  diff: DiffTarget
  counts?: ReactNode
  hunks?: number
  scroller?: RefObject<HTMLDivElement | null>
  sessionId: string | null
}) {
  const { t } = useTranslation('files')
  // Where the last step went, among the runs of changed lines the diff draws.
  const [at, setAt] = useState<{ current: number; total: number } | null>(null)
  const step = (direction: 1 | -1): void => {
    if (scroller) setAt(stepChange(scroller, direction))
  }
  return (
    <PaneContext
      tools={
        <>
          {scroller && hunks > 0 && (
            <span className="kp-doc__hunks">
              <span className="px-1.5 tabular">
                {at ? t('diff.position', at) : t('diff.hunks', { count: hunks })}
              </span>
              <PanelButton label={t('diff.previous')} onClick={() => step(-1)}>
                <PaneIcon icon={ArrowUp01Icon} />
              </PanelButton>
              <PanelButton label={t('diff.next')} onClick={() => step(1)}>
                <PaneIcon icon={ArrowDown01Icon} />
              </PanelButton>
            </span>
          )}
          {sessionId && diff.ref === null && <PaneReviewButton sessionId={sessionId} />}
          <PanelButton
            label={t('diff.openFile')}
            disabled={diff.projectFile === null}
            onClick={() =>
              diff.projectFile !== null && openFile(projectPath, diff.projectFile, null, FROM_PANEL)
            }
          >
            <PaneIcon icon={File01Icon} />
          </PanelButton>
        </>
      }
    >
      <PathCopy
        path={diff.path}
        shown={diff.oldPath ? `${diff.oldPath} → ${diff.path}` : diff.path}
      />
      {diff.ref && <span className="kp-doc__ref">{diff.ref.slice(0, 7)}</span>}
      {counts}
    </PaneContext>
  )
}

function Body({ result, error }: DiffView) {
  const { t } = useTranslation('files')
  if (error && !result) return <Notice title={t('diff.failed')} description={error} />
  if (!result) return <Lines />
  if (result.binary) {
    return <Notice title={t('preview.binaryTitle')} description={t('diff.binaryDescription')} />
  }
  if (result.tooLarge) {
    return <Notice title={t('diff.tooLargeTitle')} description={t('diff.tooLargeDescription')} />
  }
  return <Notice title={t('diff.sameTitle')} description={t('diff.sameDescription')} />
}

function Changes({
  projectPath,
  diff,
  result,
  sessionId,
}: {
  projectPath: string
  diff: DiffTarget
  result: FileDiff
  sessionId: string | null
}) {
  const { t } = useTranslation(['files', 'composer'])
  const scroller = useRef<HTMLDivElement>(null)
  const fileDiff = useParsedDiff(result.path, result.oldText, result.newText ?? '')
  const [selected, setSelected] = useState<SelectedLineRange | null>(null)
  const [miss, setMiss] = useState<MentionMiss | null>(null)
  const [editing, setEditing] = useState<NoteEditing | null>(null)
  const [renders] = useState(() => new RenderCount())
  const onSelect = useCallback((range: SelectedLineRange | null) => {
    setSelected(range)
    setMiss(null)
  }, [])
  const onComment = useCallback((range: SelectedLineRange) => {
    setSelected(range)
    setEditing({ kind: 'new', range })
  }, [])
  const onEditing = useCallback((next: NoteEditing | null) => {
    setEditing(next)
    if (next === null) setSelected(null)
  }, [])
  // Comments name the file as the session's agent finds it, from the folder the pane shows.
  const notePath = diff.projectFile ?? diff.path
  const notePlace = useMemo(() => ({ path: notePath, ref: diff.ref }), [notePath, diff.ref])
  // Huli: the session's review's findings on this file, on their lines and above the diff.
  const findings = useDiffFindings(sessionId, notePath, result.newText ?? '', fileDiff)
  const review = useReview(sessionId)
  // Lines of a commit are not the file as it is now, so only the working tree's are mentioned.
  const mentionable = diff.ref === null && diff.projectFile !== null
  const lines = mentionable ? selectedLines(selected) : null

  const mention = (): void => {
    if (!lines || diff.projectFile === null) return
    const missed = mentionLines(projectPath, diff.projectFile, lines)
    setMiss(missed)
    if (!missed) setSelected(null)
  }

  return (
    <>
      <Bar
        projectPath={projectPath}
        diff={diff}
        hunks={fileDiff.hunks.length}
        scroller={scroller}
        counts={
          <LineCounts
            insertions={fileDiff.hunks.reduce((sum, hunk) => sum + hunk.additionLines, 0)}
            deletions={fileDiff.hunks.reduce((sum, hunk) => sum + hunk.deletionLines, 0)}
            className="ml-1"
          />
        }
        sessionId={sessionId}
      />
      {sessionId && (
        <FindingsStrip sessionId={sessionId} projectPath={projectPath} path={notePath} />
      )}
      <div
        className="kp-doc__body flex flex-col"
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || event.nativeEvent.isComposing || !selected || editing) {
            return
          }
          // Handled here, so the session does not also take Esc as a request to stop.
          event.preventDefault()
          setSelected(null)
        }}
      >
        {/* Focusable, so a click on a line focuses it and Esc reaches the handler above. Laid out
            on its own: a change elsewhere in the window, such as the composer growing, would
            otherwise lay out the diff's thousands of rows again. */}
        <div
          ref={scroller}
          tabIndex={-1}
          data-selectable=""
          className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain pb-9 outline-none [contain:layout_size]"
        >
          {sessionId && (
            <FindingsAbove sessionId={sessionId} review={review} spots={findings.above} />
          )}
          {findings.provide(
            <FilesDiff
              fileDiff={fileDiff}
              selected={selected}
              onSelect={onSelect}
              onRendered={renders.bump}
              {...(findings.annotations && findings.renderAnnotation
                ? { annotations: findings.annotations, renderAnnotation: findings.renderAnnotation }
                : {})}
            />,
          )}
          {sessionId && (
            <>
              <FindingFocus
                sessionId={sessionId}
                review={review}
                spots={findings.spots}
                scroller={scroller}
                renders={renders}
              />
              <FindingDetailLayer
                sessionId={sessionId}
                review={review}
                spots={findings.spots}
                scroller={scroller}
                renders={renders}
              />
            </>
          )}
          {sessionId && (
            <NotesLayer
              scroller={scroller}
              fileDiff={fileDiff}
              sessionId={sessionId}
              place={notePlace}
              selected={selected}
              editing={editing}
              onEditing={onEditing}
              renders={renders}
              onComment={onComment}
            />
          )}
        </div>
        {editing ? null : miss ? (
          <span className="kp-doc__hint" data-tone="error">
            {miss === 'full' ? t('composer:attachments.limit') : t('diff.noComposer')}
          </span>
        ) : selected && sessionId ? (
          <span className="kp-lines-row">
            {lines && (
              <button type="button" className="kp-lines" onClick={mention}>
                <PaneIcon icon={AtIcon} size={13} />
                {lines[0] === lines[1]
                  ? t('diff.mentionLine', { line: lines[0] })
                  : t('diff.mentionLines', { start: lines[0], end: lines[1] })}
              </button>
            )}
            <button
              type="button"
              className="kp-lines"
              title={t('notes.commentTitle')}
              onClick={() => setEditing({ kind: 'new', range: selected })}
            >
              <PaneIcon icon={BubbleChatIcon} size={13} />
              {t('notes.comment')}
            </button>
          </span>
        ) : lines ? (
          <button type="button" className="kp-lines" onClick={mention}>
            <PaneIcon icon={AtIcon} size={13} />
            {lines[0] === lines[1]
              ? t('diff.mentionLine', { line: lines[0] })
              : t('diff.mentionLines', { start: lines[0], end: lines[1] })}
          </button>
        ) : sessionId ? (
          <NotesFoot
            sessionId={sessionId}
            hint={mentionable ? t('notes.hint') : t('diff.atCommit')}
          />
        ) : (
          <span className="kp-doc__hint">
            {mentionable ? t('diff.selectHint') : t('diff.atCommit')}
          </span>
        )}
      </div>
    </>
  )
}

/** Under the diff: the session's comments waiting to go, or the hint while there are none. */
function NotesFoot({ sessionId, hint }: { sessionId: string; hint: string }) {
  const count = useNoteCount(sessionId)
  if (count === 0) return <span className="kp-doc__hint">{hint}</span>
  return (
    <div className="kp-notes-foot">
      <NotesTray sessionId={sessionId} place="pane" />
    </div>
  )
}
