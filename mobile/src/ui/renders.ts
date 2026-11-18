// Opt-in render counts, for checking on a device what a change re-renders. In a development
// build, set `globalThis.__HULI_RENDERS = true` from the JS debugger: each counted component then
// logs its renders, and setting it back to false stops it. The developer's frame meter counts them
// quietly while it measures, in a release build too; otherwise a call costs one check.

const counts = new Map<string, number>()
let tallying = false

export function countRender(name: string): void {
  const log = __DEV__ && !!(globalThis as { __HULI_RENDERS?: boolean }).__HULI_RENDERS
  if (!log && !tallying) return
  const n = (counts.get(name) ?? 0) + 1
  counts.set(name, n)
  if (log) console.log(`[render] ${name} #${n}`)
}

/** Starts or stops counting renders quietly, and returns what was counted since the last call. */
export function tallyRenders(on: boolean): Record<string, number> {
  const counted = Object.fromEntries(counts)
  counts.clear()
  tallying = on
  return counted
}
