// Huli: what the session board reads of a session's background processes while it shows them:
// each task's process, its CPU and memory and the ports it listens on, read when the board opens
// and when it asks again, never on a timer. A port outside the session's block (KITE_PORT) is
// marked, and so is a port of the block that something outside the session holds.

import type { BackgroundTaskView } from './thread'
import type { PortBlock } from './worktree-ports'

/** A port a task's processes listen on. */
export interface TaskPort {
  port: number
  /** Outside the port block the session holds; false for a session that holds none. */
  outside: boolean
  /** Inside the block of another live session, whose servers it may collide with. */
  collides: boolean
}

/** What was read of one task's processes. */
export interface TaskProcess {
  taskId: string
  /** The process the agent started for it; null when it could not be told. */
  pid: number | null
  /** CPU use of its processes, in percent of one core; null when unknown. */
  cpu: number | null
  /** Resident memory of its processes, in bytes; null when unknown. */
  memory: number | null
  ports: TaskPort[]
}

/** A port of the session's block that a program outside the session listens on. */
export interface TakenPort {
  port: number
  pid: number | null
  process: string | null
}

export interface SessionProcesses {
  /**
   * The agent's background tasks where no event lists them, as Codex's background terminals,
   * read with the rest; null where the session's own `background` lists them.
   */
  tasks: BackgroundTaskView[] | null
  processes: TaskProcess[]
  /** The block of ports the session holds; null without one. */
  block: PortBlock | null
  /** Ports of the block that something outside the session listens on. */
  taken: TakenPort[]
  /** What Clean does for its agent: forget the ended tasks, stop them all, or nothing. */
  clean: 'ended' | 'all' | null
  /** Why the agent's own list could not be read, as when its version has none. */
  error?: string
}

/** The most tasks one reading reports. */
export const MAX_TASK_PROCESSES = 100
