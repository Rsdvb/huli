// The app versions a hello's client and a welcome's host name: dotted numbers, as "0.20261118.42",
// maybe with a pre-release or build after them. A newer app may need what an older one lacks, which
// each side tells the user of without refusing the other.

const VERSION = /^v?(\d{1,15}(?:\.\d{1,15})*)(?:[-+][0-9A-Za-z.+-]*)?$/

function versionNumbers(version: string): number[] | null {
  const match = VERSION.exec(version.trim())
  return match ? match[1]!.split('.').map(Number) : null
}

/**
 * Whether `theirs` is an older release than `ours`, by their numbers alone. False when either is not
 * a version this side reads, so a version it cannot place never calls the other side old.
 */
export function isOlderApp(theirs: string, ours: string): boolean {
  const a = versionNumbers(theirs)
  const b = versionNumbers(ours)
  if (!a || !b) return false
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x < y
  }
  return false
}
