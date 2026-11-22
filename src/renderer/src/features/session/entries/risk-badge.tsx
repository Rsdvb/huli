import { Alert02Icon, AlertDiamondIcon, SecurityCheckIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { RiskLevel } from '@shared/risk'
import { Icon } from '@renderer/components/affect/app-shell'

const GLYPH = { low: SecurityCheckIcon, medium: Alert02Icon, high: AlertDiamondIcon } as const

/** Huli: the level the host judged a request's risk at, as the card's tag. */
export function RiskBadge({ level }: { level: RiskLevel }) {
  const { t } = useTranslation('session')
  return (
    <span className="ui-prc__risk ks-risk" data-level={level}>
      <Icon icon={GLYPH[level]} size={11} />
      {t(`permission.risk.${level}`)}
    </span>
  )
}
