// The app lock: with 需要面容 ID on, Huli locks once it has been away longer than the chosen delay
// (and at every cold start), and Face ID, Touch ID or the passcode opens it again. While it is
// locked or about to leave the screen, a cover hides what it shows, so the app switcher's snapshot
// holds only the fox.
//
// The cover is a view, not a window, so every layer that floats above the screens (a sheet, a
// dialog, a modal screen) draws its own LockLayer too; they share this one state.

import { useEffect, useState, useSyncExternalStore } from 'react'
import { AppState, StyleSheet, Text, View } from 'react-native'
import * as LocalAuthentication from 'expo-local-authentication'
import { getPrefs, prefsReady, setPrefs } from './prefs'
import { haptic } from './ui/haptics'
import { HuliIcon } from './ui/HuliMark'
import { Pill } from './ui/Pill'
import { space, type as typeScale, useTokens } from './ui/tokens'

interface LockState {
  locked: boolean
  /** Hidden without being locked: the app is leaving the screen, or the lock is not known yet. */
  covered: boolean
}

let state: LockState = { locked: false, covered: true }
const listeners = new Set<() => void>()
let leftAt: number | null = null
let authenticating = false
/** The current lock has offered the prompt once by itself; a tap offers it again. */
let prompted = false

function set(change: Partial<LockState>): void {
  const next = { ...state, ...change }
  if (next.locked === state.locked && next.covered === state.covered) return
  if (next.locked && !state.locked) prompted = false
  state = next
  for (const listener of listeners) listener()
}

void prefsReady().then(() => set({ locked: getPrefs().lock, covered: false }))

AppState.addEventListener('change', (next) => {
  const prefs = getPrefs()
  if (!prefs.lock || authenticating) return
  if (next === 'background') {
    leftAt ??= Date.now()
    set({ covered: true })
  } else if (next === 'inactive') {
    set({ covered: true })
  } else if (next === 'active') {
    const away = leftAt === null ? -1 : Date.now() - leftAt
    leftAt = null
    set({ covered: false, locked: state.locked || away >= prefs.lockAfter * 1000 })
  }
})

export function useLockState(): LockState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
  )
}

const NO_LOCK: LocalAuthentication.LocalAuthenticationError[] = [
  'not_enrolled',
  'not_available',
  'passcode_not_set',
]

/**
 * Asks for Face ID, Touch ID or the passcode. `failed` holds the system's reason when it was not
 * a plain cancel, as when the phone has no passcode at all.
 */
export async function authenticate(
  message: string,
): Promise<{ ok: true } | { ok: false; error: LocalAuthentication.LocalAuthenticationError }> {
  authenticating = true
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: message,
      cancelLabel: '取消',
      fallbackLabel: '输入密码',
    })
    return result.success ? { ok: true } : { ok: false, error: result.error }
  } catch {
    return { ok: false, error: 'unknown' }
  } finally {
    // The app turns active again just after the prompt closes; that is not a return from away.
    setTimeout(() => {
      authenticating = false
    }, 800)
  }
}

export async function unlock(): Promise<void> {
  if (authenticating) return
  const result = await authenticate('解锁 Huli')
  if (result.ok) {
    haptic.success()
    set({ locked: false, covered: false })
  } else if (NO_LOCK.includes(result.error)) {
    // A phone without a passcode cannot be asked for one; the lock goes rather than trap the user.
    setPrefs({ lock: false })
    set({ locked: false, covered: false })
  }
}

/** What unlocks the app on this phone, in the system's words. */
export function useBiometryName(): string {
  const [name, setName] = useState('面容 ID')
  useEffect(() => {
    let live = true
    void LocalAuthentication.supportedAuthenticationTypesAsync()
      .then((types) => {
        if (!live) return
        const T = LocalAuthentication.AuthenticationType
        setName(
          types.includes(T.FACIAL_RECOGNITION)
            ? '面容 ID'
            : types.includes(T.FINGERPRINT)
              ? '触控 ID'
              : '密码',
        )
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])
  return name
}

/** The cover over whatever this layer shows, while the app is locked or leaving the screen. */
export function LockLayer() {
  const { c } = useTokens()
  const { locked, covered } = useLockState()
  const biometry = useBiometryName()

  useEffect(() => {
    if (!locked || prompted || AppState.currentState !== 'active') return
    prompted = true
    void unlock()
  }, [locked])

  if (!locked && !covered) return null
  return (
    <View
      style={[StyleSheet.absoluteFill, styles.cover, { backgroundColor: c.bg }]}
      accessibilityViewIsModal
    >
      <HuliIcon size={72} />
      {locked && !covered ? (
        <>
          <Text style={[typeScale.headline, { color: c.text }]}>Huli 已锁定</Text>
          <Pill
            tone="tint"
            size="lg"
            label={biometry === '密码' ? '输入密码解锁' : `使用${biometry}解锁`}
            onPress={() => void unlock()}
            style={styles.button}
          />
        </>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  cover: {
    zIndex: 1000,
    elevation: 1000,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.lg,
  },
  button: { marginTop: space.sm },
})
