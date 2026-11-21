import type { ReactElement } from 'react'
import {
  CodeIcon,
  Copy01Icon,
  FolderOpenIcon,
  Link01Icon,
  SidebarRightIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@renderer/components/ui/context-menu'
import { toast } from '@renderer/components/ui/toast'
import { errorMessage } from '@renderer/lib/host'
import { hostOfPath, hostPath } from '@renderer/lib/host-paths'
import { i18n } from '@renderer/lib/i18n'
import { fileManagerName, isWeb } from '@renderer/lib/platform'
import { openFile } from '@renderer/stores/files'
import { FileTypeIcon } from './file-type-icon'
import type { AgentFileRef, FileRef } from './file-refs'
import { openInEditor } from './open-in-editor'
import { copyPaths, hostFilePath } from './operations'
import { nameOf } from './paths'

/** The path as this computer's file manager and editors take it: Windows wants backslashes. */
function nativePath(path: string): string {
  return /^[a-z]:\//i.test(path) ? path.replaceAll('/', '\\') : path
}

function outside(open: (path: string) => Promise<void>, path: string) {
  open(nativePath(path)).catch((failure: unknown) => toast(errorMessage(failure)))
}

function copyText(text: string) {
  void navigator.clipboard.writeText(text).then(
    () => toast(i18n.t('files:tree.copiedPath', { count: 1 })),
    (failure: unknown) => toast(errorMessage(failure)),
  )
}

/**
 * A file's menu, for its links and the lists of changed files: the Files pane, the editor and the
 * file manager, and its paths. The editor and the file manager open files of this computer only,
 * and not a file that is `gone`, as a deleted one.
 */
export function FileLinkMenu({
  trigger,
  projectPath,
  absolute,
  relative,
  onOpen,
  gone = false,
}: {
  trigger: ReactElement
  projectPath: string
  /** The path as its host writes it. */
  absolute: string
  /** Relative to the project; null for a file outside it. */
  relative: string | null
  /** Opens it in the Files pane; without it the menu has no such item. */
  onOpen?: () => void
  gone?: boolean
}) {
  const { t } = useTranslation('files')
  const local = !isWeb && hostOfPath(projectPath) === null && !gone
  return (
    <ContextMenu>
      <ContextMenuTrigger render={trigger} />
      <ContextMenuContent className="min-w-56">
        {onOpen && (
          <ContextMenuItem onClick={onOpen}>
            <HugeiconsIcon icon={SidebarRightIcon} strokeWidth={1.9} aria-hidden />
            {t('link.openInPanel')}
          </ContextMenuItem>
        )}
        {local && (
          <ContextMenuItem onClick={() => outside(openInEditor, absolute)}>
            <HugeiconsIcon icon={CodeIcon} strokeWidth={1.9} aria-hidden />
            {t('panel.openInEditor')}
          </ContextMenuItem>
        )}
        {local && (
          <ContextMenuItem onClick={() => outside(window.kettu.shell.showItem, absolute)}>
            <HugeiconsIcon icon={FolderOpenIcon} strokeWidth={1.9} aria-hidden />
            {t('preview.showIn', { name: fileManagerName() })}
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() =>
            relative === null ? copyText(absolute) : copyPaths(projectPath, [relative], false)
          }
        >
          <HugeiconsIcon icon={Copy01Icon} strokeWidth={1.9} aria-hidden />
          {t('tree.copyPath')}
        </ContextMenuItem>
        {relative !== null && (
          <ContextMenuItem onClick={() => copyPaths(projectPath, [relative], true)}>
            <HugeiconsIcon icon={Link01Icon} strokeWidth={1.9} aria-hidden />
            {t('tree.copyRelativePath')}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

function LinkBody({ path, line }: { path: string; line: number | null }) {
  // A button lays out as an inline block, so the line is drawn by an inline span inside it, at
  // the same depth as a link's.
  return (
    <span className="thread-link">
      <FileTypeIcon
        path={path}
        className="relative -top-[1.5px] mr-1.5 inline-block size-4 align-middle"
      />
      {nameOf(path)}
      {line && <span className="text-tertiary">:{line}</span>}
    </span>
  )
}

/**
 * A file reference in a reply, drawn like the thread's links: the file's icon and name over one
 * line, with the path in its tooltip. It opens the file in the Files pane at its line; its menu
 * also shows it in the editor or the file manager and copies its path.
 */
export function FileLink({ file }: { file: FileRef & { projectPath: string } }) {
  const { t } = useTranslation('files')
  const target = file.line ? `${file.path}:${file.line}` : file.path
  const open = () => openFile(file.projectPath, file.path, file.line)
  return (
    <FileLinkMenu
      projectPath={file.projectPath}
      absolute={hostFilePath(file.projectPath, file.path)}
      relative={file.path}
      onOpen={open}
      trigger={
        <button
          type="button"
          data-file-ref=""
          title={target}
          aria-label={t('link.open', { target })}
          onClick={open}
        >
          <LinkBody path={file.path} line={file.line} />
        </button>
      }
    />
  )
}

/** A link to a file of the session agent's own folder, drawn the same; it opens read-only. */
export function AgentFileLink({ file }: { file: AgentFileRef }) {
  const { t } = useTranslation('files')
  const target = file.line ? `${file.path}:${file.line}` : file.path
  const open = () =>
    openFile(file.projectPath, file.path, file.line, {
      agent: { sessionId: file.sessionId, agentId: file.agentId },
    })
  return (
    <FileLinkMenu
      projectPath={file.projectPath}
      absolute={hostPath(file.path)}
      relative={null}
      onOpen={open}
      trigger={
        <button
          type="button"
          data-file-ref=""
          title={target}
          aria-label={t('link.open', { target })}
          onClick={open}
        >
          <LinkBody path={file.path} line={file.line} />
        </button>
      }
    />
  )
}
