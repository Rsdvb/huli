import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import { BrowserIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import {
  acceleratorKeys,
  defaultStopShortcut,
  isStopShortcut,
  type ComputerApp,
  type ComputerPermission,
  type ComputerPermissionKind,
  ELEVATED_MODES,
  type ElevatedHelperChange,
  type ElevatedHelperState,
  type ElevatedMode,
} from '@shared/computer-use'
import { Icon } from '@renderer/components/affect/app-shell'
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
import { Kbd, KbdGroup } from '@renderer/components/ui/kbd'
import { Spinner } from '@renderer/components/ui/spinner'
import { errorMessage, host } from '@renderer/lib/host'
import { platform } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { useSettingsStore } from '@renderer/stores/settings'
import { ControlError, Pill, SetButton, SettingSelect, SettingSwitch } from './controls'
import { BlockLine, ItemLine, Thing } from './rows'

/**
 * Huli: whether agents may drive programs run as administrator: off (the default) or always.
 * Turning it on waits on a dialog that says what an agent outside a sandbox could do with it, and
 * nothing changes until the user confirms. The helper's install in Program Files is its own
 * step, only when the user chooses Install while it is on; Remove stays here whatever the setting,
 * since turning it off leaves the helper installed. With the setting off and nothing installed,
 * the host only looks at the installed program's place and starts no helper.
 */
export function ElevatedChoice({ text }: { text: ReactNode }) {
  const { t } = useTranslation('settings')
  const mode = useSettingsStore((s) => s.settings.computerUse.elevated)
  const [asking, setAsking] = useState<ElevatedMode | null>(null)
  const [state, setState] = useState<ElevatedHelperState | null>(null)
  const [busy, setBusy] = useState<'install' | 'remove' | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Asked again after each change of the setting, so turning it off offers removal.
  const [looked, setLooked] = useState(0)
  useEffect(() => {
    let gone = false
    host('computer.elevatedStatus', undefined).then(
      (answer) => !gone && setState(answer.state),
      () => !gone && setState(null),
    )
    return () => {
      gone = true
    }
  }, [looked])
  const save = (next: ElevatedMode) => {
    setError(null)
    useSettingsStore
      .getState()
      .update({ computerUse: { elevated: next } })
      .then(() => setLooked((n) => n + 1))
      .catch((caught: unknown) => setError(errorMessage(caught)))
  }
  const choose = (next: ElevatedMode) => {
    if (ELEVATED_MODES.indexOf(next) > ELEVATED_MODES.indexOf(mode)) setAsking(next)
    else save(next)
  }
  const change = async (what: 'install' | 'remove') => {
    setBusy(what)
    setError(null)
    try {
      const answer: ElevatedHelperChange = await host(
        what === 'install' ? 'computer.installElevated' : 'computer.uninstallElevated',
        undefined,
      )
      setState(answer.state)
      const done = what === 'install' ? answer.state === 'current' : answer.state === 'missing'
      if (done) return
      if (answer.cancelled) setError(t('computer.elevated.cancelled'))
      else if (answer.state !== 'tampered') {
        setError(t('computer.elevated.failed', { code: answer.exitCode ?? '?' }))
      }
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setBusy(null)
    }
  }
  const installed = state === 'current' || state === 'outdated' || state === 'tampered'
  const canInstall = mode !== 'off' && (state === 'missing' || state === 'outdated')
  const note =
    state === 'tampered'
      ? t('computer.elevated.tampered')
      : mode === 'off' && installed
        ? t('computer.elevated.leftInstalled')
        : state === 'outdated'
          ? t('computer.elevated.outdated')
          : state === 'missing' && mode !== 'off'
            ? t('computer.elevated.install.note')
            : null
  return (
    <>
      <BlockLine text={text}>
        <ControlError error={error} />
        <SettingSelect
          label={t('computer.elevated.name')}
          value={mode}
          disabled={busy !== null}
          options={ELEVATED_MODES.map((value) => ({
            value,
            label: t(`computer.elevated.mode.${value}`),
            hint: t(`computer.elevated.hint.${value}`),
            danger: value === 'always',
          }))}
          onChange={choose}
        />
      </BlockLine>
      {(note || installed || canInstall) && (
        <div className="k-block-note flex flex-wrap items-center gap-2">
          {note && <span className="min-w-0 flex-1">{note}</span>}
          {busy ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Spinner className="size-3.5" />
              {t('computer.elevated.waiting')}
            </span>
          ) : (
            <>
              {canInstall && (
                <SetButton size="sm" onClick={() => void change('install')}>
                  {state === 'missing'
                    ? t('computer.elevated.install.action')
                    : t('computer.elevated.reinstall')}
                </SetButton>
              )}
              {installed && (
                <SetButton size="sm" variant="ghost" onClick={() => void change('remove')}>
                  {t('computer.elevated.remove')}
                </SetButton>
              )}
            </>
          )}
        </div>
      )}
      <ElevatedConfirm
        mode={asking}
        onAnswer={(confirmed) => {
          const next = asking
          setAsking(null)
          if (confirmed && next) save(next)
        }}
      />
    </>
  )
}

/**
 * Asks before administrator use is turned on: an agent outside a sandbox runs as the user, so it can
 * take over the administrator prompt; what the design cannot fix; and that it is the user's call.
 */
export function ElevatedConfirm({
  mode,
  onAnswer,
}: {
  mode: ElevatedMode | null
  onAnswer: (confirmed: boolean) => void
}) {
  const { t } = useTranslation(['settings', 'common'])
  return (
    <AlertDialog open={mode !== null} onOpenChange={(next) => !next && onAnswer(false)}>
      <AlertDialogContent className="sm:max-w-[460px]">
        <AlertDialogHeader>
          <AlertDialogTitle>{t('computer.elevated.confirm.title')}</AlertDialogTitle>
          <AlertDialogDescription className="space-y-2">
            <span className="block">{t('computer.elevated.confirm.hijack')}</span>
            <span className="block">{t('computer.elevated.confirm.always')}</span>
            <span className="block">{t('computer.elevated.confirm.unfixed')}</span>
            <span className="block">{t('computer.elevated.confirm.yours')}</span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => onAnswer(true)}>
            {t('computer.elevated.confirm.allowAlways')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** The switch, on this computer's own settings whichever host the page shows. */
export function ComputerSwitch({
  label,
  setting = 'enabled',
}: {
  label: string
  setting?: 'enabled' | 'pauseOnUse' | 'allowForeground'
}) {
  const checked = useSettingsStore((s) => s.settings.computerUse[setting])
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <ControlError error={error} />
      <SettingSwitch
        label={label}
        checked={checked}
        onChange={(on) => {
          setError(null)
          useSettingsStore
            .getState()
            .update({ computerUse: { [setting]: on } })
            .catch((e: unknown) => setError(errorMessage(e)))
        }}
      />
    </>
  )
}

export function PermissionRow({
  kind,
  state,
  onChanged,
}: {
  kind: ComputerPermissionKind
  state: ComputerPermission
  onChanged: () => void
}) {
  const { t } = useTranslation('settings')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ask = async () => {
    setBusy(true)
    setError(null)
    try {
      await window.kettu.computer.requestPermission(kind)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
      onChanged()
    }
  }
  if (state === 'granted') return <Pill tone="success">{t('computer.permission.granted')}</Pill>
  return (
    <>
      <ControlError error={error} />
      <SetButton loading={busy} onClick={() => void ask()}>
        {state === 'denied' ? t('computer.permission.open') : t('computer.permission.ask')}
      </SetButton>
    </>
  )
}

export function AllowedAppRow({ app, onRemove }: { app: ComputerApp; onRemove: () => void }) {
  const { t } = useTranslation('settings')
  return (
    <div className="ui-sg-row">
      <Thing mark={<Icon icon={BrowserIcon} size={20} />} name={app.name}>
        <ItemLine>{app.id}</ItemLine>
      </Thing>
      <SetButton onClick={onRemove}>{t('computer.allowedApps.remove')}</SetButton>
    </div>
  )
}

const KEY_NAMES: Record<string, string> = {
  Period: '.',
  Comma: ',',
  Semicolon: ';',
  Quote: "'",
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Backquote: '`',
  Equal: '=',
  Minus: '-',
  Space: 'Space',
  Tab: 'Tab',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  Delete: 'Delete',
}

/** The pressed keys as an Electron accelerator, by the keys' places rather than what they type. */
function acceleratorOf(event: KeyboardEvent): string | null {
  const { code } = event
  const key = /^Key[A-Z]$/.test(code)
    ? code.slice(3)
    : /^Digit[0-9]$/.test(code)
      ? code.slice(5)
      : /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)
        ? code
        : KEY_NAMES[code]
  if (!key) return null
  const parts = [
    event.ctrlKey && 'Control',
    event.altKey && 'Alt',
    event.shiftKey && 'Shift',
    event.metaKey && (platform === 'darwin' ? 'Command' : 'Super'),
  ].filter((part): part is string => !!part)
  return [...parts, key].join('+')
}

/** Stop from anywhere: the shortcut's keys, which a click lets the user press anew. */
export function StopShortcut() {
  const { t } = useTranslation('settings')
  const saved = useSettingsStore((s) => s.settings.computerUse.stopShortcut)
  const fallback = defaultStopShortcut(platform)
  const shortcut = saved || fallback
  const [recording, setRecording] = useState(false)
  const [hint, setHint] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = (next: string) => {
    setError(null)
    useSettingsStore
      .getState()
      .update({ computerUse: { stopShortcut: next === fallback ? '' : next } })
      .catch((e: unknown) => setError(errorMessage(e)))
  }
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!recording) return
    event.preventDefault()
    event.stopPropagation()
    if (event.code === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      setRecording(false)
      setHint(false)
      return
    }
    const next = acceleratorOf(event)
    // Modifiers alone are on their way to a shortcut.
    if (!next) return
    if (!isStopShortcut(next)) {
      setHint(true)
      return
    }
    setRecording(false)
    setHint(false)
    save(next)
  }
  return (
    <>
      <ControlError
        error={
          error ??
          (hint
            ? t(
                platform === 'darwin'
                  ? 'computer.stopShortcut.invalidMac'
                  : 'computer.stopShortcut.invalid',
              )
            : null)
        }
      />
      <div className="flex items-center gap-2">
        {saved && saved !== fallback && !recording && (
          <SetButton variant="ghost" onClick={() => save(fallback)}>
            {t('computer.stopShortcut.reset')}
          </SetButton>
        )}
        <button
          type="button"
          aria-label={t('computer.stopShortcut.change')}
          title={t('computer.stopShortcut.change')}
          onClick={() => {
            setRecording((now) => !now)
            setHint(false)
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            setRecording(false)
            setHint(false)
          }}
          className={cn(
            'flex h-7 items-center rounded-md px-1 outline-none focus-ring',
            recording && 'bg-(--bg-selected)',
          )}
        >
          {recording ? (
            <span className="px-1.5 text-small text-secondary">
              {t('computer.stopShortcut.recording')}
            </span>
          ) : (
            <KbdGroup>
              {acceleratorKeys(shortcut, platform).map((key, index) => (
                <Kbd key={index}>{key}</Kbd>
              ))}
            </KbdGroup>
          )}
        </button>
      </div>
    </>
  )
}
