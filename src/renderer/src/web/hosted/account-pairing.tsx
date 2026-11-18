// Huli: the hosted web client's way to pair without a code. The pairing page lists the computers of
// the Huli Cloud account the browser is signed in to; picking one asks it through the relay, as
// the phone does (src/shared/remote/pair-account.ts): both show the same digits, the computer's
// owner allows the browser there and the user says the digits match here.

import { useEffect, useRef, useState } from 'react'
import { CancelCircleIcon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { AccountComputer } from '@shared/huli-cloud'
import type { Paired } from '@shared/remote/pair'
import type { AccountPairing, AccountPairProgress } from '@shared/remote/pair-account'
import { Alert, AlertDescription } from '@renderer/components/ui/alert'
import { Button } from '@renderer/components/ui/button'
import { Spinner } from '@renderer/components/ui/spinner'

export interface AccountPairingOptions {
  /** The account's computers this browser is not paired with; null when they cannot be read. */
  list(): Promise<AccountComputer[] | null>
  /** Asks a computer to add this browser. */
  pair(computer: AccountComputer, progress: (state: AccountPairProgress) => void): AccountPairing
  /** The computer added this browser: keep it and open the app. */
  added(computer: AccountComputer, paired: Paired): Promise<void>
}

export function AccountComputersPairing({ options }: { options: AccountPairingOptions }) {
  const { t } = useTranslation('huliAccount')
  const [computers, setComputers] = useState<AccountComputer[] | null | undefined>(undefined)
  const [chosen, setChosen] = useState<AccountComputer | null>(null)
  const [progress, setProgress] = useState<AccountPairProgress | null>(null)
  const pairing = useRef<AccountPairing | null>(null)

  useEffect(() => {
    let live = true
    void options.list().then(
      (list) => live && setComputers(list),
      () => live && setComputers(null),
    )
    return () => {
      live = false
      pairing.current?.cancel()
    }
  }, [options])

  const connect = (computer: AccountComputer): void => {
    pairing.current?.cancel()
    setChosen(computer)
    const started = options.pair(computer, setProgress)
    pairing.current = started
    void started.result.then((paired) => {
      if (paired) return options.added(computer, paired)
    })
  }

  if (computers === undefined) return null
  const pairable = (computers ?? []).filter((c) => c.online && c.pairable && c.key)
  const name = chosen?.name ?? ''
  const working = progress && progress.state !== 'failed'

  return (
    <section className="flex flex-col gap-3" aria-label={t('pairing.title')}>
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">{t('pairing.title')}</h2>
        <p className="text-xs text-secondary">{t('pairing.hint')}</p>
      </div>
      {progress?.state === 'failed' && progress.reason !== 'cancelled' && (
        <Alert variant="error">
          <HugeiconsIcon icon={CancelCircleIcon} strokeWidth={1.9} aria-hidden />
          <AlertDescription>{t(`pairing.failed.${progress.reason}`)}</AlertDescription>
        </Alert>
      )}
      {working ? (
        <div
          className="flex flex-col gap-3 rounded-xl bg-card px-4 py-3.5 shadow-card"
          aria-live="polite"
        >
          {progress.state === 'compare' ? (
            <>
              <p className="text-sm">{t('pairing.compare', { name })}</p>
              <p
                className="text-center font-mono text-3xl font-semibold tracking-[0.3em] tabular-nums"
                aria-label={progress.code.split('').join(' ')}
              >
                {`${progress.code.slice(0, 3)} ${progress.code.slice(3)}`}
              </p>
              {progress.matched ? (
                <span className="flex items-center gap-2 text-sm text-secondary">
                  <Spinner />
                  {t('pairing.waiting')}
                </span>
              ) : (
                <div className="flex gap-2">
                  <Button onClick={() => pairing.current?.match(true)}>{t('pairing.same')}</Button>
                  <Button variant="ghost" onClick={() => pairing.current?.match(false)}>
                    {t('pairing.differ')}
                  </Button>
                </div>
              )}
            </>
          ) : (
            <span className="flex items-center gap-2 text-sm">
              <Spinner />
              {t('pairing.connecting')}
            </span>
          )}
        </div>
      ) : pairable.length === 0 ? (
        <p className="text-xs text-secondary">{t('pairing.none')}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border rounded-xl bg-card shadow-card">
          {pairable.map((computer) => (
            <li key={computer.id} className="flex items-center gap-3 px-4 py-2.5">
              <span className="min-w-0 flex-1 truncate text-sm">{computer.name}</span>
              <Button
                size="sm"
                variant="outline"
                aria-label={t('pairing.connectLabel', { name: computer.name ?? '' })}
                onClick={() => connect(computer)}
              >
                {t('pairing.connect')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
