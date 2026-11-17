// Whether the keyboard is up, from the events that come first on each platform: iOS says before
// it moves, Android only once it has.

import { useEffect, useState } from 'react'
import { Keyboard, Platform } from 'react-native'

export function useKeyboardShown(): boolean {
  const [shown, setShown] = useState(Keyboard.isVisible())
  useEffect(() => {
    const ios = Platform.OS === 'ios'
    const show = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', () =>
      setShown(true),
    )
    const hide = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () =>
      setShown(false),
    )
    return () => {
      show.remove()
      hide.remove()
    }
  }, [])
  return shown
}
