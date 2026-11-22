import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  ArrowDataTransferHorizontalIcon,
  Cancel01Icon,
  Globe02Icon,
  ReloadIcon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { isPort, type ListeningPort, type PortForward } from '@shared/port-forwards'
import { Button } from '@renderer/components/ui/button'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Switch } from '@renderer/components/ui/switch'
import { PaneIcon } from '@renderer/features/shell/panel-button'
import { cn } from '@renderer/lib/utils'
import { setAutoForward, useForwardsStore } from '@renderer/stores/forwards'
import { forwardFailure, forwardPort, forwardUrl, hostFolders, hostName } from './ports'

type Listing =
  | { state: 'loading' }
  | { state: 'ok'; ports: ListeningPort[] }
  | { state: 'failed'; message: string }

/**
 * A host's ports: those forwarded to this computer, with Open and Stop, and those its programs
 * listen on, read once when this opens and again on Refresh, with Forward. `sessionId` is the
 * session whose browser opens them; without one, the system's browser does.
 */
export function PortsPanel({
  hostId,
  sessionId,
  onOpen,
  className,
}: {
  hostId: string
  sessionId: string | null
  /** Opens a forward's address; without it, the address is a link to the system's browser. */
  onOpen?: (forward: PortForward) => void
  className?: string
}) {
  const { t } = useTranslation('browser')
  const all = useForwardsStore((s) => s.forwards)
  const auto = useForwardsStore((s) => !!s.auto[hostId])
  const forwards = all.filter((forward) => forward.hostId === hostId)
  const [listing, setListing] = useState<Listing>({ state: 'loading' })
  const [busy, setBusy] = useState<number | null>(null)
  const [typed, setTyped] = useState('')
  const name = hostName(hostId)

  const read = useCallback(
    () =>
      window.kettu.hosts
        .ports(hostId, hostFolders(hostId))
        .catch(() => ({ ok: false as const, reason: 'failed' as const }))
        .then((result) =>
          setListing(
            result.ok
              ? { state: 'ok', ports: result.ports }
              : { state: 'failed', message: forwardFailure(result.reason, hostId, 0) },
          ),
        ),
    [hostId],
  )
  // Read once as the list opens; Refresh reads again. Nothing reads it on a timer.
  useEffect(() => {
    void read()
  }, [read])
  const refresh = () => {
    setListing({ state: 'loading' })
    void read()
  }

  const forward = async (port: number, process: string | null = null) => {
    setBusy(port)
    const made = await forwardPort(hostId, port, sessionId)
    setBusy(null)
    if (made && onOpen) onOpen({ ...made, process: made.process ?? process })
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const port = Number(typed)
    if (!isPort(port)) return
    setTyped('')
    void forward(port)
  }
  const forwardOf = (port: number) => forwards.find((item) => item.port === port) ?? null

  return (
    <div className={cn('kp-ports', className)}>
      {forwards.length > 0 && (
        <section className="kp-ports__group" aria-label={t('ports.forwarded')}>
          <p className="kp-ports__label">{t('ports.forwarded')}</p>
          {forwards.map((item) => (
            <div key={`${item.sessionId}:${item.port}`} className="kp-ports__row">
              <span className="kp-ports__port kp-mono">{item.port}</span>
              <PaneIcon
                icon={ArrowDataTransferHorizontalIcon}
                size={13}
                className="kp-ports__arrow"
              />
              <span className="kp-ports__what">
                <span className="kp-mono">localhost:{item.localPort}</span>
                {item.auto && <span className="kp-ports__tag">{t('ports.auto')}</span>}
              </span>
              <OpenButton forward={item} onOpen={onOpen} />
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t('ports.stop', { port: item.port })}
                title={t('ports.stop', { port: item.port })}
                onClick={() =>
                  void window.kettu.hosts.stopForward(hostId, item.port, item.sessionId)
                }
              >
                <PaneIcon icon={Cancel01Icon} size={13} />
              </Button>
            </div>
          ))}
        </section>
      )}
      <section className="kp-ports__group" aria-label={t('ports.listening', { host: name })}>
        <div className="kp-ports__head">
          <p className="kp-ports__label">{t('ports.listening', { host: name })}</p>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('ports.refresh')}
            title={t('ports.refresh')}
            disabled={listing.state === 'loading'}
            onClick={refresh}
          >
            <PaneIcon icon={ReloadIcon} size={13} />
          </Button>
        </div>
        {listing.state === 'loading' && (
          <div className="kp-ports__skeleton" aria-label={t('ports.loading')}>
            <Skeleton className="h-6" />
            <Skeleton className="h-6" />
          </div>
        )}
        {listing.state === 'failed' && <p className="kp-ports__note">{listing.message}</p>}
        {listing.state === 'ok' && listing.ports.length === 0 && (
          <p className="kp-ports__note">{t('ports.none', { host: name })}</p>
        )}
        {listing.state === 'ok' &&
          listing.ports.map((entry) => {
            const known = forwardOf(entry.port)
            return (
              <div key={entry.port} className="kp-ports__row">
                <span className="kp-ports__port kp-mono">{entry.port}</span>
                <span className="kp-ports__what" title={entry.folder ?? entry.address}>
                  <span>{entry.process ?? t('ports.unknown')}</span>
                  {entry.folder && <span className="kp-ports__folder kp-mono">{entry.folder}</span>}
                </span>
                {known ? (
                  <OpenButton forward={known} onOpen={onOpen} />
                ) : (
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={busy === entry.port}
                    onClick={() => void forward(entry.port, entry.process)}
                  >
                    {onOpen ? t('ports.forwardOpen') : t('ports.forward')}
                  </Button>
                )}
              </div>
            )
          })}
      </section>
      <form className="kp-ports__manual" onSubmit={submit}>
        <input
          inputMode="numeric"
          value={typed}
          placeholder={t('ports.portPlaceholder')}
          aria-label={t('ports.portLabel')}
          className="kp-ports__input kp-mono"
          onChange={(event) => setTyped(event.target.value.replace(/\D/g, '').slice(0, 5))}
        />
        <Button type="submit" variant="outline" size="xs" disabled={!isPort(Number(typed))}>
          {t('ports.forward')}
        </Button>
      </form>
      <label className="kp-ports__auto">
        <Switch size="sm" checked={auto} onCheckedChange={(on) => setAutoForward(hostId, on)} />
        <span>{t('ports.autoLabel', { host: name })}</span>
      </label>
    </div>
  )
}

function OpenButton({
  forward,
  onOpen,
}: {
  forward: PortForward
  onOpen?: (forward: PortForward) => void
}) {
  const { t } = useTranslation('browser')
  const label = t('ports.openPort', { port: forward.localPort })
  if (onOpen) {
    return (
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        title={label}
        onClick={() => onOpen(forward)}
      >
        <PaneIcon icon={Globe02Icon} size={13} />
      </Button>
    )
  }
  return (
    <a
      href={forwardUrl(forward)}
      target="_blank"
      rel="noreferrer"
      aria-label={label}
      title={label}
      className="kp-ports__link focus-ring"
    >
      <PaneIcon icon={Globe02Icon} size={13} />
    </a>
  )
}
