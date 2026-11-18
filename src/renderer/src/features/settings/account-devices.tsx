// Huli: Settings › Account's Huli Cloud parts. This computer's registration as one of the account's
// computers, the account's computers with when each was last online, and its signed-in devices,
// each of which can be signed out there, or all but this one.

import { useEffect, useState, type ReactNode } from 'react'
import { ComputerIcon, Globe02Icon, SmartPhone01Icon } from '@hugeicons/core-free-icons'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { AccountComputer, AccountDevice, AccountDevices } from '@shared/huli-cloud'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog'
import { longAgo } from '@renderer/lib/format'
import { errorMessage } from '@renderer/lib/host'
import {
  loadAccountDevices,
  revokeAccountDevice,
  useAccountDevicesStore,
} from '@renderer/stores/account-devices'
import { CONFIRM, ControlError, DangerButton, Pill, SetButton, Skel } from './controls'
import { DeviceTile, HostIcon, OnlineDot } from './remote-parts'
import { EmptyRow, ItemLine, RowLine, RowText, Thing } from './rows'

/** Reads the list when the page shows. */
function useAccountDevices() {
  const result = useAccountDevicesStore((s) => s.result)
  useEffect(() => {
    void loadAccountDevices()
  }, [])
  return result
}

function Glyph({ icon }: { icon: IconSvgElement }) {
  return <HugeiconsIcon icon={icon} size={24} strokeWidth={1.9} aria-hidden />
}

function Loading() {
  return (
    <div className="ui-sg-row" aria-busy="true">
      <span className="k-thing">
        <span className="k-mark">
          <Skel width={24} className="k-skel--mark" />
        </span>
        <span className="ui-sg-label k-lines">
          <Skel width={132} />
          <Skel width={64} />
        </span>
      </span>
    </div>
  )
}

/** In place of a list: loading, or the cloud out of reach; nothing while signed out. */
function ListState({ children }: { children: (devices: AccountDevices) => ReactNode }) {
  const { t } = useTranslation('huliAccount')
  const result = useAccountDevices()
  const loading = useAccountDevicesStore((s) => s.loading)
  if (result === null) return <Loading />
  if (result.state === 'signed_out') return null
  if (result.state === 'unavailable') {
    return (
      <RowLine text={<RowText name={t('state.unavailable')} />}>
        <SetButton loading={loading} onClick={() => void loadAccountDevices()}>
          {t('state.retry')}
        </SetButton>
      </RowLine>
    )
  }
  return <>{children(result.devices)}</>
}

/** This computer's registration, as the account's list has it. */
export function ThisComputerRow() {
  const { t } = useTranslation('huliAccount')
  const result = useAccountDevices()
  if (result === null) return <Loading />
  if (result.state !== 'ok') return null
  const own = result.devices.computers.find((c) => c.current) ?? null
  return (
    <RowLine
      text={
        <Thing
          mark={<DeviceTile icon={<Glyph icon={ComputerIcon} />} />}
          name={t('thisComputer.name')}
        >
          <ItemLine>
            {!own
              ? t('thisComputer.notRegistered')
              : own.pairable
                ? t('thisComputer.pairable')
                : t('thisComputer.notPairable')}
          </ItemLine>
          {own && <ItemLine>{t('thisComputer.registered', { id: own.id.slice(0, 8) })}</ItemLine>}
        </Thing>
      }
    >
      {own?.online && (
        <Pill tone="success">
          <OnlineDot />
          {t('thisComputer.online')}
        </Pill>
      )}
    </RowLine>
  )
}

function ComputerRow({ computer }: { computer: AccountComputer }) {
  const { t } = useTranslation('huliAccount')
  return (
    <div className="ui-sg-row">
      <Thing
        mark={<DeviceTile icon={<HostIcon platform={computer.platform ?? ''} />} />}
        name={<span className="k-name">{computer.name ?? t('computers.unnamed')}</span>}
      >
        <ItemLine>
          {computer.online
            ? t('computers.online')
            : t('computers.lastSeen', { when: longAgo(computer.lastSeen) })}
        </ItemLine>
      </Thing>
      <span className="ui-sg-control">
        {computer.current && <Pill>{t('computers.thisOne')}</Pill>}
        {computer.online && !computer.current && <OnlineDot />}
      </span>
    </div>
  )
}

/** The account's computers. */
export function AccountComputerList() {
  const { t } = useTranslation('huliAccount')
  return (
    <ListState>
      {({ computers }) => {
        if (computers.length === 0) {
          return <EmptyRow title={t('computers.empty')} hint={t('computers.emptyHint')} />
        }
        return computers.map((computer) => <ComputerRow key={computer.id} computer={computer} />)
      }}
    </ListState>
  )
}

const KIND_ICON: Record<AccountDevice['kind'], IconSvgElement> = {
  desktop: ComputerIcon,
  daemon: ComputerIcon,
  web: Globe02Icon,
  mobile: SmartPhone01Icon,
  other: ComputerIcon,
}

function DeviceRow({ device }: { device: AccountDevice }) {
  const { t } = useTranslation('huliAccount')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = device.name ?? t(`devices.kinds.${device.kind}`)
  const signOut = () => {
    setBusy(true)
    setError(null)
    revokeAccountDevice({ device: device.id }).then(
      () => setBusy(false),
      (e: unknown) => {
        setBusy(false)
        setError(t('state.failed', { reason: errorMessage(e) }))
      },
    )
  }
  return (
    <div className="ui-sg-row">
      <Thing
        mark={<DeviceTile icon={<Glyph icon={KIND_ICON[device.kind]} />} />}
        name={<span className="k-name">{name}</span>}
      >
        <ItemLine>
          {[
            t(`devices.kinds.${device.kind}`),
            device.os,
            t('devices.lastUsed', { when: longAgo(device.lastUsedAt) }),
          ]
            .filter(Boolean)
            .join(' · ')}
        </ItemLine>
      </Thing>
      <ControlError error={error} />
      <span className="ui-sg-control">
        {device.current ? (
          <Pill>{t('devices.thisOne')}</Pill>
        ) : (
          <SetButton
            loading={busy}
            aria-label={t('devices.signOutLabel', { name })}
            onClick={signOut}
          >
            {t('devices.signOut')}
          </SetButton>
        )}
      </span>
    </div>
  )
}

/** The account's signed-in devices, and signing every other out. */
export function AccountDeviceList() {
  return (
    <ListState>
      {({ devices }) => (
        <>
          {devices.map((device) => (
            <DeviceRow key={device.id} device={device} />
          ))}
          {devices.some((d) => !d.current) && <SignOutOthers />}
        </>
      )}
    </ListState>
  )
}

function SignOutOthers() {
  const { t } = useTranslation(['huliAccount', 'common'])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await revokeAccountDevice({ others: true })
      setOpen(false)
    } catch (e) {
      setError(t('state.failed', { reason: errorMessage(e) }))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="ui-sg-row">
      <span />
      <ControlError error={open ? null : error} />
      <span className="ui-sg-control">
        <DangerButton onClick={() => setOpen(true)}>{t('devices.others')}</DangerButton>
      </span>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent className={CONFIRM}>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('devices.othersTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('devices.othersBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p className="text-xs text-danger">{error}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void run()}>
              {t('devices.others')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
