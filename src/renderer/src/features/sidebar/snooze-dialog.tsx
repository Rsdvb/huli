// Huli: 稍后提醒 › 自定义…: a day on the calendar and a time of day to snooze the sessions until,
// loaded the first time it is asked for.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { enUS, zhCN } from 'react-day-picker/locale'
import { MAX_SNOOZE_MS, MORNING_HOUR } from '@shared/session-tidy'
import { Button } from '@renderer/components/ui/button'
import { Calendar } from '@renderer/components/ui/calendar'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { backTime } from '@renderer/lib/format'
import { currentLocale } from '@renderer/lib/i18n'
import { useNow } from '@renderer/lib/use-now'
import { snoozeWithUndo, useSnoozeAsk } from './tidy'

const pad = (value: number): string => String(value).padStart(2, '0')
const isClock = (text: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(text)

/** The day at `time`, a local 'HH:mm', as an instant. */
function at(day: Date, time: string): number {
  const [hour, minute] = time.split(':').map(Number)
  const date = new Date(day)
  date.setHours(hour ?? 0, minute ?? 0, 0, 0)
  return date.getTime()
}

/** The first choice: tomorrow at the morning hour. */
function tomorrow(): Date {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  date.setHours(0, 0, 0, 0)
  return date
}

export function SnoozeDialog() {
  const { t } = useTranslation(['sidebar', 'common'])
  const ids = useSnoozeAsk((s) => s.ids)
  const open = ids.length > 0
  const [day, setDay] = useState(tomorrow)
  const [time, setTime] = useState(`${pad(MORNING_HOUR)}:00`)
  const [shownFor, setShownFor] = useState(ids)
  // Each time it opens it starts again from tomorrow morning.
  if (open && ids !== shownFor) {
    setShownFor(ids)
    setDay(tomorrow())
    setTime(`${pad(MORNING_HOUR)}:00`)
  }
  const now = useNow()
  const until = isClock(time) ? at(day, time) : null
  const valid = until !== null && until > now && until <= now + MAX_SNOOZE_MS
  const close = () => useSnoozeAsk.setState({ ids: [] })
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="sm:max-w-[340px]">
        <DialogHeader>
          <DialogTitle>{t('tidy.dialog.title')}</DialogTitle>
          <DialogDescription>{t('tidy.dialog.description')}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (!valid) return
            close()
            snoozeWithUndo(shownFor, until)
          }}
        >
          <Calendar
            mode="single"
            required
            selected={day}
            defaultMonth={day}
            disabled={{ before: today, after: new Date(now + MAX_SNOOZE_MS) }}
            locale={currentLocale() === 'zh-CN' ? zhCN : enUS}
            onSelect={(next: Date) => setDay(next)}
            className="self-center rounded-lg bg-subtle"
          />
          <label className="flex items-center justify-between gap-3 text-ui">
            <span className="text-secondary">{t('tidy.dialog.time')}</span>
            <Input
              type="time"
              value={time}
              onChange={(event) => setTime(event.target.value)}
              className="w-32 tabular-nums"
              required
            />
          </label>
          <p className="min-h-5 text-small text-tertiary" aria-live="polite">
            {until === null
              ? null
              : valid
                ? t('tidy.dialog.when', { time: backTime(until, now) })
                : t('tidy.dialog.past')}
          </p>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              {t('common:actions.cancel')}
            </Button>
            <Button type="submit" disabled={!valid}>
              {t('tidy.dialog.snooze')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
