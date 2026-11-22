// A dev server of the computer in a web view (开发服务器 › a port): the computer opens a port of its
// own for this phone that proxies to the dev server (devServers.ts), on the direct route the link
// is on, which the bar names. Pages of the preview stay in it; a link elsewhere opens in the
// system's browser. Reload opens the preview anew at the page shown, so an expired one comes back;
// leaving closes it on the computer.

import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import { WebView } from 'react-native-webview'
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes'
import { isPreviewPort } from '@shared/dev-preview'
import {
  closePreview,
  NEEDS_DIRECT,
  openPreview,
  previewRouteText,
  type PreviewStart,
} from '../devServers'
import { errorText } from '../git'
import { useHostState, useLink } from '../host'
import { openUrl } from '../system/openUrl'
import { GlassHeader } from '../ui/session/GlassHeader'
import { G, Icon } from '../ui/session/icons'
import { useSessionTokens } from '../ui/session/palette'
import { RoundButton } from '../ui/session/Press'
import { StateView } from '../ui/session/StateView'

function failureText(start: Extract<PreviewStart, { ok: false }>, port: number): string {
  if (start.reason !== 'failed') {
    return start.reason === 'relay' ? NEEDS_DIRECT : '连上电脑后才能预览。'
  }
  const code = (start.error as { code?: unknown } | null)?.code
  if (code === 'not_found')
    return `电脑上的端口 ${port} 现在没有程序在监听，开发服务器可能已经停了。`
  if (code === 'forbidden') return `端口 ${port} 没有在电脑的本机地址上监听，没法预览。`
  if (code === 'busy') return '这台手机打开的预览太多了，关掉几个再试。'
  return errorText(start.error, '没能打开预览。')
}

export default function DevPreviewScreen() {
  const params = useLocalSearchParams<{ port: string; name?: string }>()
  const port = Number(params.port)
  const valid = isPreviewPort(port)
  const { c } = useSessionTokens()
  const link = useLink()
  const connected = useHostState().kind === 'connected'
  const [start, setStart] = useState<PreviewStart | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const view = useRef<{ reload(): void } | null>(null)
  /** The page shown, which a new start opens at. */
  const shown = useRef('/')
  const tried = useRef(-1)

  // Opened once a try, when the link is up; a reconnect later leaves the page as it is.
  useEffect(() => {
    if (!valid || !connected || tried.current === attempt) return
    tried.current = attempt
    let gone = false
    const to = shown.current
    setStart(null)
    setLoaded(false)
    setLoadError(null)
    void openPreview(link, port).then((next) => {
      if (gone) return
      setStart(
        next.ok && to !== '/' ? { ...next, url: `${next.url}?to=${encodeURIComponent(to)}` } : next,
      )
    })
    return () => {
      gone = true
    }
  }, [valid, connected, attempt, link, port])

  useEffect(() => () => (valid ? closePreview(link, port) : undefined), [valid, link, port])

  const again = () => setAttempt((n) => n + 1)
  const origin = start?.ok ? start.origin : null

  const onShouldStart = (request: ShouldStartLoadRequest): boolean => {
    if (!origin) return false
    const at = request.url
    if (at === origin || at.startsWith(`${origin}/`) || at === 'about:blank') return true
    // A frame of the page may load what it embeds; the page itself stays the preview's.
    if (request.isTopFrame === false) return true
    const tapped = Platform.OS === 'android' || request.navigationType === 'click'
    if (tapped && /^(https?|mailto|tel):/i.test(at)) openUrl(at)
    return false
  }

  let body
  if (!valid) body = <StateView text="这不是一个开发服务器的端口。" tone="danger" />
  else if (!start) {
    body = connected ? (
      <StateView loading />
    ) : (
      <StateView text="连上电脑后才能预览。" icon={G.wifiOff} />
    )
  } else if (!start.ok) {
    body = (
      <StateView
        text={failureText(start, port)}
        icon={start.reason === 'relay' ? G.wifiOff : undefined}
        tone={start.reason === 'failed' ? 'danger' : 'plain'}
        retry={again}
      />
    )
  } else {
    body = (
      <View style={styles.fill}>
        <WebView
          key={start.url}
          ref={(web) => {
            view.current = web
          }}
          style={[styles.fill, { backgroundColor: c.bg }]}
          source={{ uri: start.url }}
          originWhitelist={['http://*', 'https://*', 'about:*']}
          onShouldStartLoadWithRequest={onShouldStart}
          onNavigationStateChange={(nav) => {
            if (nav.url.startsWith(`${start.origin}/`)) {
              shown.current = nav.url.slice(start.origin.length)
            }
          }}
          onLoadEnd={() => setLoaded(true)}
          onError={(event) => setLoadError(event.nativeEvent.description || '页面没有打开。')}
          javaScriptEnabled
          domStorageEnabled
          setSupportMultipleWindows={false}
          javaScriptCanOpenWindowsAutomatically={false}
          allowsBackForwardNavigationGestures
          allowsInlineMediaPlayback
          allowFileAccess={false}
          allowFileAccessFromFileURLs={false}
          allowUniversalAccessFromFileURLs={false}
          geolocationEnabled={false}
          mediaCapturePermissionGrantType="deny"
          sharedCookiesEnabled={false}
          thirdPartyCookiesEnabled={false}
          webviewDebuggingEnabled={__DEV__}
          onContentProcessDidTerminate={() => view.current?.reload()}
        />
        {loadError ? (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: c.bg }]}>
            <StateView text={`页面没有打开：${loadError}`} tone="danger" retry={again} />
          </View>
        ) : !loaded ? (
          <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
            <ActivityIndicator color={c.textSecondary} />
          </View>
        ) : null}
      </View>
    )
  }

  const name = params.name ? ` · ${params.name}` : ''
  return (
    <View style={[styles.fill, { backgroundColor: c.bg }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <GlassHeader
        title={valid ? `端口 ${port}${name}` : '预览'}
        subtitle={start?.ok ? `经${previewRouteText(start.address)}` : null}
        right={
          start?.ok ? (
            <RoundButton tone="glass" size={44} onPress={again} accessibilityLabel="重新载入">
              <Icon icon={G.retry} size={17} color={c.text} />
            </RoundButton>
          ) : null
        }
      />
      {body}
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
})
