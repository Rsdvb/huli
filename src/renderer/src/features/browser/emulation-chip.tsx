import { Cancel01Icon, SmartPhone01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { BrowserEmulation } from '@shared/browser-args'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { PaneIcon } from '@renderer/features/shell/panel-button'

/**
 * Huli: under the address, while the shown tab emulates anything (browser_emulate): what it
 * emulates, and one click to turn it all off.
 */
export function EmulationChip({
  emulation,
  onReset,
}: {
  emulation: BrowserEmulation
  onReset: () => void
}) {
  const { t } = useTranslation('browser')
  const parts: string[] = []
  const { device, network } = emulation
  if (device) {
    parts.push(
      device.label ?? t('emulation.viewport', { width: device.width, height: device.height }),
    )
  }
  if (emulation.colorScheme === 'light') parts.push(t('emulation.scheme.light'))
  if (emulation.colorScheme === 'dark') parts.push(t('emulation.scheme.dark'))
  if (emulation.reducedMotion === 'reduce') parts.push(t('emulation.reducedMotion'))
  if (emulation.reducedMotion === 'no-preference') parts.push(t('emulation.motion'))
  if (emulation.locale) parts.push(emulation.locale)
  if (emulation.timezone) parts.push(emulation.timezone)
  if (emulation.geolocation) parts.push(t('emulation.location'))
  if (network?.offline) parts.push(t('emulation.offline'))
  else if (network?.preset === 'slow-3g') parts.push(t('emulation.network.slow-3g'))
  else if (network?.preset === 'fast-3g') parts.push(t('emulation.network.fast-3g'))
  else if (network?.preset === '4g') parts.push(t('emulation.network.4g'))
  else if (network) parts.push(t('emulation.throttled'))
  const text = parts.join(' · ')
  return (
    <div role="status" className="kp-emu" data-emulation="">
      <Tooltip>
        <TooltipTrigger render={<span className="kp-emu__text" />}>
          <PaneIcon icon={SmartPhone01Icon} size={13} />
          <span className="truncate">{t('emulation.chip', { what: text })}</span>
        </TooltipTrigger>
        <TooltipContent>{t('emulation.hint', { what: text })}</TooltipContent>
      </Tooltip>
      <button type="button" className="kp-emu__reset" onClick={onReset}>
        <PaneIcon icon={Cancel01Icon} size={12} />
        {t('emulation.reset')}
      </button>
    </div>
  )
}
