// Huli: an agent's own data on its host, which removing it may also delete: its sign-in,
// settings, caches and its own session history. The folders are the reset's (agent-reset/plan.ts),
// read from each agent's code, now taken whole; what another program or app shares stays, and the
// dialog says so. Kite's own sessions of the agent stay in Kite.

import path from 'node:path'
import type { DataNote, RemovalKept } from '@shared/agent-removal'
import type { Platform } from '@shared/platform'
import type { HarnessId } from '@shared/thread'
import { resetPlan, type ResetContext, type ResetPlan } from '../agent-reset/plan'
import { secretName } from '../agent-reset/secrets'
import { dataFolder } from '../doubao/program'
import type { PlannedStep, RemovalFiles } from './steps'

export interface DataFacts extends ResetContext {
  harness: HarnessId
  /** The folder Kite gives the agent was picked by the user, rather than made by Kite. */
  picked: boolean
  /** Other agents on the same harness, which share what every copy of it keeps in one place. */
  others: readonly string[]
}

export interface DataPlan {
  known: boolean
  steps: PlannedStep[]
  kept: RemovalKept[]
  notes: DataNote[]
  /** The files and folders the steps may remove. */
  roots: string[]
}

// What Codex keeps on Windows for the sandbox accounts it made, which outlive its folder.
const CODEX_SANDBOX = [
  '.sandbox',
  '.sandbox-bin',
  '.sandbox-secrets',
  '.sandbox_migration',
  'cap_sid',
]

function pathsOf(platform: Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

function value(ctx: ResetContext, name: string): string | null {
  const found = ctx.getEnv(name)
  return found && found.trim() !== '' ? found : null
}

const folder = (target: string, prune?: string[]): PlannedStep => ({
  part: 'data',
  kind: 'folder',
  path: target,
  ...(prune ? { prune } : {}),
})

const contents = (target: string, except: string[], prune?: string[]): PlannedStep => ({
  part: 'data',
  kind: 'contents',
  path: target,
  except,
  ...(prune ? { prune } : {}),
})

const file = (target: string): PlannedStep => ({ part: 'data', kind: 'file', path: target })

/** The reset's entries of the system's credential store, which hold the agent's sign-in. */
function secrets(plan: ResetPlan): PlannedStep[] {
  return plan.entries.flatMap((entry) =>
    entry.kind === 'secret'
      ? [
          {
            part: 'data' as const,
            kind: 'secret' as const,
            path: secretName(entry.secret),
            secret: entry.secret,
          },
        ]
      : [],
  )
}

/** The folders of a list without one that lies inside another. */
function outermost(folders: readonly string[], platform: Platform): string[] {
  const p = pathsOf(platform)
  const key = (target: string): string =>
    platform === 'win32' ? p.resolve(target).toLowerCase() : p.resolve(target)
  const inside = (parent: string, child: string): boolean => {
    const rel = p.relative(key(parent), key(child))
    return rel === '' || (!rel.startsWith('..') && !p.isAbsolute(rel))
  }
  const unique = folders.filter(
    (target, index) => folders.findIndex((other) => key(other) === key(target)) === index,
  )
  return unique.filter(
    (target) => !unique.some((other) => key(other) !== key(target) && inside(other, target)),
  )
}

/** What `kept` names that is there now. */
async function present(kept: RemovalKept[], files: RemovalFiles): Promise<RemovalKept[]> {
  const found = await Promise.all(
    kept.map(async (item) => (item.store || (await files.kind(item.path)) ? item : null)),
  )
  return found.filter((item) => item !== null)
}

function done(plan: Omit<DataPlan, 'roots'>): DataPlan {
  const roots = plan.steps.flatMap((step) => (step.kind === 'secret' ? [] : [step.path]))
  return { ...plan, roots }
}

async function claudeData(facts: DataFacts, files: RemovalFiles): Promise<DataPlan> {
  const p = pathsOf(facts.platform)
  const reset = await resetPlan('claude-code', facts)
  const moved = facts.chosen ?? value(facts, 'CLAUDE_CONFIG_DIR')
  const own = reset.folder ?? p.join(facts.home, '.claude')
  const steps: PlannedStep[] = []
  const kept: RemovalKept[] = []
  // Every Claude Code keeps its device keys in ~/.claude, whatever folder it was given.
  const deviceKeys = p.join(facts.home, '.claude', '.device-keys.json')
  if (!moved && facts.others.length > 0) {
    steps.push(contents(own, ['.device-keys.json']))
    kept.push({ path: deviceKeys, reason: 'agents' })
  } else {
    steps.push(folder(own))
  }
  if (!moved) {
    // `.claude.json` sits in the home folder unless the folder was moved, with older backups.
    steps.push(file(p.join(facts.home, '.claude.json')))
    for (const name of (await files.list(facts.home)).sort()) {
      if (/^\.claude\.json\.backup(\.\d+)?$/.test(name)) steps.push(file(p.join(facts.home, name)))
    }
  }
  // The sign-in's file in the folder CLAUDE_SECURESTORAGE_CONFIG_DIR names instead.
  for (const entry of reset.entries) {
    if (entry.kind === 'path' && entry.category === 'credentials') {
      const rel = p.relative(own, entry.path)
      if (rel.startsWith('..') || p.isAbsolute(rel)) steps.push(file(entry.path))
    }
  }
  steps.push(...secrets(reset))
  const notes: DataNote[] = moved ? [] : ['claude-apps']
  if (facts.picked) notes.push('picked-folder')
  return done({ known: true, steps, kept: await present(kept, files), notes })
}

async function codexData(facts: DataFacts, files: RemovalFiles): Promise<DataPlan> {
  const p = pathsOf(facts.platform)
  const reset = await resetPlan('codex', facts)
  const own = reset.folder ?? p.join(facts.home, '.codex')
  const moved = facts.chosen ?? value(facts, 'CODEX_HOME')
  const sandbox = facts.platform === 'win32' ? CODEX_SANDBOX : []
  const kept: RemovalKept[] = [
    // The standalone installer's program; uninstalling it removes it.
    { path: p.join(own, 'packages'), reason: 'program' },
    ...sandbox.map((name): RemovalKept => ({ path: p.join(own, name), reason: 'sandbox' })),
  ]
  const notes: DataNote[] = moved ? [] : ['codex-app']
  if (facts.picked) notes.push('picked-folder')
  return done({
    known: true,
    steps: [contents(own, ['packages', ...sandbox]), ...secrets(reset)],
    kept: await present(kept, files),
    notes,
  })
}

async function antigravityData(facts: DataFacts, files: RemovalFiles): Promise<DataPlan> {
  const p = pathsOf(facts.platform)
  const base = p.join(facts.home, '.gemini')
  const reset = await resetPlan('antigravity', facts)
  // The keyring entry, the older token and the app's own folder are the Antigravity app's too.
  const kept: RemovalKept[] = [
    { path: p.join(base, 'antigravity'), reason: 'app' },
    { path: p.join(base, 'jetski-standalone-oauth-token'), reason: 'app' },
    ...reset.entries.flatMap((entry): RemovalKept[] =>
      entry.kind === 'secret'
        ? [{ path: secretName(entry.secret), reason: 'app', store: entry.secret.store }]
        : [],
    ),
  ]
  return done({
    known: true,
    steps: [folder(p.join(base, 'antigravity-cli'))],
    kept: await present(kept, files),
    notes: ['antigravity-app'],
  })
}

/** Where the agent keeps its data, and what of it may go. */
export async function planData(facts: DataFacts, files: RemovalFiles): Promise<DataPlan> {
  const p = pathsOf(facts.platform)
  const { home } = facts
  const picked: DataNote[] = facts.picked ? ['picked-folder'] : []
  const resolve = (target: string): string => p.resolve(home, target)
  switch (facts.harness) {
    case 'claude-code':
      return claudeData(facts, files)
    case 'codex':
      return codexData(facts, files)
    case 'antigravity':
      return antigravityData(facts, files)
    case 'deepseek': {
      const moved = facts.chosen ?? value(facts, 'DSH_HOME')
      const kept: RemovalKept[] = [{ path: p.join(home, '.agents'), reason: 'agents' }]
      return done({
        known: true,
        steps: [folder(moved ? resolve(moved) : p.join(home, '.dsh'))],
        kept: await present(kept, files),
        notes: picked,
      })
    }
    case 'codebuddy': {
      const moved = facts.chosen ?? value(facts, 'CODEBUDDY_CONFIG_DIR')
      return done({
        known: true,
        steps: [folder(moved ? resolve(moved) : p.join(home, '.codebuddy'))],
        kept: [],
        notes: ['codebuddy-sign-in', ...picked],
      })
    }
    case 'doubao': {
      const env = Object.fromEntries(
        ['LOCALAPPDATA', 'XDG_DATA_HOME', 'HOME'].map((name) => [name, facts.getEnv(name)]),
      )
      const own = dataFolder(env, facts.platform, home)
      const kept: RemovalKept[] = [{ path: p.join(own, 'app'), reason: 'program' }]
      return done({
        known: true,
        steps: [contents(own, ['app'], [own])],
        kept: await present(kept, files),
        notes: [],
      })
    }
    case 'pi': {
      const reset = await resetPlan('pi', facts)
      const own = reset.folder ?? p.join(home, '.pi', 'agent')
      const parent = p.join(home, '.pi')
      return done({
        known: true,
        steps: [folder(own, p.dirname(own) === parent ? [parent] : undefined)],
        kept: [],
        notes: [],
      })
    }
    case 'cline': {
      const reset = await resetPlan('cline', facts)
      return done({
        known: true,
        steps: outermost(reset.roots, facts.platform).map((target) => folder(target)),
        kept: [],
        notes: [],
      })
    }
    case 'dimcode': {
      const moved = value(facts, 'DIMCODE_HOME')
      return done({
        known: true,
        steps: [folder(moved ? resolve(moved) : p.join(home, '.dimcode'))],
        kept: [],
        notes: [],
      })
    }
    case 'opencode': {
      const xdg = (name: string, fallback: string[]): string =>
        p.join(resolve(value(facts, name) ?? p.join(home, ...fallback)), 'opencode')
      return done({
        known: true,
        steps: outermost(
          [
            xdg('XDG_DATA_HOME', ['.local', 'share']),
            xdg('XDG_CONFIG_HOME', ['.config']),
            xdg('XDG_CACHE_HOME', ['.cache']),
            xdg('XDG_STATE_HOME', ['.local', 'state']),
          ],
          facts.platform,
        ).map((target) => folder(target)),
        kept: [],
        notes: [],
      })
    }
    default:
      if (facts.chosen) {
        return done({
          known: true,
          steps: [folder(resolve(facts.chosen))],
          kept: [],
          notes: picked,
        })
      }
      return { known: false, steps: [], kept: [], notes: [], roots: [] }
  }
}
