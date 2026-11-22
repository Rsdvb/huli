// Huli: a sandbox choice in words: its label, what it costs as measured, and what it allows.

import type { TFunction } from 'i18next'
import {
  onWindowsDrive,
  SANDBOX_MEASURED,
  type SandboxChoice,
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
    start: m.containerStart.toFixed(1),
    memory: m.engineMemoryMb,
  })
  if (platform !== 'win32') return start
  if (folder && onWindowsDrive(folder)) {
    const drive = t('sandbox.cost.drive', {
      build: ratio(m.containerWindowsDrive, m.windowsNative),
      native: m.windowsNative,
      container: m.containerWindowsDrive,
      search: Math.round(m.searchShare / m.searchWindows),
    })
    return `${start}; ${drive}`
  }
  return `${start}; ${t('sandbox.cost.wsl')}`
}

/** What the sandbox allows, line by line, for the badge's tooltip. */
export function sandboxAllowed(t: T, choice: SandboxChoice): string[] {
  if (choice.tier === 'off') return [t('sandbox.offNote')]
  const network = t('sandbox.allowed.network', { network: t(`sandbox.network.${choice.network}`) })
  return choice.tier === 'native'
    ? [
        t('sandbox.allowed.nativeWrites'),
        t('sandbox.allowed.nativeReads'),
        network,
        t('sandbox.allowed.nativeTools'),
      ]
    : [
        t('sandbox.allowed.containerSees'),
        network,
        t('sandbox.allowed.containerSignIn'),
        t('sandbox.allowed.containerTools'),
      ]
}
