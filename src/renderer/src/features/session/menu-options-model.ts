import { useShallow } from 'zustand/react/shallow'
import type { ConfigOption } from '@shared/thread'
import { useThreadsStore } from '@renderer/stores/threads'

/**
 * Huli: the options a session's agent offers in its menu (`place: 'menu'`), from its open thread;
 * none while it is not open.
 */
export function useMenuOptions(sessionId: string): ConfigOption[] {
  return useThreadsStore(
    useShallow((s) =>
      (s.replicas[sessionId]?.state?.session.config ?? []).filter(
        (option) => option.place === 'menu' && option.type === 'select' && !!option.choices?.length,
      ),
    ),
  )
}
