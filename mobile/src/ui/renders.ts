// Opt-in render counts, for checking on a device what a change re-renders. In a development
// build, set `globalThis.__HULI_RENDERS = true` from the JS debugger: each counted component then
// logs its renders, and setting it back to false stops it. Production builds drop the calls.

const counts = new Map<string, number>()

export function countRender(name: string): void {
  if (!__DEV__ || !(globalThis as { __HULI_RENDERS?: boolean }).__HULI_RENDERS) return
  const n = (counts.get(name) ?? 0) + 1
  counts.set(name, n)
  console.log(`[render] ${name} #${n}`)
}
