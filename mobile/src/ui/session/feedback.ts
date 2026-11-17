// Touch feedback and the clipboard, as the session screens use them: a light tap on send, a tick
// on a choice, a success when an answer goes, and copying with a tap of feedback.

import { Alert, ActionSheetIOS, Platform } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'

export const haptic = {
  tap: () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {}),
  firm: () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {}),
  pick: () => void Haptics.selectionAsync().catch(() => {}),
  success: () =>
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {}),
}

export async function copyText(text: string): Promise<void> {
  await Clipboard.setStringAsync(text)
  haptic.pick()
}

/** Markdown read as the words it shows: marks, fences and link targets left out. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/\r\n/g, '\n')
    .replace(/^\s*(```|~~~).*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?=[^*\w]|$)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface MenuAction {
  label: string
  destructive?: boolean
  onPress(): void
}

/** The system's own menu of actions: an action sheet on iOS, an alert on Android. */
export function showMenu(title: string | undefined, actions: MenuAction[]): void {
  haptic.firm()
  if (Platform.OS === 'ios') {
    const destructive = actions.findIndex((a) => a.destructive)
    ActionSheetIOS.showActionSheetWithOptions(
      {
        ...(title ? { title } : {}),
        options: [...actions.map((a) => a.label), '取消'],
        cancelButtonIndex: actions.length,
        ...(destructive >= 0 ? { destructiveButtonIndex: destructive } : {}),
      },
      (index) => actions[index]?.onPress(),
    )
    return
  }
  // An Android alert holds three buttons; past two actions, a tap outside it cancels.
  const buttons = actions.slice(0, 3).map((a) => ({
    text: a.label,
    style: a.destructive ? ('destructive' as const) : ('default' as const),
    onPress: a.onPress,
  }))
  Alert.alert(
    title ?? '',
    undefined,
    buttons.length < 3 ? [...buttons, { text: '取消', style: 'cancel' as const }] : buttons,
    { cancelable: true },
  )
}
