// Huli: fills the update channel's path into the code before a build. The channel lives at
// https://huli.132-145-200-0.sslip.io/u/<path>, a path of 32 hex characters that only the builds
// know, so the public repository holds a placeholder instead. The path comes from the
// HULI_UPDATE_PATH environment variable (a secret in CI), else from ~/.huli-keys/update-path.txt.
// It is never printed. Without it a local build leaves the placeholder, and that build has no
// updates; in CI (GITHUB_ACTIONS=true) a missing path fails the build.
//
// Run by tools/huli/rebrand.mjs, and on its own by the phone builds:
//   node tools/huli/update-path.mjs
// The output stays in the working tree like the rebrand's; never commit it.

import { readFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PLACEHOLDER = '__HULI_UPDATE_PATH__'
const SEGMENT = /^[0-9a-f]{32}$/

/** Every file that names the channel, relative to the repository. */
export const FILES = [
  'electron-builder.yml',
  'src/daemon/update.ts',
  'src/main/update-sources.ts',
  'src/shared/updates.ts',
]

export class UpdatePathError extends Error {}

/**
 * The channel's path, or null when a local build has none. Throws when it is malformed, or
 * missing in CI; the message never holds the value.
 */
export function readUpdatePath(env = process.env, home = homedir(), read = readFileSync) {
  const ci = env.GITHUB_ACTIONS === 'true'
  let value = (env.HULI_UPDATE_PATH ?? '').trim()
  let from = 'HULI_UPDATE_PATH'
  if (!value) {
    from = path.join(home, '.huli-keys', 'update-path.txt')
    try {
      value = String(read(from, 'utf8')).trim()
    } catch {
      value = ''
    }
  }
  if (!value) {
    if (ci)
      throw new UpdatePathError('HULI_UPDATE_PATH is not set: no update channel for this build')
    return null
  }
  if (!SEGMENT.test(value)) {
    throw new UpdatePathError(`The update path in ${from} is not 32 lowercase hex characters`)
  }
  return value
}

/** Fills the path into FILES; resolves to how many files it changed. */
export async function fillUpdatePath(env = process.env) {
  const ci = env.GITHUB_ACTIONS === 'true'
  const value = readUpdatePath(env)
  if (value === null) {
    console.warn('update-path: no update path here; this build has no updates')
    return 0
  }
  let changed = 0
  for (const rel of FILES) {
    const full = path.join(ROOT, rel)
    const text = await readFile(full, 'utf8')
    if (!text.includes(PLACEHOLDER)) {
      // A fresh checkout holds it in every file; a local tree may hold it filled in already.
      if (ci) throw new UpdatePathError(`${rel} no longer holds the update path's placeholder`)
      continue
    }
    await writeFile(full, text.split(PLACEHOLDER).join(value), 'utf8')
    changed++
  }
  return changed
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const changed = await fillUpdatePath()
    console.log(`update-path: filled in ${changed} files`)
  } catch (error) {
    // No message holds the path: they name the variable, the file or the code file.
    console.error(`update-path: ${error.message}`)
    process.exitCode = 1
  }
}
