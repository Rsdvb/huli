// Huli: the ports a worktree session holds, after Conductor's $CONDUCTOR_PORT. Each session Kite
// makes a worktree for gets a block of ports no other live session holds, so dev servers of
// parallel worktrees never collide; its setup command and its agent see it as KITE_PORT (the
// first) and KITE_PORT_COUNT.

/** A run of `count` ports from `first`. */
export interface PortBlock {
  first: number
  count: number
}

/** How many ports each block holds. */
export const PORT_BLOCK_SIZE = 10

/** Where blocks start unless Settings › Git says otherwise: under every system's ephemeral range. */
export const DEFAULT_PORT_BASE = 20_000
export const PORT_BASE_MIN = 1024
export const PORT_BASE_MAX = 65_535 - PORT_BLOCK_SIZE + 1

/** The names the setup command and the agent see the block by. */
export const PORT_ENV = { first: 'KITE_PORT', count: 'KITE_PORT_COUNT' } as const

export function lastPort(block: PortBlock): number {
  return block.first + block.count - 1
}

export function portEnv(block: PortBlock): Record<string, string> {
  return { [PORT_ENV.first]: String(block.first), [PORT_ENV.count]: String(block.count) }
}

export function isPortBase(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= PORT_BASE_MIN &&
    value <= PORT_BASE_MAX
  )
}
