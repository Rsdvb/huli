import { useEffect } from 'react'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { HostProvider } from '../host'
import { PushBridge } from '../push/bridge'
import { useTheme } from '../theme'
import { watchUpdates } from '../update'

export default function Layout() {
  const theme = useTheme()
  useEffect(() => watchUpdates(), [])
  return (
    <SafeAreaProvider>
      <HostProvider>
        <StatusBar style="auto" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: theme.bg },
            headerTintColor: theme.accent,
            headerTitleStyle: { color: theme.text },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: theme.bg },
            headerBackTitle: '返回',
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="session/[id]" options={{ title: '' }} />
          <Stack.Screen name="new" options={{ title: '新会话', presentation: 'modal' }} />
        </Stack>
        <PushBridge />
      </HostProvider>
    </SafeAreaProvider>
  )
}
