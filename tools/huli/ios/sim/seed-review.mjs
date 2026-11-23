// Huli: the daemon's data for the review findings flow (88-review-findings): a Git repository with
// an uncommitted change to src/clock.ts, added as a project, so a session in it has changes for
// the fake agent to review. Written only into a fresh data folder, before the daemon starts.
// usage: node seed-review.mjs <daemon data folder> <project folder>
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const [data, project] = process.argv.slice(2)
const state = path.join(data, 'state')
if (existsSync(path.join(state, 'projects.json'))) process.exit(0)
mkdirSync(state, { recursive: true })
mkdirSync(path.join(project, 'src'), { recursive: true })

const git = (...args) => execFileSync('git', args, { cwd: project, stdio: 'ignore' })
const steps = Array.from(
  { length: 30 },
  (_, i) => `export function step${i + 1}(value: number): number {\n  return value + ${i + 1}\n}\n`,
)
const clock = (zone) =>
  [
    '// A small clock for the demo.',
    '',
    'export interface Clock {',
    '  now(): number',
    '}',
    '',
    ...(zone
      ? [
          'export function offset(zone: string | null): number {',
          '  return zone!.length * 60',
          '}',
          '',
        ]
      : []),
    ...steps,
  ].join('\n')
writeFileSync(path.join(project, 'src', 'clock.ts'), clock(false))
git('init', '-q', '-b', 'main')
git('-c', 'user.name=Kite', '-c', 'user.email=kite@example.invalid', 'add', '-A')
git('-c', 'user.name=Kite', '-c', 'user.email=kite@example.invalid', 'commit', '-q', '-m', 'init')
writeFileSync(path.join(project, 'src', 'clock.ts'), clock(true))

const now = Date.now()
writeFileSync(
  path.join(state, 'projects.json'),
  JSON.stringify({
    version: 1,
    projects: [{ path: project, name: '审查演示', addedAt: now - 3_600_000, lastOpenedAt: now }],
  }),
)
