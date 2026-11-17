// Notifications on iOS: APNs through expo-notifications. The host seals each notification to this
// phone; the Notification Service Extension (plugins/withNotificationService.js) opens alerts
// before they show, and the background task here takes the silent pushes that withdraw one.

import * as Application from 'expo-application'
import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import * as SecureStore from 'expo-secure-store'
import * as TaskManager from 'expo-task-manager'
import { importKeyPair } from '@shared/remote/noise'
import { decodeSealed, openPush, type PushContent, type PushTarget } from '@shared/remote/push'
import { decodeRelayBytes, verifyRelaySignature } from '@shared/remote/relay'
import { fromBase64, toBase64 } from '../store'
import type { PushPermission, PushPlatform } from './types'

const KEYS_ITEM = 'huli.push.keys'
const BACKGROUND_TASK = 'huli.push.background'

interface SharedKeys {
  v: 1
  /** This phone's X25519 private key, in base64. */
  device: string
  /** Each host's Ed25519 public key in base64url, by its id. */
  hosts: Record<string, string>
  /** The extension shows each notification's kind only, as Settings › 面容 ID 与锁定 asks. */
  quiet?: boolean
}

// The keys sit in the Keychain, in an access group only this app and its extension hold, rather
// than in a file in the App Group container: Keychain items are encrypted under the device's own
// keys, stay out of backups and off other devices (THIS_DEVICE_ONLY), and are readable only by
// targets signed with that group. AFTER_FIRST_UNLOCK lets the extension open what arrives while
// the phone is locked. The Swift side reads the item by expo-secure-store's naming.
function sharedOptions(): SecureStore.SecureStoreOptions {
  const team = Constants.expoConfig?.ios?.appleTeamId
  const app = Application.applicationId
  if (!team || !app) throw new Error('The keychain group of the extension is unknown')
  return {
    keychainService: 'huli.push',
    accessGroup: `${team}.${app}.shared`,
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  }
}

async function loadShared(): Promise<SharedKeys | null> {
  const text = await SecureStore.getItemAsync(KEYS_ITEM, sharedOptions())
  if (!text) return null
  try {
    return JSON.parse(text) as SharedKeys
  } catch {
    return null
  }
}

/** A sealed push's content, once opened with this phone's key and checked against its host's. */
async function openSealed(sealed: string): Promise<PushContent | null> {
  const keys = await loadShared()
  const envelope = decodeSealed(sealed)
  if (!keys || !envelope) return null
  const opened = await openPush(envelope, await importKeyPair(fromBase64(keys.device)))
  if (!opened) return null
  let content: PushContent
  try {
    content = JSON.parse(new TextDecoder().decode(opened.body)) as PushContent
  } catch {
    return null
  }
  const hostKey = keys.hosts[content.host] ? decodeRelayBytes(keys.hosts[content.host]!) : null
  if (!hostKey || !(await verifyRelaySignature(hostKey, opened.signature, opened.signed))) {
    return null
  }
  return content
}

/** Removes the notification a withdrawal names, which APNs gave the tag as its identifier. */
async function withdraw(tag: string): Promise<void> {
  const shown = await Notifications.getPresentedNotificationsAsync()
  const matching = shown.filter(
    (n) => n.request.identifier === tag || n.request.content.data?.tag === tag,
  )
  await Promise.all(
    [tag, ...matching.map((n) => n.request.identifier)].map((id) =>
      Notifications.dismissNotificationAsync(id).catch(() => {}),
    ),
  )
}

TaskManager.defineTask<Notifications.NotificationTaskPayload>(BACKGROUND_TASK, async ({ data }) => {
  const result = Notifications.BackgroundNotificationTaskResult
  if (!data || 'actionIdentifier' in data) return result.NoData
  const sealed = data.data?.sealed
  if (typeof sealed !== 'string') return result.NoData
  try {
    const content = await openSealed(sealed)
    if (content?.kind !== 'withdraw') return result.NoData
    await withdraw(content.tag)
    return result.NewData
  } catch {
    return result.Failed
  }
})

void Notifications.registerTaskAsync(BACKGROUND_TASK).catch(() => {})

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
})

function permissionOf(settings: Notifications.NotificationPermissionsStatus): PushPermission {
  switch (settings.ios?.status) {
    case Notifications.IosAuthorizationStatus.AUTHORIZED:
    case Notifications.IosAuthorizationStatus.PROVISIONAL:
    case Notifications.IosAuthorizationStatus.EPHEMERAL:
      return 'granted'
    case Notifications.IosAuthorizationStatus.DENIED:
      return 'denied'
    default:
      return 'undetermined'
  }
}

export const platform: PushPlatform = {
  supported: true,

  async permission(ask) {
    const current = permissionOf(await Notifications.getPermissionsAsync())
    if (current !== 'undetermined' || !ask) return current
    return permissionOf(
      await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowSound: true, allowBadge: false },
      }),
    )
  },

  async target(): Promise<PushTarget | null> {
    const token = await Notifications.getDevicePushTokenAsync()
    if (token.type !== 'ios' || typeof token.data !== 'string') return null
    // Builds Xcode signs for development reach APNs' sandbox; TestFlight and the App Store carry no
    // profile, so the environment is unknown there and is production.
    const environment = await Application.getIosPushNotificationServiceEnvironmentAsync()
    return {
      apns: {
        token: token.data.toLowerCase(),
        environment: environment === 'development' ? 'sandbox' : 'production',
      },
    }
  },

  onTargetChange(listener) {
    const subscription = Notifications.addPushTokenListener(() => listener())
    return () => subscription.remove()
  },

  async share({ device, host, quiet }) {
    const keys: SharedKeys = {
      v: 1,
      device: toBase64(device),
      hosts: { [host.id]: host.key },
      quiet,
    }
    await SecureStore.setItemAsync(KEYS_ITEM, JSON.stringify(keys), sharedOptions())
  },

  async unshare() {
    await SecureStore.deleteItemAsync(KEYS_ITEM, sharedOptions())
  },
}
