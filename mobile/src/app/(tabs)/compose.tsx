// The tab bar's new-session item, which the tab bar never selects: its press opens New session
// (the tabs' layout). Reached any other way, it goes back to the tab that was showing and opens
// New session, as it shows nothing of its own.

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
