// Huli: each kind's part of the recycle bin, over the stores that mark what they delete. A
// session goes and comes back with what it went in with: its sub-sessions, or the project, task or
// routine that took it. See recycle-bin.ts and tools/huli/README.md (Recycle bin).

import {
  binKey,
  parseBinKey,
  type BinProjectChoice,
  type BinRestoreResult,
} from '@shared/recycle-bin'
import type { BinProjectState } from '@shared/recycle-bin'
import type { ArtifactStore } from './artifacts/store'
import type { MemoryService } from './memory/service'
import type { Projects } from './projects'
import type { BinSource, SourceItem } from './recycle-bin'
import type { RoutinesManager } from './routines/manager'
import type { ScratchFolders } from './scratch'
import type { SessionFolders } from './session-folders'
import type { SessionManager } from './sessions'
import type { SessionRecord } from './storage'
import type { TaskEngine } from './workflow/engine'
import type { WorkflowLibrary } from './workflow/library'

export interface BinSourcesDeps {
  sessions: SessionManager
  projects: Projects
  scratch: ScratchFolders
  folders: SessionFolders
  tasks: TaskEngine
  routines: RoutinesManager
  library: WorkflowLibrary
  memory: MemoryService
  artifacts: ArtifactStore
  /** A routine went for good: its webhook's secret goes too. */
  routinePurged(routineId: string): void
}

const done = (): BinRestoreResult => ({ restored: [], held: [] })

/** Whether the bin item a session went in with is still in the bin, by its key. */
export function groupBinned(
  deps: Pick<BinSourcesDeps, 'projects' | 'tasks' | 'routines'>,
  group: string,
): boolean {
  const parsed = parseBinKey(group)
  if (!parsed) return false
  switch (parsed.kind) {
    case 'project':
      return deps.projects.binnedRecord(parsed.id) !== undefined
    case 'task':
      return deps.tasks.binnedTasks().some((task) => task.id === parsed.id)
    case 'routine':
      return deps.routines.binnedRoutines().some((routine) => routine.id === parsed.id)
    default:
      return false
  }
}

/** The bytes the stored threads of these sessions keep, all told. */
async function threadBytes(
  sessions: SessionManager,
  records: readonly SessionRecord[],
): Promise<number | null> {
  if (records.length === 0) return null
  const sizes = await sessions.binnedSizes(records.map((record) => record.id))
  const total = Object.values(sizes).reduce((sum, size) => sum + size, 0)
  return total > 0 ? total : null
}

/** What a group took along: its top-level sessions, which the page counts. */
function topLevel(records: readonly SessionRecord[]): number {
  const ids = new Set(records.map((record) => record.id))
  return records.filter(
    (record) =>
      record.origin !== 'subagent' && (record.parentId === null || !ids.has(record.parentId)),
  ).length
}

export function binSources(deps: BinSourcesDeps): BinSource[] {
  const { sessions, projects } = deps

  const projectState = (record: SessionRecord): BinProjectState => {
    if (record.noProject || deps.scratch.contains(record.projectPath)) return 'none'
    if (projects.find(record.projectPath)) return 'listed'
    return projects.binnedRecord(record.projectPath) ? 'binned' : 'gone'
  }

  /** A binned project back with the sessions its removal took. */
  const restoreProject = async (path: string): Promise<boolean> => {
    const record = projects.binnedRecord(path)
    if (!record) return false
    const group = binKey('project', record.path)
    projects.restore(record.path)
    await sessions.unbin(sessions.binnedWith(group))
    return true
  }

  const withGroup = (kind: 'task' | 'routine', id: string) => sessions.binnedWith(binKey(kind, id))

  const session: BinSource = {
    kind: 'session',
    async items() {
      return sessions.binnedItems().map(({ record, members, title }): SourceItem => {
        const state = projectState(record)
        return {
          id: record.id,
          title,
          deletedAt: record.deletedAt ?? 0,
          projectPath: state === 'none' ? null : record.projectPath,
          agentId: record.agentId,
          count: topLevel(members),
          project: state,
        }
      })
    },
    async sizes(items) {
      const out: Record<string, number> = {}
      for (const item of items) {
        const bytes = await threadBytes(sessions, sessions.binGroup(item.id))
        if (bytes !== null) out[item.id] = bytes
      }
      return out
    },
    async restore(ids, choice: BinProjectChoice | undefined) {
      const result = done()
      for (const id of ids) {
        const group = sessions.binGroup(id)
        const root = group[0]
        if (!root) continue
        const state = projectState(root)
        if (state === 'binned' || state === 'gone') {
          if (choice === undefined) {
            result.held.push({
              key: binKey('session', id),
              projectPath: root.projectPath,
              project: state,
            })
            continue
          }
          if (choice === 'restore') {
            if (state === 'binned') {
              if (await restoreProject(root.projectPath))
                result.restored.push(binKey('project', root.projectPath))
            } else {
              await projects.add(root.projectPath)
            }
          }
          await sessions.unbin(group, { noProject: choice === 'noProject' })
        } else {
          await sessions.unbin(group)
        }
        result.restored.push(binKey('session', id))
      }
      return result
    },
    async purge(ids) {
      for (const id of ids) await sessions.purgeBinned(sessions.binGroup(id))
    },
  }

  const project: BinSource = {
    kind: 'project',
    async items() {
      return projects.binnedRecords().map((record) => ({
        id: record.path,
        title: record.name,
        deletedAt: record.deletedAt ?? 0,
        projectPath: record.path,
        count: topLevel(sessions.binnedWith(binKey('project', record.path))),
      }))
    },
    async sizes(items) {
      const out: Record<string, number> = {}
      for (const item of items) {
        const bytes = await threadBytes(sessions, sessions.binnedWith(binKey('project', item.id)))
        if (bytes !== null) out[item.id] = bytes
      }
      return out
    },
    async restore(ids) {
      const result = done()
      for (const id of ids) {
        if (await restoreProject(id)) result.restored.push(binKey('project', id))
      }
      return result
    },
    async purge(ids) {
      for (const id of ids) {
        await sessions.purgeBinned(sessions.binnedWith(binKey('project', id)))
      }
      projects.purge(ids)
    },
  }

  const folder: BinSource = {
    kind: 'folder',
    async items() {
      return deps.folders.binned().map(({ folder: item, count }) => ({
        id: item.id,
        title: item.name,
        deletedAt: item.deletedAt ?? 0,
        count,
      }))
    },
    async restore(ids) {
      const result = done()
      for (const id of ids) if (deps.folders.restore(id)) result.restored.push(binKey('folder', id))
      return result
    },
    async purge(ids) {
      deps.folders.purge(ids)
    },
  }

  const task: BinSource = {
    kind: 'task',
    async items() {
      return deps.tasks.binnedTasks().map((item) => ({
        id: item.id,
        title: item.title,
        deletedAt: item.deletedAt ?? 0,
        projectPath: item.projectPath,
        count: topLevel(withGroup('task', item.id)),
      }))
    },
    async sizes(items) {
      const out: Record<string, number> = {}
      for (const item of items) {
        const bytes = await threadBytes(sessions, withGroup('task', item.id))
        if (bytes !== null) out[item.id] = bytes
      }
      return out
    },
    async restore(ids) {
      const result = done()
      for (const id of ids) {
        if (!(await deps.tasks.restore(id))) continue
        await sessions.unbin(withGroup('task', id))
        result.restored.push(binKey('task', id))
      }
      return result
    },
    async purge(ids) {
      for (const id of ids) await sessions.purgeBinned(withGroup('task', id))
      await deps.tasks.purge(ids)
    },
  }

  const routine: BinSource = {
    kind: 'routine',
    async items() {
      return deps.routines.binnedRoutines().map((item) => ({
        id: item.id,
        title: item.name,
        deletedAt: item.deletedAt ?? 0,
        projectPath: item.projectPath,
        count: topLevel(withGroup('routine', item.id)),
      }))
    },
    async sizes(items) {
      const out: Record<string, number> = {}
      for (const item of items) {
        const bytes = await threadBytes(sessions, withGroup('routine', item.id))
        if (bytes !== null) out[item.id] = bytes
      }
      return out
    },
    async restore(ids) {
      const result = done()
      for (const id of ids) {
        if (!(await deps.routines.restore(id))) continue
        await sessions.unbin(withGroup('routine', id))
        result.restored.push(binKey('routine', id))
      }
      return result
    },
    async purge(ids) {
      for (const id of ids) await sessions.purgeBinned(withGroup('routine', id))
      await deps.routines.purge(ids)
      for (const id of ids) deps.routinePurged(id)
    },
  }

  const workflow: BinSource = {
    kind: 'workflow',
    async items() {
      return (await deps.library.binned()).map((item) => ({
        id: item.id,
        title: item.name,
        deletedAt: item.deletedAt,
        size: item.size,
      }))
    },
    async restore(ids) {
      const result = done()
      for (const id of ids)
        if (deps.library.restore(id)) result.restored.push(binKey('workflow', id))
      return result
    },
    async purge(ids) {
      await deps.library.purge(ids)
    },
  }

  const memory: BinSource = {
    kind: 'memory',
    async items() {
      return (await deps.memory.binned()).map((item) => ({
        id: item.binId,
        title: item.title,
        deletedAt: item.deletedAt,
        size: item.size,
        projectPath: item.project,
        scope: item.project === null ? 'global' : 'project',
      }))
    },
    async restore(ids) {
      const result = done()
      for (const id of ids) {
        if (await deps.memory.restoreBinned(id)) result.restored.push(binKey('memory', id))
      }
      return result
    },
    async purge(ids) {
      await deps.memory.purgeBinned(ids)
    },
  }

  const artifact: BinSource = {
    kind: 'artifact',
    async items() {
      return (await deps.artifacts.list({ deleted: true })).map((item) => ({
        id: item.id,
        title: item.title,
        deletedAt: item.deletedAt ?? 0,
        size: item.size,
        projectPath: item.project,
      }))
    },
    async restore(ids) {
      const result = done()
      for (const id of ids) {
        await deps.artifacts.undelete(id)
        result.restored.push(binKey('artifact', id))
      }
      return result
    },
    async purge(ids) {
      for (const id of ids) await deps.artifacts.erase(id)
    },
  }

  return [session, project, folder, task, routine, workflow, memory, artifact]
}
