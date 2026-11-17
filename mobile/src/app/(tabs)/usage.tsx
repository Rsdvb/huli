// The 用量 tab. The tabs all mount when the app starts, and this one's charts, heatmap and usage
// model are the heaviest of them, so they load just after the first screen shows instead of on
// the way to it (src/usage/UsageScreen.tsx).

import { lazy, Suspense } from 'react'
import { View } from 'react-native'
import { useTokens } from '../../ui/tokens'

const UsageScreen = lazy(() => import('../../usage/UsageScreen'))

export default function Usage() {
  const { c } = useTokens()
  return (
    <Suspense fallback={<View style={{ flex: 1, backgroundColor: c.bg }} />}>
      <UsageScreen />
    </Suspense>
  )
}
