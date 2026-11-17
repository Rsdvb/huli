// How the app words the link to the computer: its state, the route it took, what went wrong.

import type { LinkState } from '@shared/remote/link'
import type { DirectAddress } from '@shared/remote/protocol'

export type LinkTone = 'ok' | 'busy' | 'down'

export function linkStatus(state: LinkState): { text: string; tone: LinkTone } {
  switch (state.kind) {
    case 'connected':
      return { text: '已连接', tone: 'ok' }
    case 'connecting':
      return { text: '正在连接…', tone: 'busy' }
    case 'reconnecting':
      return { text: '正在重连…', tone: 'busy' }
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
      return '连接断开，正在重连…'
    case 'stopped':
      return state.reason === 'update_client'
        ? '这个 App 版本太旧，请更新。'
        : state.reason === 'update_host'
          ? '电脑上的 Huli 版本太旧，请先更新电脑端。'
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
