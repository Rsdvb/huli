// What the Agent and Harness pages read from an agent's status, as the desktop's Settings reads it:
// whether it can run, what it needs first, its version, and installing a harness from the phone.

import type {
  AgentInstallMethod,
  AgentStatus,
  EnvironmentInfo,
  PlanLimit,
} from '@shared/agent-host'
import type { HostLink } from '@shared/remote/link'
import type { SettingsPatch } from '@shared/settings'
import type { HarnessId } from '@shared/thread'
import { admin } from '../admin'
import { ago } from '../sessions'
import { call } from './kit'

export const VENDORS: Partial<Record<HarnessId, string>> = {
  'claude-code': 'Anthropic',
  codex: 'OpenAI',
  opencode: 'SST',
  pi: 'Earendil',
  omp: 'Oh My Pi',
  hermes: 'Nous Research',
  muse: 'Meta',
  codewhale: 'Codewhale',
  deepseek: 'DeepSeek',
}

export const METHOD_NAMES: Record<AgentInstallMethod['id'], string> = {
  archive: '下载',
  brew: 'Homebrew',
  npm: 'npm',
  script: '官方安装脚本',
  winget: 'WinGet',
}

/** The agents the user added or turned on: catalog entries without an agent are left out. */
export function usableAgents(agents: Iterable<AgentStatus>): AgentStatus[] {
  return [...agents].filter((s) => s.registered !== false)
}

/** Each harness once, by its default agent's status. */
export function harnessStatuses(agents: Iterable<AgentStatus>): AgentStatus[] {
  return [...agents].filter((s) => s.isDefault)
}

export function isInstalled(status: AgentStatus): boolean {
  return !['not-installed', 'node-missing', 'node-outdated'].includes(status.state)
}

/** Its harness's program is on the machine, even one that cannot run yet, such as a too old one. */
export function hasProgram(status: AgentStatus): boolean {
  return isInstalled(status) || !!status.cli?.installed
}

/** Ready to install but not installed: Huli's adapter, or the SDK while the user's CLI is missing. */
export function awaitsPackage(status: AgentStatus): boolean {
  const pkg = status.package
  return (
    !!pkg && !pkg.installed && status.state === 'available' && !(pkg.isSdk && status.cli?.installed)
  )
}

/** The oldest version the user's program must be, when it is there but older; null otherwise. */
export function cliOutdated(status: AgentStatus): string | null {
  const problem = status.cli?.installed?.problem
  return problem?.kind === 'too-old' ? problem.minimum : null
}

export type InstallKind = 'program' | 'package' | 'setup'

export function installKind(status: AgentStatus): InstallKind | null {
  if (cliOutdated(status) !== null) return null
  const programMissing = status.state === 'not-installed' && !status.cli?.installed
  if (programMissing && status.installMethods.length > 0) return 'program'
  if (status.package && !status.package.installed && status.state === 'available') return 'package'
  if (['not-installed', 'node-missing', 'node-outdated'].includes(status.state)) return 'setup'
  return null
}

export type Readiness =
  | { kind: 'ready' }
  | { kind: 'sign-in' }
  | { kind: 'installing' }
  | { kind: 'starting' }
  | { kind: 'failed'; message: string }
  | { kind: 'missing'; message: string; action: string; url: string | null }

export function readiness(status: AgentStatus): Readiness {
  switch (status.state) {
    case 'not-installed':
      if (cliOutdated(status) !== null) {
        return {
          kind: 'missing',
          message: status.detail ?? '版本比纸鸢要的旧，更新后才能用。',
          action: '更新方法',
          url: null,
        }
      }
      return {
        kind: 'missing',
        message: status.detail ?? '未在 PATH 中找到。',
        action: '安装方法',
        url: status.installUrl,
      }
    case 'node-missing':
    case 'node-outdated':
      return {
        kind: 'missing',
        message: status.detail ?? '需要 Node.js 22 或更高版本。',
        action: '安装 Node.js',
        url: status.installUrl,
      }
    case 'installing':
      return { kind: 'installing' }
    case 'starting':
      return { kind: 'starting' }
    case 'failed':
      return { kind: 'failed', message: status.detail ?? '无法启动。' }
    default:
      return status.signIn === 'required' ? { kind: 'sign-in' } : { kind: 'ready' }
  }
}

export type StateTone = 'success' | 'warning' | 'danger' | 'neutral' | 'tint'

/** The agent's state in a word or two, and the tone it is shown in. */
export function stateText(status: AgentStatus): { text: string; tone: StateTone } {
  if (status.disabled) return { text: '已停用', tone: 'neutral' }
  const r = readiness(status)
  switch (r.kind) {
    case 'ready':
      return { text: '已就绪', tone: 'success' }
    case 'sign-in':
      return { text: '需要登录', tone: 'warning' }
    case 'installing':
      return { text: '正在安装', tone: 'tint' }
    case 'starting':
      return { text: '正在启动', tone: 'tint' }
    case 'failed':
      return { text: '失败', tone: 'danger' }
    case 'missing':
      return cliOutdated(status) !== null
        ? { text: '需要更新', tone: 'warning' }
        : { text: '不可用', tone: 'neutral' }
  }
}

/** Listed under Installed: it can run now, or one tap installs what it lacks. */
export function listedInstalled(status: AgentStatus): boolean {
  if (readiness(status).kind === 'missing') return false
  const pkg = status.package
  return !(pkg && !pkg.installed && !(pkg.isSdk && status.cli?.installed))
}

/** Up to date only once the harness is on the machine and has been checked. */
export function showsCurrent(status: AgentStatus): boolean {
  if (status.uninstalled || !hasProgram(status) || awaitsPackage(status)) return false
  if (cliOutdated(status) !== null) return false
  return status.updateCheckedAt !== null || status.cli !== null
}

/** The adapter an update brings when that is all it changes. */
export function adapterOnlyUpdate(status: AgentStatus): { name: string; version: string } | null {
  if (!status.cli || !status.package || status.update?.cliVersion !== null) return null
  return status.package
}

/** The harness's own version: the user's CLI it runs, or the program's, never Huli's package. */
export function harnessVersion(status: AgentStatus): string | null {
  return status.cli ? (status.cli.installed?.version ?? null) : status.version
}

/** Where a harness is installed from the Installed group's point of view. */
export function harnessInstalled(status: AgentStatus): boolean {
  return hasProgram(status) && !awaitsPackage(status) && !status.uninstalled
}

/** The harnesses an agent can be added to now. */
export function addableHarnesses(agents: Iterable<AgentStatus>, multi: readonly HarnessId[]) {
  return harnessStatuses(agents).filter(
    (s) =>
      s.uninstalled !== true &&
      hasProgram(s) &&
      !awaitsPackage(s) &&
      (s.registered === false || multi.includes(s.harnessId)),
  )
}

/** The windows whose reset has not passed. */
export function currentLimits(limits: readonly PlanLimit[], now = Date.now()): PlanLimit[] {
  return limits.filter((l) => l.resetsAt === null || l.resetsAt > now)
}

export function percent(limit: PlanLimit): string {
  return limit.usedPercent === null ? '—' : `${Math.round(limit.usedPercent)}%`
}

/** Where the agents' environment was read from. */
export function environmentText(environment: EnvironmentInfo | null): string {
  const source = environment?.source
  if (!environment || source === 'pending') return '正在读取你的环境…'
  if (source === 'login-shell') {
    return environment.shell && environment.resolvedAt && environment.durationMs
      ? `${ago(environment.resolvedAt)}从登录 Shell（${environment.shell}）读取，耗时 ${environment.durationMs} ms。`
      : '已从登录 Shell 读取。'
  }
  return source === 'inherited' ? '继承自纸鸢的启动方式。' : '正在使用备用 PATH。'
}

/**
 * Installs a harness: takes it back if it was uninstalled, installs its program or package by
 * `method`, then gives it its default agent once it can run. Resolves when the install ended.
 */
export async function startInstall(
  link: HostLink,
  harness: HarnessId,
  method?: AgentInstallMethod['id'] | null,
): Promise<void> {
  await admin(link, 'settings.update', {
    patch: { agents: { [harness]: { uninstalled: false } } } as SettingsPatch,
  }).catch(() => {})
  let [status] = (await call(link, 'agents.check', { agentId: harness })).filter(
    (s) => s.id === harness,
  )
  if (!status || status.uninstalled || status.task?.state === 'running') return
  const kind = installKind(status)
  if (kind === 'program' || kind === 'package') {
    await call(link, 'agents.install', {
      agentId: harness,
      ...(method ? { method } : {}),
    })
  }
  ;[status] = (await call(link, 'agents.check', { agentId: harness })).filter(
    (s) => s.id === harness,
  )
  if (
    !status ||
    status.registered !== false ||
    status.uninstalled ||
    status.task ||
    status.state !== 'available'
  ) {
    return
  }
  await admin(link, 'settings.update', {
    patch: { agents: { [harness]: { enabled: true } } } as SettingsPatch,
  }).catch(() => {})
}
