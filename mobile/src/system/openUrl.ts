// Opens a web page or another app's link the user tapped, saying so when the phone cannot: a link
// that did nothing looked broken.

import { Linking } from 'react-native'
import { showNotice } from '../ui/NoticeBar'

export function openUrl(url: string): void {
  Linking.openURL(url).catch(() => showNotice({ text: '手机上打不开这个链接', tone: 'warning' }))
}
