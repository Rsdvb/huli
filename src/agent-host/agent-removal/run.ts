// Huli: a removal plan read against the disk, the list Settings shows with sizes, and the run that
// takes the steps the user ticked. Every path is checked again right before it goes; files and
// folders go to the system's trash when asked, else for good. Only paths and names are logged.

import { rm, rmdir } from 'node:fs/promises'
import path from 'node:path'
import {
  removalStepId,
  type AgentRemovalResult,
  type RemovalPart,
  type RemovalStep,
} from '@shared/agent-removal'
import type { Platform } from '@shared/platform'
import { sizeOf } from '../agent-reset/reset'
import type { SecretStore } from '../agent-reset/secrets'
import { removalRefusal, type RemovalGuard } from './guard'
import type { PlannedStep, RemovalFiles } from './steps'

export interface ResolvedStep {
  step: RemovalStep
  planned: PlannedStep
}

export interface ResolveContext {
  platform: Platform
  files: RemovalFiles
  secrets: SecretStore
  guard(part: RemovalPart): RemovalGuard
  size?(target: string): Promise<number>
  log(message: string): void
}

function pathsOf(platform: Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

/** The names of a `contents` step's folder that go: all but those it keeps. */
async function goingNames(planned: PlannedStep, ctx: ResolveContext): Promise<string[]> {
  const fold = (name: string): string => (ctx.platform === 'win32' ? name.toLowerCase() : name)
  const keep = new Set((planned.except ?? []).map(fold))
  return (await ctx.files.list(planned.path)).filter((name) => !keep.has(fold(name))).sort()
}

function shown(planned: PlannedStep, bytes: number | null): RemovalStep {
  return {
    id: removalStepId(planned.part, planned.kind, planned.path),
    part: planned.part,
    kind: planned.kind,
    path: planned.path,
    ...(planned.kite ? { kite: true as const } : {}),
    ...(planned.except ? { except: planned.except } : {}),
    ...(planned.secret ? { store: planned.secret.store } : {}),
    bytes,
  }
}

/**
 * What of the plan is there now, in its order, with sizes. A path the guard refuses is left out
 * and logged, as a check on the plan itself; a store that cannot be asked counts as empty.
 */
export async function resolveSteps(
  planned: readonly PlannedStep[],
  ctx: ResolveContext,
): Promise<ResolvedStep[]> {
  const p = pathsOf(ctx.platform)
  const size = ctx.size ?? sizeOf
  const out: ResolvedStep[] = []
  const seen = new Set<string>()
  for (const item of planned) {
    const id = removalStepId(item.part, item.kind, item.path)
    if (seen.has(id)) continue
    let bytes: number | null = null
    switch (item.kind) {
      case 'command':
        if (!item.run) continue
        if (item.measure && (await ctx.files.kind(item.measure)) === 'folder') {
          bytes = await size(item.measure)
        }
        break
      case 'secret':
        if (!item.secret || !(await ctx.secrets.has(item.secret).catch(() => false))) continue
        break
      case 'file':
      case 'folder': {
        if (!(await ctx.files.kind(item.path))) continue
        const refused = removalRefusal(item.path, ctx.guard(item.part))
        if (refused) {
          ctx.log(`The removal plan names ${item.path}, which is ${refused}; it is left out`)
          continue
        }
        bytes = await size(item.path)
        break
      }
      case 'contents': {
        if ((await ctx.files.kind(item.path)) !== 'folder') continue
        const refused = removalRefusal(item.path, ctx.guard(item.part))
        if (refused) {
          ctx.log(`The removal plan names ${item.path}, which is ${refused}; it is left out`)
          continue
        }
        const names = await goingNames(item, ctx)
        if (names.length === 0) continue
        bytes = 0
        for (const name of names) bytes += await size(p.join(item.path, name))
        break
      }
    }
    seen.add(id)
    out.push({ step: shown(item, bytes), planned: item })
  }
  return out
}

export interface RunContext extends ResolveContext {
  /** Moves the paths to the system's trash; null to delete them for good. */
  trash: ((paths: string[]) => Promise<void>) | null
  /** Runs a command step's program: why it failed or null, and the last lines it printed. */
  run(program: string, args: string[]): Promise<{ error: string | null; output: string }>
  progress(step: RemovalStep, state: 'running' | 'done' | 'failed', error?: string): void
}

async function removePaths(paths: string[], ctx: RunContext): Promise<void> {
  if (paths.length === 0) return
  if (ctx.trash) return ctx.trash(paths)
  for (const target of paths) await rm(target, { recursive: true, force: true, maxRetries: 2 })
}

/** Removes each folder while it is empty, stopping at the first that is not. */
async function prune(folders: readonly string[]): Promise<void> {
  for (const folder of folders) {
    try {
      await rmdir(folder)
    } catch {
      return
    }
  }
}

/** Takes one step; a command's output when it printed any. */
async function runStep(resolved: ResolvedStep, ctx: RunContext): Promise<string | undefined> {
  const { planned } = resolved
  const p = pathsOf(ctx.platform)
  const check = (target: string): void => {
    const refused = removalRefusal(target, ctx.guard(planned.part))
    if (refused) throw new Error(`${target} is ${refused}`)
  }
  let output: string | undefined
  switch (planned.kind) {
    case 'command': {
      if (!planned.run) throw new Error('Nothing to run')
      const ran = await ctx.run(planned.run.program, planned.run.args)
      if (ran.error) throw new Error(ran.error)
      output = ran.output.trim() || undefined
      break
    }
    case 'secret':
      if (!planned.secret) throw new Error('No entry to remove')
      await ctx.secrets.remove(planned.secret)
      break
    case 'file':
    case 'folder':
      check(planned.path)
      await removePaths([planned.path], ctx)
      break
    case 'contents': {
      check(planned.path)
      const targets = (await goingNames(planned, ctx)).map((name) => p.join(planned.path, name))
      for (const target of targets) check(target)
      await removePaths(targets, ctx)
      await prune([planned.path])
      break
    }
  }
  if (planned.prune) await prune(planned.prune)
  return output
}

/** Runs the steps in order; each failure is its step's alone, and the rest goes on. */
export async function runSteps(
  steps: readonly ResolvedStep[],
  ctx: RunContext,
): Promise<Omit<AgentRemovalResult, 'skipped'>> {
  const result: Omit<AgentRemovalResult, 'skipped'> = { done: [], failed: [] }
  for (const resolved of steps) {
    ctx.progress(resolved.step, 'running')
    try {
      const output = await runStep(resolved, ctx)
      result.done.push(output ? { ...resolved.step, output } : resolved.step)
      ctx.progress(resolved.step, 'done')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result.failed.push({ step: resolved.step, error: message })
      ctx.progress(resolved.step, 'failed', message)
    }
  }
  return result
}

/** What a run removed and could not, for the log: paths, commands and names only. */
export function removalLog(result: AgentRemovalResult): string {
  const name = (step: RemovalStep): string => `${step.kind} ${step.path}`
  const parts = [
    result.done.length > 0 ? `removed ${result.done.map(name).join('; ')}` : 'removed nothing',
    ...(result.failed.length > 0
      ? [`could not remove ${result.failed.map((f) => `${name(f.step)} (${f.error})`).join('; ')}`]
      : []),
    ...(result.skipped.length > 0 ? [`no longer there: ${result.skipped.join('; ')}`] : []),
  ]
  return parts.join(' | ')
}
