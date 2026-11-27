// Huli: what the traffic hint and the handoff do, and whether the hint shows for a session.

import { largeContext } from '@shared/traffic'
import type { SessionUsage, UserContent } from '@shared/thread'
import { host } from '@renderer/lib/host'
import { keptPerArtifact } from '@renderer/stores/artifact-kept'
import { showSending } from '@renderer/stores/threads'

/** The sessions whose hint the user dismissed, on this device. */
const dismissed = keptPerArtifact<boolean>(
  'huli.trafficHint.dismissed',
  false,
  (value): value is boolean => typeof value === 'boolean',
)

/** Whether the session's hint or offer shows: a large context, not dismissed, not handed off. */
export function useTrafficHint(
  sessionId: string,
  usage: SessionUsage | null,
  handedOff: boolean,
): { shown: boolean; dismiss: () => void } {
  const gone = dismissed.use(sessionId)
  return {
    shown: !gone && !handedOff && largeContext(usage),
    dismiss: () => dismissed.set(sessionId, true),
  }
}

/** Sends the agent's compaction command as the session's next message, as the context card does. */
export async function compactContext(sessionId: string, prompt: string): Promise<void> {
  const content: UserContent[] = [{ type: 'text', text: prompt }]
  const unshow = showSending(sessionId, content)
  try {
    const { itemId } = await host('sessions.queue', { sessionId, content })
    // A turn started meanwhile, and it waits in the queue, which shows it there.
    if (itemId) unshow()
  } catch (error) {
    unshow()
    throw error
  }
}

/** Asks the agent for a handoff summary; the new session opens in the list once it is written. */
export async function handoffSession(sessionId: string): Promise<void> {
  await host('sessions.handoff', { sessionId })
}
