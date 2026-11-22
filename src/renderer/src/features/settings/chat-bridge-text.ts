// Huli: what Settings > Chat apps says of a bridge's connection.

import type { TFunction } from 'i18next'
import type { ChatBridgeStatus, ChatPlatformView } from '@shared/chat-bridge'
import { mediumAgo } from '@renderer/lib/format'

/** What a connection's state says under the platform's name. */
export function statusLine(
  view: ChatPlatformView,
  t: TFunction<'settings'>,
): { text: string; tone: 'neutral' | 'success' | 'warning'; problem: string | null } {
  const { status } = view
  if (!view.ready)
    return { text: t('chatBridge.state.noCredentials'), tone: 'neutral', problem: null }
  if (!view.enabled) return { text: t('chatBridge.state.disabled'), tone: 'neutral', problem: null }
  const problem = problemText(status, t)
  switch (status.state) {
    case 'connected':
      return {
        text: status.botName
          ? t('chatBridge.state.connectedAs', { bot: status.botName })
          : t('chatBridge.state.connected'),
        tone: 'success',
        problem: null,
      }
    case 'error':
      return { text: t('chatBridge.state.error'), tone: 'warning', problem }
    case 'connecting':
      return { text: t('chatBridge.state.connecting'), tone: 'neutral', problem }
    default:
      return { text: t('chatBridge.state.starting'), tone: 'neutral', problem: null }
  }
}

function problemText(status: ChatBridgeStatus, t: TFunction<'settings'>): string | null {
  if (!status.problem) return null
  const when = status.errorAt ? mediumAgo(status.errorAt) : ''
  const what = t(`chatBridge.problem.${status.problem}`)
  return [when, what, status.detail].filter(Boolean).join(' · ')
}
