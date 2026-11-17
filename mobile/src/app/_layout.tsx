import { useEffect } from 'react'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { ShellProvider } from '../components/shell'
import { HostProvider } from '../host'
import { LockLayer } from '../lock'
import { PushBridge } from '../push/bridge'
import { useTokens } from '../ui/tokens'
import { watchUpdates } from '../update'

// A screen opened from a link or a notification still has the tabs to go back to.
export const unstable_settings = { anchor: '(tabs)' }

export default function Layout() {
  const { c, scheme } = useTokens()
  useEffect(() => watchUpdates(), [])
  return (
    <SafeAreaProvider>
      <HostProvider>
        <ShellProvider>
          <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: c.bg },
              headerTintColor: c.text,
              headerTitleStyle: { color: c.text },
              headerShadowVisible: false,
              contentStyle: { backgroundColor: c.bg },
              headerBackTitle: '返回',
            }}
          >
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="session/[id]" options={{ title: '' }} />
            <Stack.Screen name="new" options={{ headerShown: false }} />
            <Stack.Screen name="settings/index" options={{ headerShown: false }} />
            <Stack.Screen name="settings/computer" options={{ headerShown: false }} />
            <Stack.Screen name="settings/lock" options={{ headerShown: false }} />
            <Stack.Screen name="settings/licenses" options={{ headerShown: false }} />
            <Stack.Screen name="archived" options={{ headerShown: false }} />
            <Stack.Screen name="artifacts-deleted" options={{ headerShown: false }} />
            <Stack.Screen name="routine/[id]" options={{ headerShown: false }} />
          </Stack>
        </ShellProvider>
        <PushBridge />
        <LockLayer />
      </HostProvider>
    </SafeAreaProvider>
  )
}
