// Huli: Kite's report to a manager in its thread: each worker it reports on, how it went and its
// line, drawn from the report's data; the text the manager's agent read opens below.

import { useState } from 'react'
import {
  Alert02Icon,
  ArrowDown01Icon,
  CheckmarkCircle02Icon,
  Crown02Icon,
  StopCircleIcon,
} from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { DigestStatus } from '@shared/manager'
import type { FromSession, UserContent } from '@shared/thread'
import { Glyph } from '@renderer/features/shell/glyph'
import { cn } from '@renderer/lib/utils'
import { useSessionsStore } from '@renderer/stores/sessions'
import { openSession } from '@renderer/stores/view'
import './manager.css'

const GOOD: ReadonlySet<DigestStatus> = new Set(['done', 'approved', 'handed_back'])
const BAD: ReadonlySet<DigestStatus> = new Set([
  'failed',
  'blocked',
  'needs_user',
  'out_of_rounds',
  'review_failed',
  'asks',
])

function glyph(status: DigestStatus): IconSvgElement {
  if (GOOD.has(status)) return CheckmarkCircle02Icon
  if (BAD.has(status)) return Alert02Icon
  return StopCircleIcon
}

export function DigestCard({
  from,
  content,
  className,
}: {
  from: FromSession
  content: UserContent[]
  className?: string
}) {
  const { t } = useTranslation('session')
  const [open, setOpen] = useState(false)
  const items = from.digest ?? []
  const text = content.flatMap((item) => (item.type === 'text' ? [item.text] : [])).join('\n')
  return (
    <div className={cn('km-digest', className)} data-selectable="">
      <div className="km-digest__head">
        <Glyph icon={Crown02Icon} size={13} />
        <span>{t('manager.digest.title')}</span>
        <span className="flex-1" />
        <button
          type="button"
          className="flex items-center gap-1 hover:text-foreground"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {t('manager.digest.raw')}
          <Glyph icon={ArrowDown01Icon} size={12} className={cn(open && 'rotate-180')} />
        </button>
      </div>
      {items.map((item) => (
        <DigestRow key={item.sessionId} {...item} />
      ))}
      {open && <pre>{text}</pre>}
    </div>
  )
}

function DigestRow({
  sessionId,
  name,
  status,
  line,
  round,
  said,
}: {
  sessionId: string
  name: string
  status: DigestStatus
  line: string
  round?: number
  said?: string[]
}) {
  const { t } = useTranslation('session')
  const target = useSessionsStore((s) => s.byId[sessionId])
  return (
    <div className="km-digest__item">
      <Glyph
        icon={glyph(status)}
        size={13}
        className={cn(
          'shrink-0 self-center',
          GOOD.has(status) && 'text-success',
          BAD.has(status) && 'text-danger',
        )}
      />
      {target ? (
        <button type="button" onClick={() => openSession(target.id, target.projectPath)}>
          {name}
        </button>
      ) : (
        <b className="flex-none">{name}</b>
      )}
      <span className="flex-none text-muted-foreground">
        {t(`manager.status.${status}`, { round: round ?? 1 })}
      </span>
      {line && <span className="km-digest__line">{line}</span>}
      {said && said.length > 0 && (
        <span className="flex-none text-muted-foreground">
          {t('manager.digest.said', { count: said.length })}
        </span>
      )}
    </div>
  )
}
