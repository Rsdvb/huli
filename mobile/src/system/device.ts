// What the app calls the device it runs on and the system's parts, by platform: an iPhone or an
// iPad and its 钥匙串 on iOS, a 手机 or 平板 and its key store on Android. And the computer's
// trash, as its own system names it.

import { Platform } from 'react-native'
import * as Device from 'expo-device'

const ios = Platform.OS === 'ios'
const tablet = Platform.OS === 'ios' && Platform.isPad

/** 「iPhone」「iPad」「手机」. */
export const DEVICE = ios ? (tablet ? 'iPad' : 'iPhone') : '手机'

/** 「这台 iPhone」「这台手机」. */
export const THIS_DEVICE = ios ? `这台 ${DEVICE}` : `这台${DEVICE}`

/** 「在 iPhone 上」「在手机上」. */
export const ON_DEVICE = ios ? `在 ${DEVICE} 上` : `在${DEVICE}上`

/** The phone's system and its version, as a computer lists the device: 「iOS 26.1」「Android 16」. */
export const SYSTEM_VERSION =
  `${ios ? (tablet ? 'iPadOS' : 'iOS') : 'Android'} ${Device.osVersion ?? ''}`.trim()

/** What the phone calls itself until it is named: its own name, else its model, else 「手机」. */
export const DEVICE_NAME = Device.deviceName ?? Device.modelName ?? DEVICE

/** Where the phone keeps its sign-ins: 「钥匙串」, or Android's key store. */
export const KEYCHAIN = ios ? '钥匙串' : '系统密钥库'

/** Where a computer puts what it deletes: 「废纸篓」 on a Mac, 「回收站」 elsewhere. */
export function trashName(platform: string | undefined): string {
  return platform === 'darwin' ? '废纸篓' : '回收站'
}
