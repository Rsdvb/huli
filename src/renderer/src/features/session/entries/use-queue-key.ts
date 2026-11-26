import { threadQueue } from '@shared/permission-queue'
import { useThreadsStore } from '@renderer/stores/threads'

/**
 * Huli: the queue's request ids, oldest first, when `entryId` is the request answered now and
 * others wait behind it; '' otherwise. A key, so a card renders again only when its queue does.
 */
export function useQueueKey(sessionId: string, entryId: string): string {
  return useThreadsStore((s) => {
    const state = s.replicas[sessionId]?.state
    const entry = state?.byId[entryId]
    if (entry?.kind !== 'tool' || !entry.permission) return ''
    const queue = threadQueue(state)
    return queue.length > 1 && queue[0]!.id === entryId ? queue.map((e) => e.id).join('\n') : ''
  })
}
