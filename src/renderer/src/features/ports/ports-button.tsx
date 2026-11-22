import { useEffect, useState } from 'react'
import { ArrowDataTransferHorizontalIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { PaneIcon } from '@renderer/features/shell/panel-button'
import { loadForwards, useForwardsStore } from '@renderer/stores/forwards'
import { PortsPanel } from './ports-panel'
import { forwardUrl, hostName, openInSessionBrowser } from './ports'

/**
 * Huli: the browser pane's Ports for a session on another host: its forwarded ports and the ones
 * listening there, which open in the session's browser.
 */
export function PortsButton({ hostId, sessionId }: { hostId: string; sessionId: string }) {
  const { t } = useTranslation('browser')
  const [open, setOpen] = useState(false)
  useEffect(loadForwards, [])
  const count = useForwardsStore((s) => s.forwards.filter((f) => f.hostId === hostId).length)
  const label = t('ports.button', { host: hostName(hostId) })
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={label}
            title={label}
            className="kp-tool app-region-no-drag kp-ports-trigger"
          />
        }
      >
        <PaneIcon icon={ArrowDataTransferHorizontalIcon} />
        {count > 0 && <span className="kp-ports-trigger__count">{count}</span>}
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-88 max-w-[calc(100vw-32px)] p-2">
        {open && (
          <PortsPanel
            hostId={hostId}
            sessionId={sessionId}
            onOpen={(forward) => {
              setOpen(false)
              openInSessionBrowser(sessionId, forwardUrl(forward))
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}
