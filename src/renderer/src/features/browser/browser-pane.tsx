import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react'
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  ComputerIcon,
  Globe02Icon,
  LinkSquare02Icon,
  ReloadIcon,
  SmartPhone01Icon,
  Tablet01Icon,
} from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import {
  fitViewport,
  PAGE_SIZE_NAMES,
  PAGE_SIZES,
  SIZE_LINE_ROOM,
  type BrowserNotice,
  type BrowserViewport,
  type PageSize,
  type PageSizeName,
} from '@shared/browser'
import { onAppEvent } from '@renderer/app/events'
import { useControlAgent } from '@renderer/components/control/use-control-agent'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@renderer/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { PaneBody, PaneEmpty, PaneIcon, PanelButton } from '@renderer/features/shell/panel-button'
import { hostOfPath } from '@renderer/lib/host-paths'
import { isMac } from '@renderer/lib/platform'
import { agentName } from '@renderer/stores/agents'
import { useSessionsStore } from '@renderer/stores/sessions'
import { useBrowserStore } from '@renderer/stores/browser'
import { useOpenOverlays, useOverlayStore } from '@renderer/stores/overlays'
import { useSettingsStore } from '@renderer/stores/settings'
import { panelSession } from '@renderer/stores/view'
import { AddressField } from './address-field'
import { OriginBar } from './origin-bar'
import { startPicking, stopPicking } from './pick'
import { PortsButton } from '@renderer/features/ports/ports-button'
import { openOnHost } from '@renderer/features/ports/ports'
import { useEntry } from '@renderer/lib/features'
import { BringSignInsOffer, SignInChip } from './sign-in-offer'
import { EmulationChip } from './emulation-chip'
import { DownloadBar } from './download-bar'
import { BrowserDataButton } from './browser-data'
import { LaunchPresets, LaunchPresetsButton } from './launch-presets'
import { useLaunchConfigs } from './launch-configs'

// Huli: pick mode's code loads only while the feature is on (Settings > Features).
const pickMode = () => import('./pick-mode')
const PickHint = lazy(() => pickMode().then((m) => ({ default: m.PickHint })))
const PickLayer = lazy(() => pickMode().then((m) => ({ default: m.PickLayer })))
const PickToggle = lazy(() => pickMode().then((m) => ({ default: m.PickToggle })))
const PickTray = lazy(() => pickMode().then((m) => ({ default: m.PickTray })))

/**
 * What a page's tab shows in the side panel: the context bar with its navigation and address,
 * and the selected tab's page, drawn by main over the page area.
 */
export function BrowserPane({ panel, maximized }: { panel: string; maximized: boolean }) {
  const { t } = useTranslation(['browser', 'common'])
  const sessionId = panelSession(panel)
  const pickOn = useEntry('browser.pick')
  const portsOn = useEntry('browser.ports')
  // The session pick mode serves, none while it is off.
  const pickId = pickOn ? sessionId : null
  const state = useBrowserStore((s) => (sessionId ? s.bySession[sessionId] : undefined))
  const still = useBrowserStore((s) => (sessionId ? s.stills[sessionId] : undefined))
  const hidden = useBrowserStore((s) => (sessionId ? !!s.unseen[sessionId] : false))
  const picked = useBrowserStore((s) => (sessionId ? s.picked[sessionId] : undefined))
  const agentId = useSessionsStore((s) => (sessionId ? s.byId[sessionId]?.agentId : null)) ?? null
  const hostId = useSessionsStore((s) =>
    sessionId ? hostOfPath(s.byId[sessionId]?.projectPath ?? '') : null,
  )
  // Huli: the worktree a session of this computer works in, whose browser data may be its own.
  const worktree = useSessionsStore((s) => {
    const summary = sessionId ? s.byId[sessionId] : undefined
    const tree = summary?.worktree
    if (!tree || tree.path === '' || tree.state === 'removed' || tree.state === 'gone') return null
    return hostOfPath(summary.projectPath) === null ? tree.path : null
  })
  const agent = useControlAgent(agentId, hostId)
  // Huli: the dev servers the session's folder names in .claude/launch.json.
  const presets = useLaunchConfigs(sessionId)
  const overlays = useOpenOverlays()
  const showsPage = !!state && !!(state.url || state.page)
  const zoom = useSettingsStore((s) => s.settings.appearance.zoom)
  // The frame the page fills.
  const page = useRef<HTMLDivElement>(null)
  const address = useRef<HTMLInputElement>(null)
  // The session the pane shows, so a capture that lands after the pane left it is dropped.
  const live = useRef<string | null>(null)
  const name = agentId ? agentName(agentId, hostId) : t('empty.agent')

  // The pane shows the page, so the toggle's dot has done its work.
  useEffect(() => {
    if (sessionId) useBrowserStore.getState().seen(sessionId)
  }, [sessionId, hidden])

  const newTab = useCallback(() => {
    if (!sessionId) return
    void window.kettu.browser
      .newTab(sessionId)
      .catch((error: unknown) => console.error('Could not open a tab', error))
  }, [sessionId])

  // Mod+T opens a tab; Mod+L in the page goes to its address. Mod+W is the row's.
  useEffect(
    () =>
      onAppEvent((event) => {
        if (event.kind === 'focus-browser-address') {
          if (event.sessionId === sessionId) address.current?.focus()
        } else if (event.kind === 'new-browser-tab') newTab()
      }),
    [newTab, sessionId],
  )

  const navigate = (url: string) => {
    if (!sessionId) return
    // Huli: another host's localhost opens through a forward to it, as its agent's pages do.
    if (hostId !== null && portsOn && openOnHost(hostId, sessionId, url)) return
    void window.kettu.browser.navigate(sessionId, url)
  }

  useEffect(() => {
    if (sessionId) void window.kettu.browser.setWorktree(sessionId, worktree).catch(() => {})
  }, [sessionId, worktree])

  // Main shows the session's page while the pane is open, and keeps it while the pane is hidden;
  // the pill on the page names the session's agent.
  useEffect(() => {
    if (!sessionId) return
    void window.kettu.browser.show(sessionId, agent)
    return () => {
      void window.kettu.browser.hide(sessionId)
    }
  }, [sessionId, agent])

  // The page's frame, in the window's own pixels: the renderer's zoom scales CSS pixels. Main
  // rounds the page's corners as the frame's are, since nothing in the renderer can clip a view.
  const report = useCallback(() => {
    const element = page.current
    if (!element || !sessionId) return
    const rect = element.getBoundingClientRect()
    // With no page there is no frame; the page keeps the last one until it comes back.
    if (rect.width === 0 || rect.height === 0) return
    const radius = parseFloat(getComputedStyle(element).borderBottomLeftRadius) || 0
    void window.kettu.browser.setBounds(sessionId, {
      x: Math.round(rect.left * zoom),
      y: Math.round(rect.top * zoom),
      width: Math.round(rect.width * zoom),
      height: Math.round(rect.height * zoom),
      radius: Math.round(radius * zoom),
    })
  }, [sessionId, zoom])

  // An overlay that covers the page takes a still in its place: a web view is a native layer the
  // renderer cannot draw over. Whether one covers it depends on where the overlays and the page's
  // frame are, so the check runs whenever an overlay opens or closes, since one that covers the
  // page can open while another is already open, and whenever the frame moves or resizes, since a
  // side panel opening or a pane maximizing brings the page under an overlay that stays up.
  const coverCheck = useRef(0)
  const checkCover = useCallback(() => {
    cancelAnimationFrame(coverCheck.current)
    if (!sessionId) return
    const thaw = () => {
      if (!useBrowserStore.getState().stills[sessionId]) return
      // The still holds a picked element's comment, which ends it itself.
      if (useBrowserStore.getState().picked[sessionId]) return
      void window.kettu.browser.thaw(sessionId).finally(() => {
        useBrowserStore.getState().setStill(sessionId, null)
      })
    }
    if (Object.keys(useOverlayStore.getState().open).length === 0) {
      thaw()
      return
    }
    coverCheck.current = requestAnimationFrame(() => {
      const area = page.current
      if (!area || !covers(area)) {
        thaw()
        return
      }
      void window.kettu.browser
        .freeze(sessionId)
        .then((image) => {
          if (!image) return
          // Overlays may open and close while the page is captured, and a later check finds the
          // page already frozen, so whether to keep the still is decided by what covers it now.
          const now = page.current
          if (live.current === sessionId && now && covers(now)) {
            useBrowserStore.getState().setStill(sessionId, image)
          } else {
            void window.kettu.browser.thaw(sessionId).finally(() => {
              useBrowserStore.getState().setStill(sessionId, null)
            })
          }
        })
        .catch(() => {})
    })
  }, [sessionId])

  const frameChanged = useCallback(() => {
    report()
    checkCover()
  }, [report, checkCover])

  // A notice, the address row or the origin card moves the page's frame without resizing it.
  useLayoutEffect(frameChanged)

  // The frame is another element once the pane has a page, which the observer must follow: the
  // pick mode's hint and the comments under the page resize it without this pane rendering again.
  useLayoutEffect(() => {
    const element = page.current
    if (!element) return
    const observer = new ResizeObserver(frameChanged)
    observer.observe(element)
    window.addEventListener('resize', frameChanged)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', frameChanged)
    }
  }, [frameChanged, showsPage])

  useEffect(() => {
    checkCover()
    return () => cancelAnimationFrame(coverCheck.current)
  }, [checkCover, overlays, maximized])

  // Huli: leaving the pane or its session ends pick mode.
  useEffect(() => {
    if (!sessionId) return
    return () => stopPicking(sessionId)
  }, [sessionId])

  // Huli: a picked element's comment opens over the still of the page the pick carries, main having
  // hidden the page; once it closes the page comes back, and picking goes on while the mode is on.
  useEffect(() => {
    if (!sessionId || !picked) return
    useBrowserStore.getState().setStill(sessionId, picked.still)
    return () => {
      void window.kettu.browser.thaw(sessionId).finally(() => {
        useBrowserStore.getState().setStill(sessionId, null)
        if (useBrowserStore.getState().picking[sessionId]) void startPicking(sessionId)
      })
    }
  }, [picked, sessionId])

  // Leaving the pane or its session drops a still that is no longer in front of anything.
  useEffect(() => {
    if (!sessionId) return
    live.current = sessionId
    return () => {
      live.current = null
      if (!useBrowserStore.getState().stills[sessionId]) return
      void window.kettu.browser.thaw(sessionId)
      useBrowserStore.getState().setStill(sessionId, null)
    }
  }, [sessionId])

  const url = state?.url ?? null
  const agentHasPage = state?.control.kind === 'agent' && state.selected === state.agentTab

  return (
    <PaneBody data-browser-panel="">
      <div className="kp-body">
        {/* A page without an address, such as a popup still at about:blank, is on screen too. */}
        {state && (url || state.page) ? (
          <>
            <div className="kp-ctx kp-addr-row">
              <PanelButton
                label={t('actions.back')}
                shortcut={isMac ? '⌘[' : 'Ctrl+['}
                disabled={!state.canGoBack}
                onClick={() => sessionId && void window.kettu.browser.back(sessionId)}
              >
                <PaneIcon icon={ArrowLeft01Icon} />
              </PanelButton>
              <PanelButton
                label={t('actions.forward')}
                shortcut={isMac ? '⌘]' : 'Ctrl+]'}
                disabled={!state.canGoForward}
                onClick={() => sessionId && void window.kettu.browser.forward(sessionId)}
              >
                <PaneIcon icon={ArrowRight01Icon} />
              </PanelButton>
              {state.loading ? (
                <PanelButton
                  label={t('actions.stop')}
                  onClick={() => sessionId && void window.kettu.browser.stop(sessionId)}
                >
                  <PaneIcon icon={Cancel01Icon} />
                </PanelButton>
              ) : (
                <PanelButton
                  label={t('actions.reload')}
                  shortcut={isMac ? '⌘R' : 'Ctrl+R'}
                  onClick={() => sessionId && void window.kettu.browser.reload(sessionId)}
                >
                  <PaneIcon icon={ReloadIcon} />
                </PanelButton>
              )}
              <AddressField
                key={state.selected}
                ref={address}
                url={url}
                onNavigate={navigate}
                trailing={
                  <SignInChip
                    url={url}
                    sessionId={sessionId}
                    hidden={state.control.kind === 'agent' && state.selected === state.agentTab}
                  />
                }
              />
              {pickId && (
                <Suspense fallback={null}>
                  <PickToggle sessionId={pickId} disabled={agentHasPage} />
                </Suspense>
              )}
              {sessionId && hostId !== null && portsOn && (
                <PortsButton hostId={hostId} sessionId={sessionId} />
              )}
              {sessionId && presets.length > 0 && (
                <LaunchPresetsButton sessionId={sessionId} configs={presets} onOpen={navigate} />
              )}
              {sessionId && (
                <BrowserDataButton
                  sessionId={sessionId}
                  profile={state.profile}
                  canSave={!!url && !agentHasPage}
                />
              )}
              {sessionId && (
                <PageSizeMenu
                  sessionId={sessionId}
                  viewport={state.viewport}
                  fills={!state.agentUsed}
                />
              )}
              <PanelButton
                label={t('actions.openExternal')}
                disabled={!url}
                onClick={() => sessionId && void window.kettu.browser.openExternal(sessionId)}
              >
                <PaneIcon icon={LinkSquare02Icon} />
              </PanelButton>
              {state.loading && (
                <span role="progressbar" aria-label={t('loading')} className="kp-load" />
              )}
            </div>
            {sessionId && state.originRequest && (
              <OriginBar
                request={state.originRequest}
                agent={agentId}
                hostId={hostId}
                agentName={agentId ? agentName(agentId, hostId) : ''}
                onAnswer={(decision) =>
                  void window.kettu.browser.answerOrigin(
                    sessionId,
                    state.originRequest!.id,
                    decision,
                  )
                }
              />
            )}
            {sessionId && state.emulation && (
              <EmulationChip
                emulation={state.emulation}
                onReset={() => void window.kettu.browser.resetEmulation(sessionId)}
              />
            )}
            {sessionId && state.downloadRequest && (
              <DownloadBar
                key={state.downloadRequest.id}
                request={state.downloadRequest}
                onAnswer={(allow) =>
                  void window.kettu.browser.answerDownload(
                    sessionId,
                    state.downloadRequest!.id,
                    allow,
                  )
                }
              />
            )}
            {state.notice && <Notice notice={state.notice} sessionId={sessionId} />}
            {pickId && (
              <Suspense fallback={null}>
                <PickHint sessionId={pickId} />
              </Suspense>
            )}
            <div ref={page} className="kp-view" data-fitted={state.viewport ? '' : undefined}>
              {state.viewport ? (
                <FittedPage frame={page} viewport={state.viewport} zoom={zoom} still={still} />
              ) : (
                still && <img src={still} alt="" aria-hidden className="kp-view__still" />
              )}
              {/* Huli: a picked element's layer draws over the still at the frame's own size, so a
                  page kept at a size of its own, scaled into the frame, offers none. */}
              {pickId && picked && still && !state.viewport && (
                <Suspense fallback={null}>
                  <PickLayer sessionId={pickId} pick={picked} hostId={hostId} zoom={zoom} />
                </Suspense>
              )}
            </div>
            {pickId && (
              <Suspense fallback={null}>
                <PickTray sessionId={pickId} />
              </Suspense>
            )}
          </>
        ) : (
          <>
            <PaneEmpty
              icon={<PaneIcon icon={Globe02Icon} size={20} />}
              title={sessionId ? t('empty.title') : t('empty.noSession')}
              text={sessionId ? t('empty.hint', { agent: name }) : t('empty.noSessionHint')}
            >
              {sessionId && (
                <div className="kp-addr-row kp-addr-row--empty">
                  <AddressField
                    key={state?.selected ?? ''}
                    ref={address}
                    url={null}
                    onNavigate={navigate}
                    autoFocus
                  />
                </div>
              )}
              {sessionId && presets.length > 0 && (
                <LaunchPresets sessionId={sessionId} configs={presets} onOpen={navigate} />
              )}
              {sessionId && <BringSignInsOffer />}
            </PaneEmpty>
            {/* Main keeps a closed page's view hidden, but still needs a place for the next one. */}
            <div ref={page} hidden />
          </>
        )}
      </div>
    </PaneBody>
  )
}

const SIZE_ICONS = { desktop: ComputerIcon, tablet: Tablet01Icon, phone: SmartPhone01Icon }

/**
 * The size of the selected tab's page. Desktop lets a page no agent used fill the pane, and keeps
 * one an agent used at the agent's size; a size the agent gave itself shows as custom.
 */
function PageSizeMenu({
  sessionId,
  viewport,
  fills,
}: {
  sessionId: string
  viewport: PageSize | null
  /** At the desktop's size the page fills the pane, as one no agent used does. */
  fills: boolean
}) {
  const { t } = useTranslation('browser')
  const chosen = viewport?.name ?? 'desktop'
  const label = t('viewport.menu')
  const choose = (value: unknown) => {
    if (!(PAGE_SIZE_NAMES as readonly unknown[]).includes(value) || value === chosen) return
    void window.kettu.browser
      .setPageSize(sessionId, value as PageSizeName)
      .catch((error: unknown) => console.error('Could not resize the page', error))
  }
  const sizeOf = (size: BrowserViewport) =>
    t('viewport.size', { width: size.width, height: size.height })
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <button type="button" aria-label={label} className="kp-tool app-region-no-drag" />
              }
            />
          }
        >
          <PaneIcon icon={chosen === 'custom' ? ComputerIcon : SIZE_ICONS[chosen]} />
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={chosen} onValueChange={choose}>
            {PAGE_SIZE_NAMES.map((name) => (
              <DropdownMenuRadioItem key={name} value={name}>
                <PaneIcon icon={SIZE_ICONS[name]} size={16} />
                <span className="min-w-0 flex-1 truncate">{t(`viewport.${name}`)}</span>
                <span className="shrink-0 text-small text-tertiary tabular-nums">
                  {name === 'desktop' && fills ? t('viewport.fits') : sizeOf(PAGE_SIZES[name])}
                </span>
              </DropdownMenuRadioItem>
            ))}
            {viewport?.name === 'custom' && (
              <DropdownMenuRadioItem value="custom" disabled>
                <PaneIcon icon={ComputerIcon} size={16} />
                <span className="min-w-0 flex-1 truncate">{t('viewport.custom')}</span>
                <span className="shrink-0 text-small text-tertiary tabular-nums">
                  {sizeOf(viewport)}
                </span>
              </DropdownMenuRadioItem>
            )}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * The box of a page that keeps its own size, where main draws it scaled inside the frame, and
 * under it the size and the scale.
 */
function FittedPage({
  frame,
  viewport,
  zoom,
  still,
}: {
  frame: RefObject<HTMLDivElement | null>
  viewport: BrowserViewport
  zoom: number
  still: string | undefined
}) {
  const { t } = useTranslation('browser')
  const [box, setBox] = useState<{
    left: number
    width: number
    height: number
    percent: number
  } | null>(null)

  useLayoutEffect(() => {
    const element = frame.current
    if (!element) return
    const measure = () => {
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      // As main fits it, from the frame in the window's own pixels.
      const { bounds, scale } = fitViewport(
        {
          x: 0,
          y: 0,
          width: Math.round(rect.width * zoom),
          height: Math.round(rect.height * zoom),
          radius: 0,
        },
        viewport,
        Math.round(SIZE_LINE_ROOM * zoom),
      )
      const next = {
        left: bounds.x / zoom,
        width: bounds.width / zoom,
        height: bounds.height / zoom,
        percent: Math.round(scale * 100),
      }
      setBox((last) =>
        last &&
        last.left === next.left &&
        last.width === next.width &&
        last.height === next.height &&
        last.percent === next.percent
          ? last
          : next,
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [frame, viewport, zoom])

  if (!box) return null
  const size = { width: viewport.width, height: viewport.height, percent: box.percent }
  return (
    <>
      <div
        className="kp-view__page"
        style={{ left: box.left, width: box.width, height: box.height }}
      >
        {still && <img src={still} alt="" aria-hidden className="kp-view__still" />}
      </div>
      <Tooltip>
        <TooltipTrigger render={<span className="kp-view__size" style={{ top: box.height }} />}>
          {box.percent < 100 ? t('viewport.scaled', size) : t('viewport.size', size)}
        </TooltipTrigger>
        <TooltipContent>{t('viewport.hint')}</TooltipContent>
      </Tooltip>
    </>
  )
}

/** A download saved or failed, or a page that did not load, crashed or hangs. */
function Notice({ notice, sessionId }: { notice: BrowserNotice; sessionId: string | null }) {
  const { t } = useTranslation('browser')
  const open = () => {
    if (sessionId) void window.kettu.browser.openExternal(sessionId)
  }
  return (
    <div role="status" className="kp-origin" data-answered="" data-denied="">
      <span className="kp-origin__text">
        <span className="truncate">
          {notice.kind === 'downloaded' && t('notice.downloaded', { name: notice.name })}
          {notice.kind === 'saved' && t('notice.saved', { name: notice.name })}
          {notice.kind === 'download-failed' && t('notice.downloadFailed', { name: notice.name })}
          {notice.kind === 'load-failed' && t('notice.loadFailed', { error: notice.description })}
          {notice.kind === 'crashed' && t('notice.crashed')}
          {notice.kind === 'unresponsive' && t('notice.unresponsive')}
        </span>
      </span>
      {notice.kind === 'download-failed' && (
        <button type="button" onClick={open} className="kp-link">
          {t('actions.openExternal')}
        </button>
      )}
      {notice.kind !== 'download-failed' &&
        notice.kind !== 'downloaded' &&
        notice.kind !== 'saved' &&
        sessionId && (
          <button
            type="button"
            onClick={() => void window.kettu.browser.reload(sessionId)}
            className="kp-link"
          >
            {notice.kind === 'load-failed' ? t('actions.tryAgain') : t('actions.reload')}
          </button>
        )}
    </div>
  )
}

/** Whether an open overlay covers the page's area. */
function covers(area: Element): boolean {
  const bounds = area.getBoundingClientRect()
  for (const overlay of document.querySelectorAll('[data-overlay-layer]')) {
    if (overlay.closest('[data-closed]')) continue
    const rect = overlay.getBoundingClientRect()
    const apart =
      rect.right <= bounds.left ||
      rect.left >= bounds.right ||
      rect.bottom <= bounds.top ||
      rect.top >= bounds.bottom
    if (!apart) return true
  }
  return false
}
