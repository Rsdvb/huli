// A PDF downloaded to preview, in a web view: where Quick Look would not show one on iOS, WebKit
// still draws it. `uri` is the copy in the preview cache (preview/cache.ts), read from its folder.

import { StyleSheet, View } from 'react-native'
import { Stack, useLocalSearchParams } from 'expo-router'
import { WebView } from 'react-native-webview'
import { previewFile } from '../preview/preview'
import { SHARE_LABEL } from '../preview/PreviewSheet'
import { GlassHeader } from '../ui/session/GlassHeader'
import { G, Icon } from '../ui/session/icons'
import { useSessionTokens } from '../ui/session/palette'
import { RoundButton } from '../ui/session/Press'
import { StateView } from '../ui/session/StateView'

export default function PdfScreen() {
  const { uri, name, id, path } = useLocalSearchParams<{
    uri: string
    name: string
    id: string
    path: string
  }>()
  const { c } = useSessionTokens()
  // Only a copy of the preview cache, never another page.
  const local =
    typeof uri === 'string' && uri.startsWith('file://') && uri.includes('/huli-preview/')
  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ headerShown: false }} />
      <GlassHeader
        title={name ?? 'PDF'}
        right={
          id && path ? (
            <RoundButton
              tone="glass"
              size={44}
              onPress={() => previewFile({ sessionId: id, path }, 'share')}
              accessibilityLabel={SHARE_LABEL}
            >
              <Icon icon={G.share} size={17} color={c.text} />
            </RoundButton>
          ) : null
        }
      />
      {local ? (
        <WebView
          source={{ uri }}
          originWhitelist={['file://*']}
          allowingReadAccessToURL={uri.slice(0, uri.lastIndexOf('/') + 1)}
          allowFileAccess
          style={[styles.page, { backgroundColor: c.bg }]}
        />
      ) : (
        <StateView text="这个文件已经不在手机上了，请重新打开。" />
      )}
    </View>
  )
}

const styles = StyleSheet.create({ page: { flex: 1 } })
