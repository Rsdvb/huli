// A link out of an artifact: the desktop blocks the page's navigation and offers the browser; the
// phone asks first, naming where the link goes, and opens only web, mail and phone links.

import { Alert } from 'react-native'
import { openUrl } from '../system/openUrl'

let asking = false

function shown(href: string): string {
  const url = URL.parse(href)
  if (!url) return href
  if (url.protocol === 'mailto:' || url.protocol === 'tel:') return decodeURIComponent(url.pathname)
  return url.host + (url.pathname === '/' ? '' : url.pathname)
}

export function confirmLink(href: string): void {
  if (asking || !/^(https?:|mailto:|tel:)/i.test(href) || href.length > 4096) return
  asking = true
  const done = () => {
    asking = false
  }
  Alert.alert(
    '打开链接？',
    `这个页面想打开：\n${shown(href)}`,
    [
      { text: '取消', style: 'cancel', onPress: done },
      {
        text: '打开',
        onPress: () => {
          done()
          openUrl(href)
        },
      },
    ],
    { cancelable: true, onDismiss: done },
  )
}
