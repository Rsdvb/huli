import { useEffect } from 'react'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { ShellProvider } from '../components/shell'
import { HostProvider } from '../host'
import { LinkBridge } from '../links'
import { LiveBridge } from '../live/bridge'
import { LockLayer } from '../lock'
import { PushBridge } from '../push/bridge'
import { ShareIntake } from '../share/intake'
import { SystemBridge } from '../system/bridge'
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
            <Stack.Screen name="share" options={{ headerShown: false, presentation: 'modal' }} />
            <Stack.Screen name="settings/index" options={{ headerShown: false }} />
            <Stack.Screen name="settings/computers" options={{ headerShown: false }} />
            <Stack.Screen name="settings/computer" options={{ headerShown: false }} />
            <Stack.Screen name="settings/lock" options={{ headerShown: false }} />
            <Stack.Screen name="settings/licenses" options={{ headerShown: false }} />
            <Stack.Screen name="archived" options={{ headerShown: false }} />
            <Stack.Screen name="artifacts-deleted" options={{ headerShown: false }} />
            <Stack.Screen name="artifact/[id]" options={{ headerShown: false }} />
            <Stack.Screen name="routine/[id]" options={{ headerShown: false }} />
            <Stack.Screen name="task/[id]" options={{ headerShown: false }} />
            <Stack.Screen name="start-task" options={{ headerShown: false }} />
            <Stack.Screen name="workflows" options={{ headerShown: false }} />
            <Stack.Screen name="workflow/[id]" options={{ headerShown: false }} />
            <Stack.Screen name="search" options={{ headerShown: false, animation: 'fade' }} />
            <Stack.Screen name="pair" options={{ headerShown: false, presentation: 'modal' }} />
          </Stack>
        </ShellProvider>
        <PushBridge />
        <LinkBridge />
        <LiveBridge />
        <SystemBridge />
        <ShareIntake />
        <LockLayer />
      </HostProvider>
    </SafeAreaProvider>
  )
}
