// The tab bar's new-session item. A native tab bar item can only select a tab, so this tab shows
// nothing of its own: chosen, it goes back to the tab that was showing and opens New session.

import { useCallback } from 'react'
import { View } from 'react-native'
import { router, useFocusEffect, useNavigation } from 'expo-router'
import { lastTab } from '../../ui/lastTab'
import { useTokens } from '../../ui/tokens'

export default function Compose() {
  const { c } = useTokens()
  const navigation = useNavigation()
  useFocusEffect(
    useCallback(() => {
      ;(navigation.navigate as (name: string) => void)(lastTab())
      router.push('/new')
    }, [navigation]),
  )
  return <View style={{ flex: 1, backgroundColor: c.bg }} />
}
