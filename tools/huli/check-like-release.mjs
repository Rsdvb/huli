// Huli: the phone app's type check as the release run does it (huli-build.yml's iOS and Android
// jobs, and huli-checks.yml's Phone app job): in a copy of the tree with no node_modules but those
// a fresh `npm ci` puts into mobile/, then `npx tsc --noEmit` there. A checkout that ran
// `pnpm install`, or a worktree linked to one's node_modules, resolves packages through
// src/shared/node_modules and the root's, which the release never has, so its own `tsc` may pass
// where the release's fails (as @lezer/markdown did).
//
//   node tools/huli/check-like-release.mjs             the working tree, uncommitted changes too
//   node tools/huli/check-like-release.mjs --ref main  a commit as git has it
//   node tools/huli/check-like-release.mjs --keep      leaves the copy to look into
//
// It runs the computer's own Node.js and npm, where the release runs Node.js 24. npm keeps what it
// downloads in a cache of this script's own under the system's temp folder, never the user's, so
// a second run is quicker; the copy goes once checked. Exits with npm's or tsc's code.

import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const WINDOWS = process.platform === 'win32'
const HOME = path.join(tmpdir(), 'kite-check-like-release')

function parse(argv) {
  const options = { ref: null, keep: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--keep') options.keep = true
    else if (arg === '--ref' && argv[i + 1]) options.ref = argv[++i]
    else {
      console.log('Usage: node tools/huli/check-like-release.mjs [--ref <commit>] [--keep]')
      process.exit(arg === '--help' || arg === '-h' ? 0 : 2)
    }
  }
  return options
}

/** Runs a command to its end with its output shown, and gives its exit code. */
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    // npm and npx are .cmd scripts on Windows, which only a shell starts; the arguments are fixed.
    const child = spawn(command, args, { stdio: 'inherit', shell: WINDOWS, ...options })
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  })
}

/** What git has for `args`, as text. */
function git(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] })
    const chunks = []
    child.stdout.on('data', (chunk) => chunks.push(chunk))
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks).toString('utf8'))
        : reject(new Error(`git ${args[0]} failed`)),
    )
  })
}

/** The files git tracks or would add, as they are in the working tree. */
async function copyWorkingTree(to) {
  const files = (await git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']))
    .split('\0')
    .filter(Boolean)
  let copied = 0
  const queue = [...files]
  const worker = async () => {
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      const from = path.join(ROOT, file)
      // Deleted in the working tree but not yet in the index.
      const info = await stat(from).catch(() => null)
      if (!info?.isFile()) continue
      const target = path.join(to, file)
      await mkdir(path.dirname(target), { recursive: true })
      await copyFile(from, target)
      copied++
    }
  }
  await Promise.all(Array.from({ length: 16 }, worker))
  return copied
}

/** The tree of a commit, as `git archive` gives it. */
async function copyCommit(ref, to) {
  const sha = (await git(['rev-parse', '--verify', `${ref}^{commit}`])).trim()
  await new Promise((resolve, reject) => {
    const archive = spawn('git', ['archive', '--format=tar', sha], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const untar = spawn('tar', ['-x', '-f', '-'], {
      cwd: to,
      stdio: ['pipe', 'inherit', 'inherit'],
    })
    archive.stdout.pipe(untar.stdin)
    archive.on('error', reject)
    untar.on('error', reject)
    untar.on('close', (code) => (code === 0 ? resolve() : reject(new Error('tar failed'))))
  })
  return sha
}

const options = parse(process.argv.slice(2))
await mkdir(HOME, { recursive: true })
// TypeScript looks for packages and types in every folder above too, which the release has none of.
for (let dir = HOME; dir !== path.dirname(dir); dir = path.dirname(dir)) {
  if (await stat(path.join(dir, 'node_modules')).catch(() => null)) {
    console.warn(`Warning: ${path.join(dir, 'node_modules')} can make tsc pass where CI fails.`)
  }
}
const copy = await mkdtemp(path.join(HOME, 'tree-'))
const started = Date.now()
let code
try {
  if (options.ref) {
    const sha = await copyCommit(options.ref, copy)
    console.log(`Checking ${options.ref} (${sha.slice(0, 8)}) in ${copy}`)
  } else {
    const copied = await copyWorkingTree(copy)
    console.log(`Checking the working tree (${copied} files) in ${copy}`)
  }
  const mobile = path.join(copy, 'mobile')
  const env = {
    ...process.env,
    CI: 'true',
    npm_config_cache: path.join(HOME, 'npm-cache'),
    npm_config_update_notifier: 'false',
  }
  code = await run('npm', ['ci', '--legacy-peer-deps', '--no-audit', '--no-fund'], {
    cwd: mobile,
    env,
  })
  if (code !== 0) {
    console.error(`npm ci failed (${code}) in mobile/`)
  } else {
    code = await run('npx', ['--no-install', 'tsc', '--noEmit'], { cwd: mobile, env })
    const took = Math.round((Date.now() - started) / 1000)
    console.log(
      code === 0
        ? `The phone app type-checks as the release checks it (${took} s).`
        : `The phone app fails the release's type check (tsc exit ${code}, ${took} s).`,
    )
  }
} finally {
  if (options.keep) console.log(`Kept ${copy}`)
  else await rm(copy, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
process.exit(code)
