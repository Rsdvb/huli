// Every press on a Huli notification, from the moment the app's code loads: a tap or 打开 opens
// what it is about, an answering button sends its answer. Listening at load rather than from a
// screen lets a button the app was launched in the background for be answered with no screen at
// all; the response that launched the app comes from getLastNotificationResponseAsync, since no
// listener was there yet when the system handed it over.

import * as Notifications from 'expo-notifications'
import { ACTION, answerFromNotification, registerCategories } from './actions'
import { notificationData, openNotification } from './open'

const handled = new Set<string>()

function handle(response: Notifications.NotificationResponse | null): void {
  if (!response) return
  const { request, date } = response.notification
  const key = `${request.identifier}\n${date}\n${response.actionIdentifier}`
  if (handled.has(key)) return
  handled.add(key)
  const data = notificationData(request.content.data)
  if (!data) return
  const action = response.actionIdentifier
  if (action === Notifications.DEFAULT_ACTION_IDENTIFIER || action === ACTION.open) {
    openNotification(data)
    return
  }
  void answerFromNotification(response, data)
}

let started = false

export function watchNotificationResponses(): void {
  if (started) return
  started = true
  void registerCategories()
  Notifications.addNotificationResponseReceivedListener(handle)
  void Notifications.getLastNotificationResponseAsync()
    .then((response) => {
      handle(response)
      return Notifications.clearLastNotificationResponseAsync()
    })
    .catch(() => {})
}

watchNotificationResponses()
