// Huli: the user's own order of a sidebar group's rows (a project's, No project's or a session
// folder's), kept by the agent host so every window and paired phone lists them alike. A group
// without one lists its rows by latest activity; once the user drags a row, the host keeps the
// group's row ids in the order shown, and a row it does not name, such as a new session, comes
// first. Huli's own; see tools/huli/README.md (Session order).

/** The most row ids one group's order keeps. */
export const MAX_ORDERED_ROWS = 10_000

/** The longest row id an order keeps. */
export const ORDER_ID_CHARS = 256

/** Whether a value is a row id an order keeps: a session's, a task's or a best-of-N group's. */
export function isOrderId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= ORDER_ID_CHARS
}

/**
 * A stored order as it reads: its ids, each once, at most `MAX_ORDERED_ROWS`; undefined for a
 * value that is no list, so the group goes by activity.
 */
export function storedOrder(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return [...new Set(value.filter(isOrderId))].slice(0, MAX_ORDERED_ROWS)
}

/**
 * Whether a host keeps a group's order, from the group's `sessionOrder`: null while it goes by
 * activity, a list once ordered, absent from a host older than orders, which leaves dragging off.
 */
export function canOrder(order: readonly string[] | null | undefined): boolean {
  return order !== undefined
}

// Below every place an order can give, so rows it does not name come first.
const UNNAMED = -1e15

/**
 * A sort key for a group's rows, lower first: with an order, the rows it names in its order after
 * the ones it does not, which keep `activity` among themselves; without, `activity` alone. A row
 * may answer to several ids (a best-of-N group to its runs'); its first place counts.
 */
export function rankBy<T>(
  order: readonly string[] | null | undefined,
  ids: (row: T) => readonly string[],
  activity: (row: T) => number,
): (row: T) => number {
  if (!order) return activity
  const at = new Map(order.map((id, index) => [id, index]))
  return (row) => {
    let best = Infinity
    for (const id of ids(row)) {
      const index = at.get(id)
      if (index !== undefined && index < best) best = index
    }
    return best === Infinity ? UNNAMED + activity(row) : best
  }
}

/**
 * `rows` with `moving` taken out and put back together, in their order in `rows`, just before
 * `before`, or just after `after`, or first when both are null. A neighbour that is itself moving
 * or not in `rows` puts them last.
 */
export function withRowsMoved(
  rows: readonly string[],
  moving: readonly string[],
  place: { before: string | null } | { after: string },
): string[] {
  const taking = new Set(moving)
  const moved = rows.filter((id) => taking.has(id))
  const rest = rows.filter((id) => !taking.has(id))
  let at: number
  if ('after' in place) {
    const index = rest.indexOf(place.after)
    at = index < 0 ? rest.length : index + 1
  } else if (place.before === null) {
    at = 0
  } else {
    const index = rest.indexOf(place.before)
    at = index < 0 ? rest.length : index
  }
  rest.splice(at, 0, ...moved)
  return rest
}
