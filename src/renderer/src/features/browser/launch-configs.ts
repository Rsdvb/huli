// Huli: the dev servers a session's folder names in `.claude/launch.json`, read when the pane
// shows the session, and Start: the command in a terminal of the session, then its page.

import { useEffect, useState } from 'react'
import { launchUrl, type LaunchConfig } from '@shared/launch-configs'
import { host } from '@renderer/lib/host'
import { useBrowserStore } from '@renderer/stores/browser'

/** How often, and how far apart, a page that is not up yet is opened again after Start. */
const OPEN_TRIES = 12
const OPEN_RETRY_MS = 1_500

/** The session's presets, read once each time the pane shows it; empty without a file. */
export function useLaunchConfigs(sessionId: string | null): LaunchConfig[] {
  const [configs, setConfigs] = useState<{ sessionId: string; list: LaunchConfig[] } | null>(null)
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    host('sessions.launchConfigs', { sessionId }).then(
      ({ configs: list }) => {
        if (!cancelled) setConfigs({ sessionId, list })
      },
      () => {
        if (!cancelled) setConfigs({ sessionId, list: [] })
      },
    )
    return () => {
      cancelled = true
    }
  }, [sessionId])
  return configs && configs.sessionId === sessionId ? configs.list : []
}

/**
 * Runs a preset's command in a terminal of the session and opens its page. A dev server takes a
 * moment to listen, so a page that fails to load is opened again a few times, on its failure.
 */
export async function startPreset(
  sessionId: string,
  config: LaunchConfig,
  open: (url: string) => void,
): Promise<void> {
  await host('sessions.runCommand', { sessionId, command: config.command, notify: false })
  const url = launchUrl(config)
  let tries = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = (): void => {
    unsubscribe()
    clearTimeout(timer)
  }
  const unsubscribe = useBrowserStore.subscribe((s, before) => {
    const now = s.bySession[sessionId]?.notice
    if (now === before.bySession[sessionId]?.notice) return
    if (now?.kind !== 'load-failed') {
      if (s.bySession[sessionId]?.url && !s.bySession[sessionId]?.loading) stop()
      return
    }
    if (++tries >= OPEN_TRIES) return stop()
    clearTimeout(timer)
    timer = setTimeout(() => open(url), OPEN_RETRY_MS)
  })
  // Gives up on its own once the server had all its tries' time.
  setTimeout(stop, OPEN_TRIES * OPEN_RETRY_MS * 2)
  open(url)
}
