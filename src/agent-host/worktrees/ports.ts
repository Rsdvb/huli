// Huli: picking the block of ports a new worktree session holds (see @shared/worktree-ports): the
// first block from the base, on a step of the block's size, that no live session holds and none
// of whose ports something on this computer listens on already.

import net from 'node:net'
import { lastPort, PORT_BLOCK_SIZE, type PortBlock } from '@shared/worktree-ports'

/** How many blocks past the held ones a pick tries for free ports before it gives up. */
const MAX_TRIES = 64

export function overlaps(a: PortBlock, b: PortBlock): boolean {
  return a.first <= lastPort(b) && b.first <= lastPort(a)
}

/**
 * The first block of `size` ports at `base`, `base + size`, ... that overlaps no held block and
 * whose every port `free` finds free; null when none is within reach below 65536.
 */
export async function pickPortBlock(
  base: number,
  held: readonly PortBlock[],
  free: (port: number) => Promise<boolean>,
  size = PORT_BLOCK_SIZE,
): Promise<PortBlock | null> {
  let tried = 0
  for (let first = base; first + size - 1 <= 65_535 && tried < MAX_TRIES; first += size) {
    const block = { first, count: size }
    if (held.some((other) => overlaps(block, other))) continue
    tried++
    const checks = await Promise.all(
      Array.from({ length: size }, (_, index) => free(first + index)),
    )
    if (checks.every(Boolean)) return block
  }
  return null
}

/**
 * Whether nothing listens on the port: it can be bound on the loopback address and on every
 * address. A port the system keeps from programs, as Windows does for Hyper-V, counts as taken.
 */
export async function portFree(port: number): Promise<boolean> {
  return (await bindable(port, '127.0.0.1')) && (await bindable(port, undefined))
}

function bindable(port: number, host: string | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)))
  })
}
