// Huli: the 简洁视图's line for a turn's hidden steps (只看结论): how many there are, and a press
// shows the whole turn.

import { ViewOffSlashIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { Glyph } from '@renderer/features/shell/glyph'

export function HiddenSteps({ count, onShow }: { count: number; onShow: () => void }) {
  const { t } = useTranslation('session')
  return (
    <button
      type="button"
      onClick={onShow}
      className="group/hidden flex h-7 max-w-full items-center gap-2 rounded-md px-1.5 -mx-1.5 text-small text-tertiary outline-none transition-colors duration-(--duration-fast) hover:text-secondary focus-visible:focus-ring"
    >
      <Glyph icon={ViewOffSlashIcon} size={14} className="shrink-0" />
      <span className="truncate">{t('zen.hidden', { count })}</span>
      <span className="shrink-0 text-tertiary opacity-0 transition-opacity duration-(--duration-fast) group-hover/hidden:opacity-100 group-focus-visible/hidden:opacity-100">
        {t('zen.show')}
      </span>
    </button>
  )
}
