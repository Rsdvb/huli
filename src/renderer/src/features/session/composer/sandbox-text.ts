// Huli: a sandbox choice in words: its label, what it costs as measured, and what it allows.

import type { TFunction } from 'i18next'
import {
  onWindowsDrive,
  SANDBOX_MEASURED,
  type SandboxChoice,
  type SandboxNetwork,
  type SandboxTier,
} from '@shared/sandbox'
import { platform } from '@renderer/lib/platform'

export type T = TFunction<'agents'>

const ratio = (a: number, b: number): string => (a / b).toFixed(1).replace(/\.0$/, '')

/** The chip's words for a choice: the tier, and its network when it has one. */
export function sandboxLabel(t: T, choice: SandboxChoice): string {
  if (choice.tier === 'off') return t('sandbox.short.off')
  return t('sandbox.choice', {
    tier: t(`sandbox.short.${choice.tier}`),
    network: t(`sandbox.network.${choice.network}`),
  })
}

/** What a tier costs, as measured, for a session in `folder`. */
export function sandboxCost(t: T, tier: SandboxTier, folder: string | null): string {
  const m = SANDBOX_MEASURED
  if (tier === 'off') return t('sandbox.offNote')
  if (tier === 'native') return t('sandbox.cost.native')
  const start = t('sandbox.cost.container', {
    start: (m.containerStart + m.egressStart).toFixed(1),
    memory: m.engineMemoryMb,
  })
  if (platform !== 'win32') return start
  if (folder && onWindowsDrive(folder)) {
    const drive = t('sandbox.cost.drive', {
      build: ratio(m.containerWindowsDrive, m.windowsNative),
      search: Math.round(m.searchShare / m.searchWindows),
    })
    return t('sandbox.joinCost', { first: start, next: drive })
  }
  return t('sandbox.joinCost', { first: start, next: t('sandbox.cost.wsl') })
}

/** What a network choice lets through on a tier, with the model's addresses a container has. */
export function networkNote(
  t: T,
  tier: Exclude<SandboxTier, 'off'>,
  network: SandboxNetwork,
  hosts: readonly string[] = [],
): string {
  const shown =
    hosts.length > 2
      ? t('sandbox.moreHosts', { first: hosts.slice(0, 2).join(', '), count: hosts.length })
      : hosts.join(', ')
  return t(`sandbox.networkNote.${tier}.${network}` as 'sandbox.networkNote.native.none', {
    hosts: shown,
  })
}

/**
 * What the sandbox allows, line by line, for the badge's tooltip: the harness's own sandbox holds
 * the agent's commands, a container the whole agent.
 */
export function sandboxAllowed(t: T, choice: SandboxChoice, gitWritable: boolean): string[] {
  if (choice.tier === 'off') return [t('sandbox.offNote')]
  const label = t(`sandbox.network.${choice.network}`)
  const git = t(gitWritable ? 'sandbox.allowed.gitWritable' : 'sandbox.allowed.gitReadOnly')
  return choice.tier === 'native'
    ? [
        t('sandbox.allowed.nativeWrites'),
        t('sandbox.allowed.nativeReads'),
        t('sandbox.allowed.networkCommands', { network: label }),
        git,
        t('sandbox.allowed.nativeTools'),
      ]
    : [
        t('sandbox.allowed.containerSees'),
        git,
        t('sandbox.allowed.networkAgent', { network: label }),
        t('sandbox.allowed.containerSignIn'),
        t('sandbox.allowed.containerTools'),
      ]
}

/** Whether a container would slow this folder down, as one on a Windows drive measured. */
export function slowContainer(folder: string | null): boolean {
  return platform === 'win32' && folder !== null && onWindowsDrive(folder)
}
