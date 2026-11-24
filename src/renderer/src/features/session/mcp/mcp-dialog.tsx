// Huli: MCP 服务器…, a session's MCP panel: the servers its agent has, each with its state, where it
// comes from and its tools; reconnect, off for the session and on again, and sign-in where the
// agent does them; Codex's apps beside them. Read when it opens, again when the session's agent
// says its servers changed and after each action here; never on a timer. Mounted once asked for.

import { useEffect, useRef, useState } from 'react'
import {
  ArrowDown01Icon,
  LinkSquare02Icon,
  MoreHorizontalIcon,
  PlugSocketIcon,
  RefreshIcon,
} from '@hugeicons/core-free-icons'
import { HugeiconsIcon } from '@hugeicons/react'
import { useTranslation } from 'react-i18next'
import type { SessionSummary } from '@shared/agent-host'
import {
  CHATGPT_APPS_URL,
  type SessionMcpAction,
  type SessionMcpApp,
  type SessionMcpServer,
  type SessionMcpState,
  type SessionMcpView,
} from '@shared/session-mcp'
import { Badge } from '@renderer/components/ui/badge'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { toast } from '@renderer/components/ui/toast'
import { useEntry } from '@renderer/lib/features'
import { errorMessage, host } from '@renderer/lib/host'
import { isWeb } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import { agentName } from '@renderer/stores/agents'
import { hostOfSession, sessionTitle } from '@renderer/stores/sessions'
import { openLinkIn } from '../open-link'
import { closeMcpPanel, reloadToast, useMcpPanelStore } from './mcp-panel'

/** How long the panel waits for a burst of changes, as servers start one after another. */
const CHANGE_SETTLE_MS = 250

const DOTS: Record<SessionMcpState, string> = {
  connected: 'bg-success',
  pending: 'bg-info',
  failed: 'bg-danger',
  'needs-auth': 'bg-warning',
  disabled: 'bg-border-strong',
  unknown: 'bg-border-strong',
}

const BADGES: Record<SessionMcpState, 'success' | 'info' | 'error' | 'warning' | 'neutral'> = {
  connected: 'success',
  pending: 'info',
  failed: 'error',
  'needs-auth': 'warning',
  disabled: 'neutral',
  unknown: 'neutral',
}

export function SessionMcpDialog() {
  const summary = useMcpPanelStore((s) => s.summary)
  const on = useEntry('sessionMenu.mcp')
  // Turned off in Settings › Features while open: the host refuses its reads from now on.
  useEffect(() => {
    if (!on) closeMcpPanel()
  }, [on])
  return (
    <Dialog open={on && summary !== null} onOpenChange={(open) => !open && closeMcpPanel()}>
      <DialogContent className="max-h-[min(720px,calc(100dvh-4rem))] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-xl">
        {summary && <McpPanel key={summary.id} summary={summary} />}
      </DialogContent>
    </Dialog>
  )
}

function McpPanel({ summary }: { summary: SessionSummary }) {
  const { t } = useTranslation('session')
  const changes = useMcpPanelStore((s) => s.changes)
  const logins = useMcpPanelStore((s) => s.logins)
  const focus = useMcpPanelStore((s) => s.focus)
  const [asked, setAsked] = useState(0)
  const [view, setView] = useState<SessionMcpView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // The server whose sign-in waits on the browser, and how many of its sign-ins had ended then.
  const [signing, setSigning] = useState<{ server: string; ended: number } | null>(null)
  const waiting = signing && (logins[signing.server] ?? 0) === signing.ended ? signing.server : null
  const agent = agentName(summary.agentId, hostOfSession(summary))
  const sessionId = summary.id

  // Read when it opens, on Refresh, and a moment after the agent's changes stop coming.
  useEffect(() => {
    let current = true
    const timer = setTimeout(
      () => {
        host('sessions.mcp', { sessionId }).then(
          (read) => {
            if (!current) return
            setView(read)
            setError(null)
          },
          (e: unknown) => {
            if (current) setError(errorMessage(e))
          },
        )
      },
      changes > 0 ? CHANGE_SETTLE_MS : 0,
    )
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [sessionId, changes, asked])

  const read = () => setAsked((n) => n + 1)

  // Claude Code says nothing when a sign-in in the browser ends: coming back to the window reads
  // the servers again, which tells a sign-in that ended. Only while one waits.
  useEffect(() => {
    if (waiting === null) return
    const back = () => {
      if (document.visibilityState === 'visible') setAsked((n) => n + 1)
    }
    window.addEventListener('focus', back)
    document.addEventListener('visibilitychange', back)
    return () => {
      window.removeEventListener('focus', back)
      document.removeEventListener('visibilitychange', back)
    }
  }, [waiting])

  const run = async (
    key: string,
    work: () => Promise<void>,
    failed?: (error: string) => string,
  ) => {
    setBusy(key)
    try {
      await work()
    } catch (e) {
      const error = errorMessage(e)
      toast(failed ? failed(error) : error, undefined, { tone: 'warning' })
      read()
    } finally {
      setBusy(null)
    }
  }

  const act = (action: SessionMcpAction, server: string | null) =>
    run(
      `${action}:${server ?? ''}`,
      async () => {
        setView(await host('sessions.mcpAct', { sessionId, action, server }))
      },
      (error) =>
        server === null
          ? t('mcp.failedAll', { error })
          : t(`mcp.failed.${action}`, { name: server, error }),
    )

  const signIn = (server: string) =>
    run(
      `login:${server}`,
      async () => {
        const ended = useMcpPanelStore.getState().logins[server] ?? 0
        const { url } = await host('sessions.mcpLogin', { sessionId, server })
        // Null: the agent needed no page after all, and says it ended as for any sign-in.
        if (url === null) return
        openLinkIn(url, 'browser', null)
        setSigning({ server, ended })
      },
      (error) => t('mcp.login.failed', { name: server, error }),
    )

  const reload = () =>
    run('reload', async () => {
      reloadToast(await host('sessions.reloadPlugins', { sessionId }), false)
      read()
    })

  const start = () =>
    run('start', async () => {
      await host('sessions.attachEarly', { sessionId })
      read()
    })

  return (
    <>
      <DialogHeader className="pr-8">
        <DialogTitle className="flex items-center gap-2">
          <HugeiconsIcon icon={PlugSocketIcon} size={18} strokeWidth={1.9} aria-hidden />
          {t('mcp.title')}
        </DialogTitle>
        <DialogDescription className="truncate">
          {t('mcp.subtitle', { agent, title: sessionTitle(summary) })}
        </DialogDescription>
      </DialogHeader>
      <div className="-mx-5 min-h-0 overflow-y-auto px-5">
        <Body
          view={view}
          error={error}
          agent={agent}
          busy={busy}
          waiting={waiting}
          focus={focus}
          onRetry={read}
          onAct={(action, server) => void act(action, server)}
          onSignIn={(server) => void signIn(server)}
          onStart={() => void start()}
        />
      </div>
      <DialogFooter className="items-center sm:justify-between">
        <Button
          variant="ghost"
          size="dialog"
          disabled={busy !== null}
          onClick={read}
          aria-label={t('mcp.refresh')}
        >
          <HugeiconsIcon icon={RefreshIcon} strokeWidth={1.9} />
          {t('mcp.refresh')}
        </Button>
        <span className="flex gap-1.5">
          {view?.can.reconnect === 'all' && view.servers.length > 0 && (
            <Button
              variant="outline"
              size="dialog"
              disabled={busy !== null}
              onClick={() => void act('reconnect', null)}
            >
              {busy === 'reconnect:' && <Spinner />}
              {t('mcp.reconnectAll')}
            </Button>
          )}
          {view?.can.reload && (
            <Button
              variant="outline"
              size="dialog"
              disabled={busy !== null}
              title={t('mcp.reload.hint')}
              onClick={() => void reload()}
            >
              {busy === 'reload' && <Spinner />}
              {t('mcp.reload.button')}
            </Button>
          )}
        </span>
      </DialogFooter>
    </>
  )
}

function Body({
  view,
  error,
  agent,
  busy,
  waiting,
  focus,
  onRetry,
  onAct,
  onSignIn,
  onStart,
}: {
  view: SessionMcpView | null
  error: string | null
  agent: string
  busy: string | null
  waiting: string | null
  focus: string | null
  onRetry: () => void
  onAct: (action: SessionMcpAction, server: string | null) => void
  onSignIn: (server: string) => void
  onStart: () => void
}) {
  const { t } = useTranslation('session')
  if (!view) {
    if (error) {
      return (
        <div role="alert" className="flex flex-col items-start gap-2 py-2">
          <p className="text-hint text-danger">{t('mcp.readFailed', { error })}</p>
          <Button variant="outline" size="dialog" onClick={onRetry}>
            {t('mcp.retry')}
          </Button>
        </div>
      )
    }
    return (
      <div className="flex flex-col gap-2 py-1" aria-busy>
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-9 w-full rounded-lg" />
        ))}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-3">
      {(error ?? view.error) && (
        <p role="alert" className="text-hint text-danger">
          {t('mcp.readFailed', { error: error ?? view.error })}
        </p>
      )}
      {!view.running ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-subtle px-3 py-2">
          <p className="text-hint text-muted-foreground">
            {view.can.start ? t('mcp.notRunningStart', { agent }) : t('mcp.notRunning', { agent })}
          </p>
          {view.can.start && (
            <Button variant="outline" size="dialog" disabled={busy !== null} onClick={onStart}>
              {busy === 'start' && <Spinner />}
              {t('mcp.start', { agent })}
            </Button>
          )}
        </div>
      ) : (
        !view.reported && (
          <p className="text-hint text-muted-foreground">{t('mcp.notReported', { agent })}</p>
        )
      )}
      {view.servers.length === 0 ? (
        <p className="py-4 text-center text-hint text-muted-foreground">
          {view.running ? t('mcp.none', { agent }) : t('mcp.noneKnown')}
        </p>
      ) : (
        <ul className="flex flex-col" aria-label={t('mcp.title')}>
          {view.servers.map((server) => (
            <ServerRow
              key={server.name}
              server={server}
              view={view}
              agent={agent}
              busy={busy}
              waiting={waiting === server.name}
              focused={focus === server.name}
              onAct={onAct}
              onSignIn={onSignIn}
            />
          ))}
        </ul>
      )}
      {view.apps && <Apps apps={view.apps} />}
    </div>
  )
}

function ServerRow({
  server,
  view,
  agent,
  busy,
  waiting,
  focused,
  onAct,
  onSignIn,
}: {
  server: SessionMcpServer
  view: SessionMcpView
  agent: string
  busy: string | null
  waiting: boolean
  /** A thread's notice opened the panel at this server. */
  focused: boolean
  onAct: (action: SessionMcpAction, server: string | null) => void
  onSignIn: (server: string) => void
}) {
  const { t } = useTranslation('session')
  const [open, setOpen] = useState(false)
  const { name, state, tools } = server
  const canLogin = view.can.login && state === 'needs-auth' && !isWeb
  const canReconnect = view.can.reconnect === 'server' && state !== 'disabled'
  const canToggle = view.can.toggle
  const off = state === 'disabled'
  const desktopApp = off && server.desktopApp === true
  const lasting = server.source !== 'kite'
  const source =
    server.source === 'plugin' && server.plugin
      ? t('mcp.source.pluginNamed', { name: server.plugin })
      : t(`mcp.source.${server.source}`)
  const acting = busy?.endsWith(`:${name}`) ?? false
  const row = useRef<HTMLLIElement>(null)

  useEffect(() => {
    if (focused) row.current?.scrollIntoView({ block: 'nearest' })
  }, [focused])

  return (
    <li
      ref={row}
      data-focused={focused ? '' : undefined}
      className={cn(
        'flex flex-col gap-1 border-b border-border-soft py-2 last:border-b-0',
        focused && '-mx-2 rounded-lg border-transparent bg-subtle px-2',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden className={cn('size-2 shrink-0 rounded-full', DOTS[state])} />
        <span className="min-w-0 truncate font-mono text-control text-foreground" title={name}>
          {name}
        </span>
        {tools !== null && <span className="sr-only">{t(`mcp.state.${state}`)}</span>}
        <Badge variant="neutral" className="shrink-0">
          {source}
        </Badge>
        <span className="flex-1" />
        {tools !== null ? (
          <Button
            variant="ghost"
            size="xs"
            aria-expanded={open}
            disabled={tools.length === 0}
            onClick={() => setOpen(!open)}
          >
            {t('mcp.tools', { count: tools.length })}
            {tools.length > 0 && (
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                strokeWidth={1.9}
                className={cn(
                  'transition-transform duration-(--duration-fast)',
                  open && 'rotate-180',
                )}
              />
            )}
          </Button>
        ) : (
          <Badge variant={BADGES[state]} className="shrink-0">
            {waiting ? t('mcp.login.waiting') : t(`mcp.state.${state}`)}
          </Badge>
        )}
        {canLogin && (
          <Button
            variant="outline"
            size="xs"
            disabled={busy !== null}
            onClick={() => onSignIn(name)}
          >
            {busy === `login:${name}` && <Spinner />}
            {waiting ? t('mcp.login.again') : t('mcp.login.button')}
          </Button>
        )}
        {desktopApp && (
          <Button
            variant="outline"
            size="xs"
            disabled={busy !== null}
            title={t('mcp.startAnywayHint')}
            onClick={() => onAct('enable', name)}
          >
            {busy === `enable:${name}` && <Spinner />}
            {t('mcp.startAnyway')}
          </Button>
        )}
        {state === 'failed' && canReconnect && (
          <Button
            variant="outline"
            size="xs"
            disabled={busy !== null}
            onClick={() => onAct('reconnect', name)}
          >
            {busy === `reconnect:${name}` && <Spinner />}
            {t('mcp.reconnect')}
          </Button>
        )}
        {(canReconnect || canToggle) && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={t('mcp.more', { name })}
                  disabled={busy !== null}
                />
              }
            >
              {acting ? <Spinner /> : <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={1.9} />}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              {canReconnect && (
                <DropdownMenuItem onClick={() => onAct('reconnect', name)}>
                  {t('mcp.reconnect')}
                </DropdownMenuItem>
              )}
              {canToggle &&
                (off ? (
                  <DropdownMenuItem onClick={() => onAct('enable', name)}>
                    {t('mcp.enable')}
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onClick={() => onAct('disable', name)}>
                    <span className="flex flex-col">
                      {lasting ? t('mcp.disableLasting') : t('mcp.disable')}
                      {lasting && (
                        <span className="text-caption text-muted-foreground">
                          {t('mcp.disableLastingHint', { agent })}
                        </span>
                      )}
                    </span>
                  </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {server.error && (
        <p className="pl-4 text-hint break-words text-danger" data-selectable="">
          {server.error}
        </p>
      )}
      {desktopApp && <p className="pl-4 text-hint text-muted-foreground">{t('mcp.desktopApp')}</p>}
      {state === 'needs-auth' && !canLogin && (
        <p className="pl-4 text-hint text-muted-foreground">{t('mcp.login.elsewhere')}</p>
      )}
      {waiting && (
        <p className="pl-4 text-hint text-muted-foreground">{t('mcp.login.inBrowser')}</p>
      )}
      {open && tools && tools.length > 0 && (
        <ul className="flex flex-wrap gap-1 pt-1 pl-4" aria-label={t('mcp.toolsOf', { name })}>
          {tools.map((tool) => (
            <li
              key={tool}
              className="rounded-md bg-subtle px-1.5 py-0.5 font-mono text-caption text-secondary"
            >
              {tool}
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

/** Codex's apps: the ChatGPT account's connectors, which are managed on ChatGPT. */
function Apps({ apps }: { apps: SessionMcpApp[] }) {
  const { t } = useTranslation('session')
  const manage = (url: string) => openLinkIn(url, 'browser', null)
  return (
    <section className="flex flex-col gap-1.5 pt-1" aria-label={t('mcp.apps.title')}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-hint font-medium text-muted-foreground">{t('mcp.apps.title')}</h3>
        {!isWeb && (
          <Button variant="ghost" size="xs" onClick={() => manage(CHATGPT_APPS_URL)}>
            {t('mcp.apps.manage')}
            <HugeiconsIcon icon={LinkSquare02Icon} strokeWidth={1.9} />
          </Button>
        )}
      </div>
      {apps.length === 0 ? (
        <p className="text-hint text-muted-foreground">{t('mcp.apps.none')}</p>
      ) : (
        <ul className="flex flex-col">
          {apps.map((app) => (
            <li
              key={app.id}
              className="flex min-w-0 items-center gap-2 border-b border-border-soft py-1.5 last:border-b-0"
            >
              <span className="min-w-0 truncate text-control text-foreground">{app.name}</span>
              {app.description && (
                <span className="min-w-0 flex-1 truncate text-hint text-muted-foreground">
                  {app.description}
                </span>
              )}
              <span className="flex-1" />
              {!app.enabled && <Badge variant="neutral">{t('mcp.apps.off')}</Badge>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
