// Huli: the controls of Settings › Keyboard shortcuts (shortcuts-section.tsx): a shortcut's keys
// with a recorder that takes the next keys pressed, refuses keys the app or the system keeps and
// keys another shortcut has, and goes back to its default; the global screenshot hotkey, off
// until set; and the keys that stay as they are. Keys follow the physical keyboard.

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DEFAULT_SHORTCUTS,
  keysOfEvent,
  keysProblem,
  sameKeys,
  screenshotKeysProblem,
  shortcutBindings,
  shortcutConflict,
  type KeysProblem,
  type ShortcutId,
} from '@shared/shortcuts'
import { Kbd } from '@renderer/components/ui/kbd'
import { isMac } from '@renderer/lib/platform'
import { HISTORY_SHORTCUTS } from '@renderer/app/history'
import { keyCaps } from '@renderer/features/shell/shortcuts'
import type { SettingsPatch } from '@shared/settings'
import { errorMessage } from '@renderer/lib/host'
import { useSettingsStore } from '@renderer/stores/settings'
import { ControlError, SetButton } from './controls'

// This computer's keys, whichever host the page shows the settings of, as the backup's rows do.
const useKeyboard = () => useSettingsStore((s) => s.settings.keyboard)

function useApply(): [(patch: SettingsPatch) => void, string | null] {
  const [error, setError] = useState<string | null>(null)
  const apply = (patch: SettingsPatch) => {
    setError(null)
    useSettingsStore
      .getState()
      .update(patch)
      .catch((failure: unknown) => setError(errorMessage(failure)))
  }
  return [apply, error]
}

/** The keys the app keeps as they are, which the page lists for what they do. */
const FIXED = [
  { action: 'back', keys: HISTORY_SHORTCUTS.back },
  { action: 'forward', keys: HISTORY_SHORTCUTS.forward },
  { action: 'history', keys: HISTORY_SHORTCUTS.all },
  { action: 'focusPane', keys: 'Mod+1-9' },
  { action: 'close', keys: 'Mod+W' },
  { action: 'zoomIn', keys: 'Mod+=' },
  { action: 'zoomOut', keys: 'Mod+-' },
  { action: 'resetZoom', keys: 'Mod+0' },
] as const

function Caps({ keys }: { keys: string }) {
  return (
    <span className="k-keys">
      {keyCaps(keys).map((cap, i) => (
        <Kbd key={i} className="h-5.5 min-w-5.5 rounded-tile px-1.5 text-small font-medium">
          {cap}
        </Kbd>
      ))}
    </span>
  )
}

/**
 * Takes the next keys pressed while it has the focus: Esc gives up, a modifier alone waits for a
 * key, and a key typed while an input method composes is left to it.
 */
function Recorder({
  label,
  onKeys,
  onCancel,
}: {
  label: string
  onKeys: (keys: string) => void
  onCancel: () => void
}) {
  const { t } = useTranslation('settings')
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => ref.current?.focus(), [])
  return (
    <button
      ref={ref}
      type="button"
      data-key-recorder
      className="k-key-recorder"
      aria-label={t('shortcuts.recordLabel', { name: label })}
      onBlur={onCancel}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        event.preventDefault()
        event.stopPropagation()
        if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey) {
          onCancel()
          return
        }
        const keys = keysOfEvent(event.nativeEvent, isMac)
        if (keys) onKeys(keys)
      }}
    >
      {t('shortcuts.recording')}
    </button>
  )
}

/** The words for keys refused, as the catalog of Settings has them. */
const PROBLEM_KEYS = {
  invalid: 'shortcuts.problem.invalid',
  modifier: 'shortcuts.problem.modifier',
  reserved: 'shortcuts.problem.reserved',
} as const satisfies Record<KeysProblem, string>

/** The modifiers a shortcut takes, as the problem's words name them. */
const MODIFIER_NAMES = { keys: isMac ? '⌘, ⌃, ⌥' : 'Ctrl, Alt' }

/** One shortcut's keys, its recorder, and Reset while it has keys of the user's. */
export function ShortcutControl({ id }: { id: ShortcutId }) {
  const { t } = useTranslation(['settings', 'shell'])
  const keyboard = useKeyboard()
  const custom = keyboard.shortcuts
  const bindings = shortcutBindings(custom)
  const [apply, error] = useApply()
  const [recording, setRecording] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const name = t(`shell:shortcuts.${id}`)
  const set = (keys: string | null) => {
    const next = { ...custom }
    if (keys === null || keys === DEFAULT_SHORTCUTS[id]) delete next[id]
    else next[id] = keys
    apply({ keyboard: { shortcuts: next } })
  }
  const take = (keys: string) => {
    const refused = keysProblem(keys, isMac)
    if (refused) {
      setProblem(t(PROBLEM_KEYS[refused], MODIFIER_NAMES))
      return
    }
    const other = shortcutConflict(bindings, id, keys, isMac)
    if (other) {
      setProblem(t('shortcuts.problem.taken', { name: t(`shell:shortcuts.${other}`) }))
      return
    }
    if (keyboard.screenshot && sameKeys(keyboard.screenshot, keys, isMac)) {
      setProblem(t('shortcuts.problem.taken', { name: t('shortcuts.screenshot.name') }))
      return
    }
    setProblem(null)
    setRecording(false)
    set(keys)
  }
  return (
    <>
      <ControlError error={problem ?? error} />
      {recording ? (
        <Recorder
          label={name}
          onKeys={take}
          onCancel={() => {
            setRecording(false)
            setProblem(null)
          }}
        />
      ) : (
        <Caps keys={bindings[id]} />
      )}
      {!recording && (
        <SetButton
          aria-label={t('shortcuts.changeLabel', { name })}
          onClick={() => setRecording(true)}
        >
          {t('shortcuts.change')}
        </SetButton>
      )}
      {!recording && custom[id] !== undefined && (
        <SetButton variant="ghost" onClick={() => set(null)}>
          {t('shortcuts.reset')}
        </SetButton>
      )}
    </>
  )
}

/** Huli: the global screenshot hotkey: off, or keys with two modifiers that work everywhere. */
export function ScreenshotControl() {
  const { t } = useTranslation(['settings', 'shell'])
  const keyboard = useKeyboard()
  const [apply, error] = useApply()
  const [recording, setRecording] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const take = (keys: string) => {
    const refused = screenshotKeysProblem(keys, isMac)
    if (refused) {
      setProblem(
        refused === 'modifier'
          ? t('shortcuts.problem.twoModifiers')
          : t(PROBLEM_KEYS[refused], MODIFIER_NAMES),
      )
      return
    }
    const other = shortcutConflict(shortcutBindings(keyboard.shortcuts), null, keys, isMac)
    if (other) {
      setProblem(t('shortcuts.problem.taken', { name: t(`shell:shortcuts.${other}`) }))
      return
    }
    setProblem(null)
    setRecording(false)
    apply({ keyboard: { screenshot: keys } })
  }
  return (
    <>
      <ControlError error={problem ?? error} />
      {recording ? (
        <Recorder
          label={t('shortcuts.screenshot.name')}
          onKeys={take}
          onCancel={() => {
            setRecording(false)
            setProblem(null)
          }}
        />
      ) : keyboard.screenshot ? (
        <Caps keys={keyboard.screenshot} />
      ) : (
        <span className="k-value">{t('shortcuts.screenshot.off')}</span>
      )}
      {!recording && (
        <SetButton onClick={() => setRecording(true)}>
          {keyboard.screenshot ? t('shortcuts.change') : t('shortcuts.screenshot.set')}
        </SetButton>
      )}
      {!recording && keyboard.screenshot && (
        <SetButton variant="ghost" onClick={() => apply({ keyboard: { screenshot: null } })}>
          {t('shortcuts.screenshot.turnOff')}
        </SetButton>
      )}
    </>
  )
}

/** The keys that stay as they are, each with what it does. */
export function FixedKeys() {
  const { t } = useTranslation('shell')
  return (
    <dl className="k-fixed-keys">
      {FIXED.map((row) => (
        <div key={row.action} className="k-fixed-keys__row">
          <dt>{t(`shortcuts.${row.action}`)}</dt>
          <dd>
            <Caps keys={row.keys} />
          </dd>
        </div>
      ))}
    </dl>
  )
}
