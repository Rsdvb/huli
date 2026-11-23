import { useEffect } from 'react'
import { StyleSheet } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { startCloud } from '../cloud'
import { OutboxBridge } from '../components/OutboxBridge'
import { launchedLongThread, LongThreadScreen } from '../dev/LongThreadScreen'
import { launchedScrollLab, ScrollLab } from '../dev/ScrollLab'
import { ShellProvider } from '../components/shell'
import { HostProvider } from '../host'
import { LinkBridge } from '../links'
import { LiveBridge } from '../live/bridge'
import { LockLayer } from '../lock'
import { PreviewSheet } from '../preview/PreviewSheet'
import { PushBridge } from '../push/bridge'
import { ShareIntake } from '../share/intake'
import { SystemBridge } from '../system/bridge'
import { NoticeBar } from '../ui/NoticeBar'
import { watchMemory } from '../ui/memory'
import { MenuSheetHost } from '../ui/MenuSheet'
import { SelectTextHost } from '../ui/session/SelectText'
import { useTokens } from '../ui/tokens'
import { watchUpdates } from '../update'

// A screen opened from a link or a notification still has the tabs to go back to.
export const unstable_settings = { anchor: '(tabs)' }

/** Settings' pages that manage what the computer keeps, each under `settings/`. */
const MANAGE_PAGES = [
  'agents',
  'agent',
  'agent-reset',
  'harness',
  'market',
  'market-plugin',
  'market-skill',
  'mcp',
  'memory',
  'memory-entry',
  'projects',
  'project',
  'artifacts',
  'devices',
  'usage',
  'network',
  'network-node',
] as const

// Launched to measure the conversation list (dev/LongThreadScreen.tsx): that screen, and no other.
const longThread = launchedLongThread()
const scrollLab = launchedScrollLab()

export default function Layout() {
  const { c, scheme } = useTokens()
  useEffect(() => watchUpdates(), [])
  useEffect(() => watchMemory(), [])
  useEffect(() => startCloud(), [])
  if (scrollLab) return <ScrollLab mode={scrollLab} />
  if (longThread) {
    return (
      <KeyboardProvider>
        <SafeAreaProvider>
          <HostProvider>
            <LongThreadScreen options={longThread} />
          </HostProvider>
        </SafeAreaProvider>
      </KeyboardProvider>
    )
  }
  return (
    // The keyboard's frames reach the screens on the UI thread, so the views that make room for it
    // move with it without a layout pass per frame. Gestures (home's drag onto a folder) need the
    // root view of their own.
    <GestureHandlerRootView style={styles.root}>
      <KeyboardProvider>
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
                <Stack.Screen name="session/[id]" options={{ headerShown: false }} />
                <Stack.Screen name="new" options={{ headerShown: false }} />
                <Stack.Screen
                  name="share"
                  options={{ headerShown: false, presentation: 'modal' }}
                />
                <Stack.Screen name="settings/index" options={{ headerShown: false }} />
                <Stack.Screen name="settings/account" options={{ headerShown: false }} />
                <Stack.Screen name="settings/computers" options={{ headerShown: false }} />
                <Stack.Screen name="settings/computer" options={{ headerShown: false }} />
                <Stack.Screen name="settings/lock" options={{ headerShown: false }} />
                <Stack.Screen name="settings/licenses" options={{ headerShown: false }} />
                {MANAGE_PAGES.map((name) => (
                  <Stack.Screen
                    key={name}
                    name={`settings/${name}`}
                    options={{ headerShown: false }}
                  />
                ))}
                <Stack.Screen name="dev-servers" options={{ headerShown: false }} />
                <Stack.Screen name="background/[id]" options={{ headerShown: false }} />
                <Stack.Screen name="mcp/[id]" options={{ headerShown: false }} />
                <Stack.Screen name="dev-preview" options={{ headerShown: false }} />
                <Stack.Screen name="archived" options={{ headerShown: false }} />
                <Stack.Screen name="recycle-bin" options={{ headerShown: false }} />
                <Stack.Screen name="artifacts-deleted" options={{ headerShown: false }} />
                <Stack.Screen name="artifact/[id]" options={{ headerShown: false }} />
                <Stack.Screen name="routine/[id]" options={{ headerShown: false }} />
                <Stack.Screen name="plan/[id]" options={{ headerShown: false }} />
                <Stack.Screen name="task/[id]" options={{ headerShown: false }} />
                <Stack.Screen name="start-task" options={{ headerShown: false }} />
                <Stack.Screen name="workflows" options={{ headerShown: false }} />
                <Stack.Screen name="workflow/[id]" options={{ headerShown: false }} />
                <Stack.Screen name="search" options={{ headerShown: false, animation: 'fade' }} />
                <Stack.Screen name="pair" options={{ headerShown: false, presentation: 'modal' }} />
                <Stack.Screen
                  name="pair-computer"
                  options={{ headerShown: false, presentation: 'modal' }}
                />
              </Stack>
            </ShellProvider>
            <PushBridge />
            <OutboxBridge />
            <LinkBridge />
            <LiveBridge />
            <SystemBridge />
            <ShareIntake />
            <NoticeBar />
            <SelectTextHost />
            <MenuSheetHost />
            <PreviewSheet />
            <LockLayer />
          </HostProvider>
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  )
}

const styles = StyleSheet.create({ root: { flex: 1 } })
