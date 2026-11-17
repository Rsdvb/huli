// Sends what waits in the outbox each time the active computer connects, and says so when a new
// session made from it is ready while its screen is no longer open.

import { useEffect } from 'react'
import { router } from 'expo-router'
import { useComputerId, useConnected, useMaybeLink } from '../host'
import { setCreatedFallback, setOutboxLink } from '../outbox'
import { sessionTitle } from '../sessions'
import { showNotice } from '../ui/NoticeBar'

export function OutboxBridge() {
  const link = useMaybeLink()
  const computer = useComputerId()
  const connected = useConnected()

  useEffect(() => {
    setOutboxLink(connected ? link : null, computer)
  }, [link, computer, connected])

  useEffect(() => {
    setCreatedFallback((session) =>
      showNotice({
        text: `新会话「${sessionTitle(session)}」已在电脑上开始`,
        tone: 'success',
        action: { label: '打开', onPress: () => router.push(`/session/${session.id}`) },
      }),
    )
    return () => {
      setCreatedFallback(null)
      setOutboxLink(null, null)
    }
  }, [])

  return null
}
