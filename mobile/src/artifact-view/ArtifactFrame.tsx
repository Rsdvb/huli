// One artifact page in a web view: the shell (shell.ts) around the page made whole (page.ts), its
// runtime messages relayed to the computer (relay.ts), and what the page may not do caught here:
// a link out of the artifact asks first, a link to another of its pages opens that page, and any
// other navigation stays blocked.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native'
import { WebView, type WebViewMessageEvent } from 'react-native-webview'
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes'
import type { RuntimeAnswer } from '@shared/artifact-capabilities'
import {
  parsePageMessage,
  parseSelectMessage,
  RUNTIME_VERSION,
  type DriveMessage,
  type PageSelection,
  type Pin,
} from '@shared/artifact-runtime/page-messages'
import type { HostLink } from '@shared/remote/link'
import { useSessionTokens } from '../ui/session/palette'
import { resolveRef, VIRTUAL_ORIGIN } from './page'
import { RuntimeRelay } from './relay'
import { shellCall, shellHtml, type FrameLayout } from './shell'

/** The picks a page may report each second; more are dropped, as the desktop drops them. */
const PICKS_PER_SECOND = 20
/** The page shows once it loaded, or after this long when a CDN never answers. */
const SHOW_BY_MS = 3000

function randomToken(bytes: number): string {
  const values = crypto.getRandomValues(new Uint8Array(bytes))
  return Array.from(
    values,
    (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b & 63],
  ).join('')
}

export interface ArtifactFrameProps {
  link: HostLink
  artifactId: string
  /** The page made whole, for the frame's srcdoc. */
  page: string
  /** The file it is, which links from it resolve against. */
  path: string
  layout: FrameLayout
  /** Pick mode: a tap picks the element under it, for a comment. */
  picking: boolean
  pins: Pin[]
  onPick(selection: PageSelection): void
  /** A link out of the artifact. */
  onLink(href: string): void
  /** A link to another file of the artifact. */
  onOpen(path: string, hash: string): void
  /** The page asked for a capability only the computer gives. */
  onDesktopOnly(): void
}

export function ArtifactFrame(props: ArtifactFrameProps) {
  const { c } = useSessionTokens()
  // The library types its ref as a generic class whose parameter JSX infers, so the ref is kept
  // by what it is used for.
  const view = useRef<{ injectJavaScript(script: string): void } | null>(null)
  const nonce = useMemo(() => randomToken(32), [])
  const channel = useMemo(() => randomToken(16), [])
  const [loaded, setLoaded] = useState(false)
  const [crashes, setCrashes] = useState(0)
  const picks = useRef({ second: 0, count: 0 })
  const latest = useRef(props)
  latest.current = props

  const background = c.bg
  const html = useMemo(
    () => shellHtml({ page: props.page, layout: props.layout, nonce, background }),
    [props.page, props.layout, nonce, background],
  )

  const inject = useCallback((method: 'drive' | 'answer' | 'picking', value: unknown) => {
    view.current?.injectJavaScript(shellCall(method, value))
  }, [])

  // One relay per page shown; a new page, or a new web view after a crash, starts another.
  const relay = useMemo(
    () =>
      new RuntimeRelay(
        props.link,
        props.artifactId,
        (answer: RuntimeAnswer) => inject('answer', answer),
        () => latest.current.onDesktopOnly(),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.link, props.artifactId, html, crashes, inject],
  )
  useEffect(() => () => relay.close(), [relay])

  useEffect(() => {
    setLoaded(false)
    const timer = setTimeout(() => setLoaded(true), SHOW_BY_MS)
    return () => clearTimeout(timer)
  }, [html, crashes])

  const drive = useCallback((message: DriveMessage) => inject('drive', message), [inject])

  const sendMode = useCallback(() => {
    drive({
      v: RUNTIME_VERSION,
      kind: 'select-mode',
      mode: latest.current.picking ? 'comment' : null,
      channel,
      accent: c.accent,
    })
    inject('picking', latest.current.picking)
  }, [drive, inject, channel, c.accent])

  const sendPins = useCallback(() => {
    drive({ v: RUNTIME_VERSION, kind: 'select-pins', pins: latest.current.pins })
  }, [drive])

  useEffect(sendMode, [props.picking, sendMode])
  useEffect(sendPins, [props.pins, sendPins])

  const onMessage = (event: WebViewMessageEvent) => {
    let data: Record<string, unknown>
    try {
      data = JSON.parse(event.nativeEvent.data) as Record<string, unknown>
    } catch {
      return
    }
    // Only the shell knows the nonce; a message without it came from the page.
    if (typeof data !== 'object' || data === null || data.n !== nonce) return
    switch (data.kind) {
      case 'loaded':
        setLoaded(true)
        sendMode()
        sendPins()
        return
      case 'link':
        if (typeof data.href === 'string') latest.current.onLink(data.href)
        return
      case 'open':
        if (typeof data.path === 'string' && typeof data.hash === 'string') {
          latest.current.onOpen(data.path, data.hash)
        }
        return
      case 'page': {
        if (typeof data.text !== 'string') return
        let message: unknown
        try {
          message = JSON.parse(data.text)
        } catch {
          return
        }
        const parsed = parsePageMessage(message)
        if (!parsed) return
        if (parsed.kind === 'capability') {
          relay.handle(parsed.message)
          return
        }
        const select = parseSelectMessage(message)
        if (!select || select.channel !== channel || !select.selection) return
        if (!latest.current.picking || !allowPick()) return
        latest.current.onPick(select.selection)
        return
      }
    }
  }

  const allowPick = (): boolean => {
    const second = Math.floor(Date.now() / 1000)
    if (second !== picks.current.second) picks.current = { second, count: 0 }
    return ++picks.current.count <= PICKS_PER_SECOND
  }

  const onShouldStart = (request: ShouldStartLoadRequest): boolean => {
    const url = request.url
    // The shell itself, and the page's frame from its srcdoc.
    if (url === 'about:blank' || url === 'about:srcdoc') return true
    // Anything else a frame starts loading is blocked; only a tap on a link means the user asked.
    const tapped = Platform.OS === 'android' || request.navigationType === 'click'
    if (!tapped) return false
    if (url.startsWith(`${VIRTUAL_ORIGIN}/`)) {
      const found = resolveRef(props.path, url)
      if (found) latest.current.onOpen(found.path, found.hash)
      return false
    }
    if (/^(https?|mailto|tel):/i.test(url)) latest.current.onLink(url)
    return false
  }

  return (
    <View style={[styles.fill, { backgroundColor: background }]}>
      <WebView
        key={crashes}
        ref={(web) => {
          view.current = web
        }}
        style={[styles.fill, { backgroundColor: background, opacity: loaded ? 1 : 0 }]}
        source={{ html }}
        originWhitelist={['*']}
        onMessage={onMessage}
        onShouldStartLoadWithRequest={onShouldStart}
        javaScriptEnabled
        incognito
        cacheEnabled={false}
        domStorageEnabled={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        setSupportMultipleWindows={false}
        javaScriptCanOpenWindowsAutomatically={false}
        geolocationEnabled={false}
        mediaCapturePermissionGrantType="deny"
        mixedContentMode="never"
        allowsLinkPreview={false}
        dataDetectorTypes="none"
        allowsInlineMediaPlayback
        allowsBackForwardNavigationGestures={false}
        setBuiltInZoomControls
        setDisplayZoomControls={false}
        textZoom={100}
        thirdPartyCookiesEnabled={false}
        sharedCookiesEnabled={false}
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        webviewDebuggingEnabled={__DEV__}
        onContentProcessDidTerminate={() => setCrashes((n) => n + 1)}
        onRenderProcessGone={() => setCrashes((n) => n + 1)}
      />
      {!loaded && (
        <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
          <ActivityIndicator color={c.textSecondary} />
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
})
