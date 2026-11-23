import { useState } from 'react'
import { PlayIcon, ServerStack01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { launchUrl, type LaunchConfig } from '@shared/launch-configs'
import { originLabel } from '@shared/browser'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { toast } from '@renderer/components/ui/toast'
import { PaneIcon, PaneSpinner } from '@renderer/features/shell/panel-button'
import { errorMessage } from '@renderer/lib/host'
import { startPreset } from './launch-configs'

/**
 * Huli: the dev servers `.claude/launch.json` names, each with Start, which runs its command in a
 * terminal of the session and opens its page.
 */
export function LaunchPresets({
  sessionId,
  configs,
  onOpen,
  onStarted,
}: {
  sessionId: string
  configs: LaunchConfig[]
  onOpen: (url: string) => void
  onStarted?: () => void
}) {
  const { t } = useTranslation('browser')
  const [starting, setStarting] = useState<string | null>(null)
  const start = (config: LaunchConfig) => {
    setStarting(config.name)
    startPreset(sessionId, config, onOpen)
      .then(() => onStarted?.())
      .catch((error: unknown) => toast(errorMessage(error), undefined, { tone: 'warning' }))
      .finally(() => setStarting(null))
  }
  return (
    <div className="kp-presets">
      <span className="kp-presets__label">{t('presets.title')}</span>
      <ul className="kp-presets__list">
        {configs.map((config) => (
          <li key={config.name} className="kp-presets__row">
            <span className="kp-presets__name">
              <span className="truncate">{config.name}</span>
              <span className="kp-presets__where truncate" title={config.command}>
                {originLabel(launchUrl(config)).replace(/\/$/, '')}
              </span>
            </span>
            <button
              type="button"
              className="kp-btn kp-btn--sm"
              disabled={starting !== null}
              onClick={() => start(config)}
            >
              {starting === config.name ? <PaneSpinner /> : <PaneIcon icon={PlayIcon} size={12} />}
              {t('presets.start')}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Huli: the address row's dev servers, while the session's folder names any. */
export function LaunchPresetsButton({
  sessionId,
  configs,
  onOpen,
}: {
  sessionId: string
  configs: LaunchConfig[]
  onOpen: (url: string) => void
}) {
  const { t } = useTranslation('browser')
  const [open, setOpen] = useState(false)
  const label = t('presets.button')
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={label}
            title={label}
            className="kp-tool app-region-no-drag"
          />
        }
      >
        <PaneIcon icon={ServerStack01Icon} />
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-80 max-w-[calc(100vw-32px)] p-3">
        <LaunchPresets
          sessionId={sessionId}
          configs={configs}
          onOpen={onOpen}
          onStarted={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  )
}
