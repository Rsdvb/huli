import { describe, expect, it } from 'vitest'
import { canOrder, MAX_ORDERED_ROWS, rankBy, storedOrder, withRowsMoved } from './session-order'

interface Row {
  id: string
  runs?: string[]
  updatedAt: number
}

const byActivity = (row: Row) => -row.updatedAt
const ids = (row: Row) => [row.id, ...(row.runs ?? [])]
const sorted = (rows: Row[], order: string[] | null | undefined) => {
  const rank = rankBy(order, ids, byActivity)
  return [...rows].sort((a, b) => rank(a) - rank(b)).map((row) => row.id)
}

const rows: Row[] = [
  { id: 'a', updatedAt: 10 },
  { id: 'b', updatedAt: 30 },
  { id: 'c', updatedAt: 20 },
  { id: 'g', runs: ['r1', 'r2'], updatedAt: 5 },
]

describe('session order', () => {
  it('lists by latest activity without an order, as an older host or a group never dragged', () => {
    expect(sorted(rows, undefined)).toEqual(['b', 'c', 'a', 'g'])
    expect(sorted(rows, null)).toEqual(['b', 'c', 'a', 'g'])
    expect(canOrder(undefined)).toBe(false)
    expect(canOrder(null)).toBe(true)
    expect(canOrder([])).toBe(true)
  })

  it("keeps the user's order, rows it does not name first by activity", () => {
    expect(sorted(rows, ['a', 'g', 'b', 'c'])).toEqual(['a', 'g', 'b', 'c'])
    // Two new rows, the latest first, then the ordered ones; an id gone from the group is skipped.
    expect(sorted(rows, ['gone', 'a', 'g'])).toEqual(['b', 'c', 'a', 'g'])
    // A best-of-N group stored as its runs' rows takes the place of its first run.
    expect(sorted(rows, ['c', 'r2', 'a', 'b'])).toEqual(['c', 'g', 'a', 'b'])
  })

  it('moves rows together in their order, before or after a neighbour', () => {
    const list = ['a', 'b', 'c', 'd', 'e']
    expect(withRowsMoved(list, ['d'], { before: 'b' })).toEqual(['a', 'd', 'b', 'c', 'e'])
    expect(withRowsMoved(list, ['e', 'b'], { before: 'a' })).toEqual(['b', 'e', 'a', 'c', 'd'])
    expect(withRowsMoved(list, ['a'], { after: 'c' })).toEqual(['b', 'c', 'a', 'd', 'e'])
    expect(withRowsMoved(list, ['c'], { before: null })).toEqual(['c', 'a', 'b', 'd', 'e'])
    expect(withRowsMoved(list, ['a'], { before: 'a' })).toEqual(['b', 'c', 'd', 'e', 'a'])
    expect(withRowsMoved(list, ['a'], { after: 'nope' })).toEqual(['b', 'c', 'd', 'e', 'a'])
  })

  it('reads a stored order leniently', () => {
    expect(storedOrder(['a', 'a', '', 3, 'b'])).toEqual(['a', 'b'])
    expect(storedOrder('a')).toBeUndefined()
    expect(storedOrder(null)).toBeUndefined()
    const long = Array.from({ length: MAX_ORDERED_ROWS + 1 }, (_, i) => `s${i}`)
    expect(storedOrder(long)).toHaveLength(MAX_ORDERED_ROWS)
  })
})
