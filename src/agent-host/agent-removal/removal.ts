// Huli: removing an agent from its host too, as the plan the dialog shows and the run of the steps
// the user ticked. The plan is made again for the run, and only steps of the same id run, so
// nothing the user did not see is taken and no path a client sends is ever used.

import type { AgentRemovalPreview, AgentRemovalResult, RemovalPart } from '@shared/agent-removal'
import type { SecretStore } from '../agent-reset/secrets'
import { planData, type DataFacts } from './data'
import type { RemovalGuard } from './guard'
import { planProgram, type ProgramFacts } from './program'
import { resolveSteps, runSteps, type ResolvedStep, type RunContext } from './run'
import { DISK, type RemovalFiles } from './steps'

export interface RemovalFacts {
  program: ProgramFacts
  data: DataFacts
  /** What must stay whole, nothing at or above which may go: home, Kite's data, system folders. */
  protect: string[]
  /** Other agents' own folders. */
  otherFolders: string[]
}

export interface RemovalContext {
  files?: RemovalFiles
  secrets: SecretStore
  size?(target: string): Promise<number>
  log(message: string): void
}

export interface PreparedRemoval {
  preview: Omit<AgentRemovalPreview, 'busy' | 'outside'>
  steps: ResolvedStep[]
  guard(part: RemovalPart): RemovalGuard
}

export async function prepareRemoval(
  facts: RemovalFacts,
  ctx: RemovalContext,
): Promise<PreparedRemoval> {
  const files = ctx.files ?? DISK
  const { platform } = facts.program
  const [program, data] = await Promise.all([
    planProgram(facts.program, files),
    planData(facts.data, files),
  ])
  const guards: Record<RemovalPart, RemovalGuard> = {
    program: { platform, roots: program.roots, protect: facts.protect, others: facts.otherFolders },
    data: { platform, roots: data.roots, protect: facts.protect, others: facts.otherFolders },
  }
  const guard = (part: RemovalPart): RemovalGuard => guards[part]
  const resolve = { platform, files, secrets: ctx.secrets, guard, log: ctx.log }
  const sized = ctx.size ? { ...resolve, size: ctx.size } : resolve
  const [programSteps, dataSteps] = await Promise.all([
    resolveSteps(program.steps, sized),
    resolveSteps(data.steps, sized),
  ])
  return {
    preview: {
      home: facts.program.home,
      platform,
      program: {
        blocked: program.blocked,
        method: program.method,
        steps: programSteps.map(({ step }) => step),
        manual: program.manual,
        notes: program.notes,
      },
      data: {
        known: data.known,
        steps: dataSteps.map(({ step }) => step),
        kept: data.kept,
        notes: data.notes,
      },
    },
    // A vendor's own data command runs with its program, so before anything removes the program.
    steps: [
      ...dataSteps.filter(({ step }) => step.kind === 'command'),
      ...programSteps,
      ...dataSteps.filter(({ step }) => step.kind !== 'command'),
    ],
    guard,
  }
}

/** Runs the steps of `prepared` whose ids `wanted` names; the rest of `wanted` is skipped. */
export async function runRemoval(
  prepared: PreparedRemoval,
  wanted: readonly string[],
  ctx: Omit<RunContext, 'guard' | 'platform' | 'files'> & { files?: RemovalFiles },
): Promise<AgentRemovalResult> {
  const asked = new Set(wanted)
  const steps = prepared.steps.filter(({ step }) => asked.has(step.id))
  const planned = new Set(steps.map(({ step }) => step.id))
  const result = await runSteps(steps, {
    ...ctx,
    files: ctx.files ?? DISK,
    platform: prepared.preview.platform,
    guard: prepared.guard,
  })
  return { ...result, skipped: wanted.filter((id) => !planned.has(id)) }
}
