// Huli: forwarding a dev server's port on another host, such as one added over SSH, to this
// computer, and opening it in a session's browser. Main keeps the forwards (@shared/port-forwards).

import {
  forwardedAddress,
  loopbackPort,
  type ForwardFailure,
  type PortForward,
} from '@shared/port-forwards'
import { toast } from '@renderer/components/ui/toast'
import { hostOfPath, hostPath } from '@renderer/lib/host-paths'
import { i18n } from '@renderer/lib/i18n'
import { useHostsStore } from '@renderer/stores/hosts'
import { useProjectsStore } from '@renderer/stores/projects'
import { toggleSidePane } from '@renderer/stores/view'

/** The host's name, as Settings > Computers lists it. */
export function hostName(hostId: string): string {
  return useHostsStore.getState().status?.hosts?.find((h) => h.id === hostId)?.name ?? hostId
}

/** The host's project folders, as it writes them, whose programs its listing puts first. */
export function hostFolders(hostId: string): string[] {
  return useProjectsStore
    .getState()
    .projects.filter((project) => hostOfPath(project.path) === hostId)
    .map((project) => hostPath(project.path))
}

/** The words for a forward that did not start. */
export function forwardFailure(reason: ForwardFailure | 'failed', hostId: string, port: number) {
  return i18n.t(`browser:ports.failure.${reason}`, { host: hostName(hostId), port })
}

/** Forwards the host's port, saying why when it could not; null then. */
export async function forwardPort(
  hostId: string,
  port: number,
  sessionId: string | null,
  auto = false,
): Promise<PortForward | null> {
  const result = await window.kettu.hosts
    .forwardPort(hostId, port, sessionId, auto)
    .catch(() => ({ ok: false as const, reason: 'failed' as const }))
  if (result.ok) return result.forward
  toast(forwardFailure(result.reason, hostId, port), undefined, { tone: 'warning' })
  return null
}

/** The forward's address on this computer, at `path` of the host's. */
export function forwardUrl(forward: PortForward, url?: string): string {
  return (
    (url ? forwardedAddress(url, forward.localPort) : null) ??
    `http://localhost:${forward.localPort}/`
  )
}

/** Shows `url` in the session's browser, opening the pane. */
export function openInSessionBrowser(sessionId: string, url: string): void {
  void window.kettu.browser.navigate(sessionId, url)
  toggleSidePane(sessionId, 'browser', true)
}

/**
 * Opens an address on the host's own loopback, as its dev server printed it, in the session's
 * browser through a forward; false when it is no such address.
 */
export function openOnHost(hostId: string, sessionId: string, url: string): boolean {
  const port = loopbackPort(url)
  if (port === null) return false
  void forwardPort(hostId, port, sessionId).then((forward) => {
    if (forward) openInSessionBrowser(sessionId, forwardUrl(forward, url))
  })
  return true
}

/** A terminal of a session on a host that forwards by itself printed an address. */
export function autoForwarded(hostId: string, port: number, sessionId: string, url: string): void {
  void window.kettu.hosts
    .forwardPort(hostId, port, sessionId, true)
    .then((result) => {
      if (!result.ok) return
      toast(
        i18n.t('browser:ports.autoForwarded', { port, host: hostName(hostId) }),
        {
          label: i18n.t('browser:ports.open'),
          onClick: () => openInSessionBrowser(sessionId, forwardUrl(result.forward, url)),
        },
        { tone: 'info' },
      )
    })
    .catch(() => {})
}
