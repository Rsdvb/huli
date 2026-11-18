// How the app words the link to the computer: its state, the route it took, what went wrong.

import type { LinkState } from '@shared/remote/link'
import type { DirectAddress } from '@shared/remote/protocol'

/** `off`: not connected for a while, the computer likely off or Huli not running there. */
export type LinkTone = 'ok' | 'busy' | 'down' | 'off'

/** The link's state in words and a tone, once `unreachable` (see host.tsx) as 连不上. */
export function linkStatusOf(
  state: LinkState,
  unreachable: boolean,
): { text: string; tone: LinkTone } {
  if (unreachable && state.kind !== 'connected' && state.kind !== 'stopped') {
    return { text: '连不上', tone: 'off' }
  }
  return linkStatus(state)
}

/** The computer's OS: as it said, else guessed from the names Windows and macOS give by default. */
export function platformOf(
  saved: { platform?: string; name?: string } | null | undefined,
  live?: string,
): string | undefined {
  const known = live ?? saved?.platform
  if (known) return known
  const name = saved?.name ?? ''
  if (/^(DESKTOP|LAPTOP)-[A-Z0-9]+$/i.test(name)) return 'win32'
  if (/(MacBook|iMac|Mac mini|Mac Studio|Mac Pro|\.local$)/i.test(name)) return 'darwin'
  return undefined
}

export function linkStatus(state: LinkState): { text: string; tone: LinkTone } {
  switch (state.kind) {
    case 'connected':
      return { text: '已连接', tone: 'ok' }
    case 'connecting':
      return { text: '正在连接…', tone: 'busy' }
    case 'reconnecting':
      return { text: '正在重新连接…', tone: 'busy' }
    case 'stopped':
      return { text: '已断开', tone: 'down' }
  }
}

/** A sentence for the home screen while the link is not up; null while it is. */
export function linkProblem(state: LinkState): string | null {
  switch (state.kind) {
    case 'connected':
      return null
    case 'connecting':
      return '正在连接电脑…'
    case 'reconnecting':
      return '正在重新连接…'
    case 'stopped':
      return state.reason === 'update_client'
        ? '这个 App 版本太旧，请更新。'
        : state.reason === 'update_host'
          ? '电脑上的纸鸢版本太旧，请先更新电脑端。'
          : '这台手机已被电脑移除。'
  }
}

export const ROUTE_NAMES = { tailscale: 'Tailscale', lan: '局域网', other: '直连' } as const

export function hostPort(address: DirectAddress): string {
  return address.host.includes(':')
    ? `[${address.host}]:${address.port}`
    : `${address.host}:${address.port}`
}

export function osName(platform: string | undefined): string {
  switch (platform) {
    case 'win32':
      return 'Windows'
    case 'darwin':
      return 'macOS'
    case 'linux':
      return 'Linux'
    default:
      return platform ?? '电脑'
  }
}
