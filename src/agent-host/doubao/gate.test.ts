// When the account's gate lets Doubao CLI runs go: one turn at a time, and a read alone or beside a
// turn whose process already has the shared service, never one that would start the service a
// turn then uses.

import { describe, expect, it } from 'vitest'
import { DoubaoGate } from './gate'

const settled = async (promise: Promise<unknown>): Promise<boolean> => {
  let done = false
  void promise.then(() => (done = true))
  await new Promise((resolve) => setTimeout(resolve, 0))
  return done
}

describe('the Doubao gate', () => {
  it('runs one turn at a time, in order, and tells each how many go first', async () => {
    const gate = new DoubaoGate()
    const release = await gate.enter('turn')
    const told: number[][] = [[], []]
    const second = gate.enter('turn', { ahead: (n) => told[0]!.push(n) })
    const third = gate.enter('turn', { ahead: (n) => told[1]!.push(n) })
    expect(await settled(second)).toBe(false)
    expect(told).toEqual([[1], [2]])
    release()
    ;(await second)()
    expect(told).toEqual([[1], [2, 1]])
    expect(await settled(third)).toBe(true)
  })

  it('lets a read run beside a turn only once the turn is at work', async () => {
    const gate = new DoubaoGate()
    const releaseTurn = await gate.enter('turn')
    const read = gate.enter('read')
    expect(await settled(read)).toBe(false)
    gate.atWork()
    const releaseRead = await read
    // A second read waits for the first, which may hold the service the next turn would use.
    const next = gate.enter('read')
    expect(await settled(next)).toBe(false)
    releaseRead()
    ;(await next)()
    releaseTurn()
  })

  it('holds a turn while a read that started alone runs, and the read goes first in order', async () => {
    const gate = new DoubaoGate()
    const releaseRead = await gate.enter('read')
    const turn = gate.enter('turn')
    const read = gate.enter('read')
    expect(await settled(turn)).toBe(false)
    expect(await settled(read)).toBe(false)
    releaseRead()
    const releaseTurn = await turn
    expect(await settled(read)).toBe(false)
    releaseTurn()
    expect(await settled(read)).toBe(true)
  })

  it('lets a waiting turn go when it is stopped', async () => {
    const gate = new DoubaoGate()
    const release = await gate.enter('turn')
    const stop = new AbortController()
    const waiting = gate.enter('turn', { signal: stop.signal })
    stop.abort(new Error('stopped'))
    await expect(waiting).rejects.toThrow('stopped')
    release()
    ;(await gate.enter('turn'))()
  })
})
