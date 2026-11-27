import { useEffect, useState, type KeyboardEvent, type RefObject } from 'react'
import { ArrowDown01Icon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { bulkSplit, requestQueue, type QueuedRequest } from '@shared/permission-queue'
import { Button } from '@renderer/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover'
import { Spinner } from '@renderer/components/ui/spinner'
import { toast } from '@renderer/components/ui/toast'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { answeredBy } from '@renderer/features/session/entries/helpers'
import { RiskBadge } from '@renderer/features/session/entries/risk-badge'
import { KIND_GLYPH } from '@renderer/features/session/entries/tool-call-model'
import { Glyph } from '@renderer/features/shell/glyph'
import { errorMessage, host } from '@renderer/lib/host'
import { useOtherHosts } from '@renderer/stores/hosts'
import {
  hostOfSession,
  sessionTitle,
  useSessionsStore,
  type SessionNode,
} from '@renderer/stores/sessions'
import { requestText, type QuickAllow } from './quick-allow-model'
import { useQuickAllow, useRowActive } from './use-quick-allow'
import { rowWaitingSources, type WaitingSource } from './waiting'

type Tr = TFunction<['sidebar', 'session']>

/** How a row's tools make room: for 允许 alone, or with 全部允许's button beside it. */
export type QuickAllowRoom = 'one' | 'many'

/** Says why an answer did not go: answered somewhere first, or the host's error. */
function failed(t: Tr, error: unknown): void {
  const by = answeredBy(error)
  if (by !== undefined) {
    toast(
      by
        ? t('session:permission.answeredOn', { device: by.name })
        : t('session:permission.answeredInWindow'),
    )
    return
  }
  toast(t('quickAllow.failed', { error: errorMessage(error) }), undefined, { tone: 'warning' })
}

// The sidebar's arrows move between rows; inside a popup they stay its own.
const keepArrows = (event: KeyboardEvent): void => {
  if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) event.stopPropagation()
}

const riskText = (t: Tr, entry: QueuedRequest): string => {
  const risk = entry.permission.risk
  return risk
    ? `${t(`session:permission.risk.${risk.level}`)} · ${risk.reason}`
    : t('quickAllow.noRisk')
}

/** Where a row's wait is, when it is not the row's own session. */
const placeText = (t: Tr, source: WaitingSource | undefined): string | null =>
  !source || source.place === 'here'
    ? null
    : t(source.place === 'subagent' ? 'waiting.subagent' : 'waiting.subSession', {
        title: sessionTitle(source.summary),
      })

/**
 * Huli: 一键允许 in a Needs you row's tools. 允许 answers the oldest request of the session the
 * row's first wait is in with allow once, without opening it; its tooltip says what it allows and
 * how risky the host judged it. With two or more plain requests waiting there, a second button
 * lists them and offers 全部允许 as the thread's 全部同意 does, high ones left for the user. A row
 * whose oldest request is a question, a plan, a form or a high one gets neither.
 */
export function QuickAllowTools({
  row,
  rootId,
  count,
  onRoom,
  onOpenChange,
}: {
  /** The row, whose pointer and focus start the read. */
  row: RefObject<HTMLElement | null>
  rootId: string
  /** The row's waiting count. */
  count: number
  onRoom: (room: QuickAllowRoom | null) => void
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation(['sidebar', 'session'])
  const active = useRowActive(row)
  // The popover goes with the request it opened on: once that one is answered, it closes.
  const [openFor, setOpenFor] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const { allow, answered } = useQuickAllow(rootId, count, active || openFor !== null)
  const many = !!allow && allow.answered.length > 1
  const open = many && openFor === allow.head.permission.requestId
  const room = allow ? (many ? 'many' : 'one') : null

  useEffect(() => onRoom(room), [room, onRoom])
  useEffect(() => onOpenChange(open), [open, onOpenChange])

  const change = (next: boolean) =>
    setOpenFor(next && allow ? allow.head.permission.requestId : null)

  if (!allow) return null
  const { byId } = useSessionsStore.getState()
  const projectPath = byId[allow.sessionId]?.projectPath ?? ''
  const source = rowWaitingSources(byId, rootId, count).find(
    (s) => s.summary.id === allow.sessionId,
  )
  const where = placeText(t, source)
  const what = requestText(allow.head, projectPath)
  const risk = riskText(t, allow.head)

  const allowOne = async () => {
    if (busy) return
    const { requestId } = allow.head.permission
    setBusy(true)
    try {
      await host('permissions.respond', {
        sessionId: allow.sessionId,
        requestId,
        optionId: allow.optionId,
      })
      answered([requestId])
      change(false)
      toast(t('quickAllow.allowed', { what }), undefined, { tone: 'success' })
    } catch (error) {
      failed(t, error)
    } finally {
      setBusy(false)
    }
  }

  const allowAll = async () => {
    if (busy) return
    const requestIds = allow.answered.map((entry) => entry.permission.requestId)
    setBusy(true)
    try {
      const result = await host('permissions.respondAll', {
        sessionId: allow.sessionId,
        requestIds,
        decision: 'allow',
      })
      answered(result.answered)
      change(false)
      const left = allow.skipped.length + result.skipped.length
      toast(t('quickAllow.allowedAll', { count: result.answered.length }), undefined, {
        tone: 'success',
        ...(left > 0 ? { description: t('quickAllow.leftForYou', { count: left }) } : {}),
      })
    } catch (error) {
      failed(t, error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          delay={250}
          render={
            <button
              type="button"
              aria-label={t('quickAllow.label', { what, risk })}
              aria-busy={busy || undefined}
              disabled={busy}
              onClick={() => void allowOne()}
              className="ui-as-chat-row__tool kettu-quick-allow focus-ring"
            />
          }
        >
          {busy ? <Spinner className="size-3" /> : t('quickAllow.allow')}
        </TooltipTrigger>
        <TooltipContent
          side="right"
          sideOffset={8}
          className="max-w-72 flex-col items-start gap-1 py-1.5"
        >
          <span className="font-medium">{t('quickAllow.once')}</span>
          <span className="max-w-64 truncate font-mono" dir="auto">
            {what}
          </span>
          <span className="opacity-80">{risk}</span>
          {where && <span className="opacity-70">{where}</span>}
          {many && (
            <span className="opacity-60">
              {t('quickAllow.later', { count: allow.queue.length - 1 })}
            </span>
          )}
        </TooltipContent>
      </Tooltip>
      {many && (
        <Popover open={open} onOpenChange={change}>
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label={t('quickAllow.moreLabel', { count: allow.answered.length })}
                className="ui-as-chat-row__tool kettu-quick-allow__more focus-ring"
              />
            }
          >
            <Glyph icon={ArrowDown01Icon} size={12} />
          </PopoverTrigger>
          <PopoverContent
            side="right"
            align="start"
            sideOffset={8}
            className="kettu-allow-pop w-80"
            onKeyDown={keepArrows}
          >
            <AllowLists allow={allow} projectPath={projectPath} where={where} />
            <div className="kettu-allow-pop__buttons">
              <Button size="xs" variant="ghost" disabled={busy} onClick={() => void allowOne()}>
                {t('quickAllow.allowOldest')}
              </Button>
              <Button size="xs" disabled={busy} onClick={() => void allowAll()}>
                {t('quickAllow.allowAll', { count: allow.answered.length })}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      )}
    </>
  )
}

/** What 全部允许 answers in one session and what it leaves, as the popover lists them. */
function AllowLists({
  allow,
  projectPath,
  where,
}: {
  allow: QuickAllow
  projectPath: string
  where: string | null
}) {
  const { t } = useTranslation(['sidebar', 'session'])
  return (
    <>
      <p className="kettu-allow-pop__title">
        {t('quickAllow.listTitle', { count: allow.answered.length })}
      </p>
      {where && <p className="kettu-allow-pop__where">{where}</p>}
      <RequestList entries={allow.answered} projectPath={projectPath} />
      {allow.skipped.length > 0 && (
        <>
          <p className="kettu-allow-pop__title">{t('quickAllow.skippedTitle')}</p>
          <RequestList entries={allow.skipped} projectPath={projectPath} />
        </>
      )}
    </>
  )
}

function RequestList({
  entries,
  projectPath,
}: {
  entries: readonly QueuedRequest[]
  projectPath: string
}) {
  return (
    <ul className="kettu-allow-pop__list">
      {entries.map((entry) => {
        const risk = entry.permission.risk
        return (
          <li key={entry.id} className="kettu-allow-pop__row">
            <Glyph icon={KIND_GLYPH[entry.toolKind]} size={13} className="shrink-0" />
            <span className="kettu-allow-pop__what" dir="auto">
              {requestText(entry, projectPath)}
            </span>
            {risk && <RiskBadge level={risk.level} />}
          </li>
        )
      })}
    </ul>
  )
}

/** One session's part of the group's 全部允许. */
interface SessionPart {
  sessionId: string
  title: string
  hostId: string | null
  projectPath: string
  answered: QueuedRequest[]
  skipped: QueuedRequest[]
}

type GroupRead =
  | { state: 'loading' }
  | { state: 'ready'; parts: SessionPart[] }
  | { state: 'error'; message: string }

/** The sessions whose requests the rows count, each once. */
function waitingSessions(nodes: readonly SessionNode[]): WaitingSource[] {
  const { byId } = useSessionsStore.getState()
  const seen = new Set<string>()
  return nodes.flatMap((node) =>
    rowWaitingSources(byId, node.summary.id, node.permissionCount).filter((source) => {
      if (seen.has(source.summary.id)) return false
      seen.add(source.summary.id)
      return true
    }),
  )
}

async function readParts(nodes: readonly SessionNode[]): Promise<SessionPart[]> {
  const sources = waitingSessions(nodes)
  const parts = await Promise.all(
    sources.map(async ({ summary }) => {
      const { entries } = await host('sessions.requests', { sessionId: summary.id })
      const split = bulkSplit(requestQueue(entries), 'allow')
      return {
        sessionId: summary.id,
        title: sessionTitle(summary),
        hostId: hostOfSession(summary),
        projectPath: summary.projectPath,
        ...split,
      }
    }),
  )
  return parts.filter((part) => part.answered.length + part.skipped.length > 0)
}

/**
 * Huli: 全部允许 on Needs you's title, for the plain requests of every session it lists. It reads
 * them when chosen and lists what each session's allow once answers and what it leaves, as the
 * thread's 全部同意 confirms; nothing is sent before the confirming click.
 */
export function NeedsYouAllowAll({ nodes }: { nodes: readonly SessionNode[] }) {
  const { t } = useTranslation(['sidebar', 'session'])
  const others = useOtherHosts()
  const [open, setOpen] = useState(false)
  const [read, setRead] = useState<GroupRead>({ state: 'loading' })
  const [sending, setSending] = useState(false)

  const load = () => {
    setRead({ state: 'loading' })
    readParts(nodes).then(
      (parts) => setRead({ state: 'ready', parts }),
      (error: unknown) => setRead({ state: 'error', message: errorMessage(error) }),
    )
  }

  const hostName = (hostId: string | null): string =>
    hostId === null
      ? t('hosts.thisComputer')
      : (others.find((h) => h.id === hostId)?.name ?? t('hosts.unknown'))

  const parts = read.state === 'ready' ? read.parts : []
  const toAllow = parts.filter((part) => part.answered.length > 0)
  const total = toAllow.reduce((n, part) => n + part.answered.length, 0)
  const left = parts.filter((part) => part.skipped.length > 0)

  const confirm = async () => {
    if (sending || total === 0) return
    setSending(true)
    const results = await Promise.allSettled(
      toAllow.map((part) =>
        host('permissions.respondAll', {
          sessionId: part.sessionId,
          requestIds: part.answered.map((entry) => entry.permission.requestId),
          decision: 'allow',
        }),
      ),
    )
    setSending(false)
    setOpen(false)
    let answered = 0
    let failures = 0
    for (const result of results) {
      if (result.status === 'rejected') failures += 1
      else answered += result.value.answered.length
    }
    if (answered > 0) {
      toast(
        t('quickAllow.allowedAll', { count: answered }),
        undefined,
        failures > 0
          ? {
              tone: 'warning',
              description: t('quickAllow.groupFailed', { count: failures }),
            }
          : { tone: 'success' },
      )
    } else if (failures > 0) {
      toast(t('quickAllow.groupFailed', { count: failures }), undefined, { tone: 'warning' })
    } else {
      toast(t('quickAllow.groupNothing'))
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) load()
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={t('quickAllow.groupLabel')}
            className="kettu-needs-you-allow focus-ring"
          />
        }
      >
        {t('quickAllow.groupAllow')}
      </PopoverTrigger>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={8}
        className="kettu-allow-pop w-84"
        onKeyDown={keepArrows}
      >
        {read.state === 'loading' ? (
          <p className="kettu-allow-pop__status">
            <Spinner className="size-3" />
            {t('quickAllow.loading')}
          </p>
        ) : read.state === 'error' ? (
          <p role="alert" className="kettu-allow-pop__status text-danger">
            {t('quickAllow.failed', { error: read.message })}
          </p>
        ) : (
          <div className="kettu-allow-pop__scroll">
            {total > 0 ? (
              <>
                <p className="kettu-allow-pop__title">
                  {t('quickAllow.groupTitle', { count: total })}
                </p>
                {toAllow.map((part) => (
                  <SessionBlock
                    key={part.sessionId}
                    title={part.title}
                    hostName={hostName(part.hostId)}
                    entries={part.answered}
                    projectPath={part.projectPath}
                  />
                ))}
              </>
            ) : (
              <p className="kettu-allow-pop__title">{t('quickAllow.groupNone')}</p>
            )}
            {left.length > 0 && (
              <>
                <p className="kettu-allow-pop__title">{t('quickAllow.skippedTitle')}</p>
                {left.map((part) => (
                  <SessionBlock
                    key={part.sessionId}
                    title={part.title}
                    hostName={hostName(part.hostId)}
                    entries={part.skipped}
                    projectPath={part.projectPath}
                  />
                ))}
              </>
            )}
          </div>
        )}
        <div className="kettu-allow-pop__buttons">
          <Button size="xs" variant="ghost" disabled={sending} onClick={() => setOpen(false)}>
            {t('quickAllow.cancel')}
          </Button>
          {total > 0 && (
            <Button size="xs" disabled={sending} onClick={() => void confirm()}>
              {sending && <Spinner className="size-3" />}
              {t('quickAllow.groupDo', { count: total })}
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function SessionBlock({
  title,
  hostName,
  entries,
  projectPath,
}: {
  title: string
  hostName: string
  entries: readonly QueuedRequest[]
  projectPath: string
}) {
  return (
    <div className="kettu-allow-pop__session">
      <p className="kettu-allow-pop__where">
        <span className="min-w-0 truncate" dir="auto">
          {title}
        </span>
        <span className="shrink-0 opacity-70">{hostName}</span>
      </p>
      <RequestList entries={entries} projectPath={projectPath} />
    </div>
  )
}
