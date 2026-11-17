import { useEffect, useState } from 'react'
import { ActivityIndicator, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import type { KeyPair } from '@shared/remote/noise'
import type { Paired } from '@shared/remote/pair'
import { deviceKey } from './connection'
import { PairScreen } from './screens/PairScreen'
import { SessionsScreen } from './screens/SessionsScreen'
import { loadHost, saveHost, type SavedHost } from './store'
import { useTheme } from './theme'

type State =
  | { kind: 'loading' }
  | { kind: 'pair'; notice: string | null }
  | { kind: 'host'; host: SavedHost; key: KeyPair; paired: Paired | null }

export default function App() {
  const theme = useTheme()
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    void (async () => {
      const [host, key] = await Promise.all([loadHost(), deviceKey()])
      setState(host ? { kind: 'host', host, key, paired: null } : { kind: 'pair', notice: null })
    })()
  }, [])

  const forget = async (notice: string | null) => {
    await saveHost(null)
    setState({ kind: 'pair', notice })
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      <View style={{ flex: 1, backgroundColor: theme.bg }}>
        {state.kind === 'loading' && (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator color={theme.accent} />
          </View>
        )}
        {state.kind === 'pair' && (
          <PairScreen
            notice={state.notice}
            onPaired={async (host, key, paired) => {
              await saveHost(host)
              setState({ kind: 'host', host, key, paired })
            }}
          />
        )}
        {state.kind === 'host' && (
          <SessionsScreen
            host={state.host}
            deviceKey={state.key}
            paired={state.paired}
            onHostChanged={(host) => void saveHost(host)}
            onForget={(notice) => void forget(notice)}
          />
        )}
      </View>
    </SafeAreaProvider>
  )
}
