import { focusedPane } from '@renderer/features/split/layout'
import { setGitPaneTab, type GitPaneTab } from '@renderer/stores/git'
import { useGitStore } from '@renderer/stores/git'
import { useProjectsStore } from '@renderer/stores/projects'
import {
  chooseGitRoot,
  openSingleTab,
  paneProjectPath,
  panelOf,
  toggleSidePane,
  useViewStore,
} from '@renderer/stores/view'

export interface OpenGitPane {
  tab: GitPaneTab
  /**
   * Opens the commit box too: its focus, the files it is for, or all of them with null, and
   * whether Mod+Enter commits and pushes.
   */
  commit?: { only: string[] | null; andPush: boolean }
  /** The side panel to open it in; the one in focus when it works in the project, by default. */
  panel?: string
}

/** Shows the Git pane on a page, in the session's side panel or, without one, the focused pane's. */
export function openGitPane(projectPath: string, request: OpenGitPane): void {
  const state = useViewStore.getState()
  const projects = useProjectsStore.getState().projects
  const view = focusedPane(state.layout).view
  const shown = paneProjectPath(view, state.projectPath, projects)
  // Huli: or on a further folder of the project it works in, as the Files pane shows one.
  const further = () =>
    projects.some(
      (p) =>
        (p.path === shown || p.path === view.projectPath) &&
        !!p.folders?.some((f) => f.path === projectPath),
    )
  const panel =
    request.panel ??
    (shown === projectPath || further() ? panelOf(view, state.projectPath, projects) : null)
  if (!panel) return
  if (request.commit) {
    useGitStore.setState((s) => ({ commitAsk: { ...s.commitAsk, [projectPath]: request.commit! } }))
  }
  // Huli: a further folder's branch link shows that repository; the pane falls back to the panel's
  // own folder for any other path.
  chooseGitRoot(panel, projectPath)
  setGitPaneTab(panel, request.tab)
  toggleSidePane(panel, 'git', true)
}

/** Opens or focuses the dedicated read-only Branch Graph tab in `panel`. */
export function openBranchGraph(panel: string): void {
  openSingleTab(panel, 'gitGraph', { fromPanel: true })
}
