// Huli: the agent host's own priority, which the programs it starts inherit on every system:
// agents, their MCP servers and commands, mihomo. Below normal, a build or a test run gives way to
// what the user does and runs as fast as ever on an otherwise idle computer. Main, the window and
// the terminal host keep theirs, so Kite and the user's own shells stay responsive.

import os from 'node:os'

export interface PriorityCalls {
  getPriority(): number
  setPriority(priority: number): void
}

const NODE_CALLS: PriorityCalls = {
  getPriority: () => os.getPriority(),
  setPriority: (priority) => os.setPriority(priority),
}

export const LOWER_PRIORITY = os.constants.priority.PRIORITY_BELOW_NORMAL

/** What a change did: null when it had nothing to do. */
export type PriorityOutcome =
  | { kind: 'lowered'; from: number }
  | { kind: 'restored'; to: number }
  // macOS and Linux let only a privileged process raise its priority again; a restart of Kite
  // starts the host at its parent's.
  | { kind: 'kept-low'; error: unknown }
  | { kind: 'failed'; error: unknown }

/**
 * Keeps the process below normal while the setting is on, and back at the priority it had once it
 * is off. A process that started that low or lower already, as under `nice`, is left alone.
 * Programs already running keep the priority they started with.
 */
export function processPriority(
  calls: PriorityCalls = NODE_CALLS,
): (lower: boolean | undefined) => PriorityOutcome | null {
  // The priority before this lowered it; null while it has not.
  let before: number | null = null
  return (lower) => {
    if (lower === undefined) return null
    try {
      if (lower && before === null) {
        const now = calls.getPriority()
        // Niceness and Node's priorities grow as the priority falls.
        if (now >= LOWER_PRIORITY) return null
        calls.setPriority(LOWER_PRIORITY)
        before = now
        return { kind: 'lowered', from: now }
      }
      if (!lower && before !== null) {
        const to = before
        try {
          calls.setPriority(to)
        } catch (error) {
          return { kind: 'kept-low', error }
        }
        before = null
        return { kind: 'restored', to }
      }
    } catch (error) {
      return { kind: 'failed', error }
    }
    return null
  }
}
