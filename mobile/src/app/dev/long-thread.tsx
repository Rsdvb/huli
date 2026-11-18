// The developer's long thread (dev/LongThreadScreen.tsx) at huli://dev/long-thread; off unless
// devMode() says so, and then it goes home.

import { Redirect, Stack, useLocalSearchParams } from 'expo-router'
import { devMode } from '../../dev/devMode'
import { LongThreadScreen, type LongThreadOptions } from '../../dev/LongThreadScreen'

export default function LongThreadRoute() {
  if (!devMode()) return <Redirect href="/" />
  return <Route />
}

function Route() {
  const params = useLocalSearchParams<{ [K in keyof LongThreadOptions]: string }>()
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <LongThreadScreen options={params} />
    </>
  )
}
