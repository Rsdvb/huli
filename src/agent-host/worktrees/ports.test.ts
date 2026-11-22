import net from 'node:net'
import { describe, expect, it } from 'vitest'
import { overlaps, pickPortBlock, portFree } from './ports'

const free = async () => true

describe('picking a block of ports', () => {
  it('takes the first block from the base, then steps past the held ones', async () => {
    expect(await pickPortBlock(20_000, [], free)).toEqual({ first: 20_000, count: 10 })
    expect(
      await pickPortBlock(
        20_000,
        [
          { first: 20_000, count: 10 },
          { first: 20_010, count: 10 },
        ],
        free,
      ),
    ).toEqual({ first: 20_020, count: 10 })
  })

  it('never overlaps a held block, even one off the step', async () => {
    const held = [{ first: 20_005, count: 10 }]
    const block = await pickPortBlock(20_000, held, free)
    expect(block).toEqual({ first: 20_020, count: 10 })
    expect(overlaps(block!, held[0]!)).toBe(false)
  })

  it('skips a block any of whose ports something listens on', async () => {
    const busy = new Set([20_003, 20_017])
    expect(await pickPortBlock(20_000, [], async (port) => !busy.has(port))).toEqual({
      first: 20_020,
      count: 10,
    })
  })

  it('takes a block back once the session that held it lets it go', async () => {
    const first = await pickPortBlock(20_000, [], free)
    const second = await pickPortBlock(20_000, [first!], free)
    expect(second).toEqual({ first: 20_010, count: 10 })
    expect(await pickPortBlock(20_000, [second!], free)).toEqual(first)
  })

  it('gives up below 65536 and after trying a bounded number of blocks', async () => {
    expect(await pickPortBlock(65_526, [{ first: 65_526, count: 10 }], free)).toBeNull()
    let asked = 0
    const none = await pickPortBlock(20_000, [], async () => {
      asked++
      return false
    })
    expect(none).toBeNull()
    expect(asked).toBeLessThanOrEqual(64 * 10)
  })
})

describe('whether a port is free', () => {
  it('finds a port taken while something listens on it, and free once it stops', async () => {
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as net.AddressInfo
    expect(await portFree(port)).toBe(false)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    expect(await portFree(port)).toBe(true)
  })
})
