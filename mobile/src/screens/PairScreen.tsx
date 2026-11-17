// Pairing: scan the code the computer shows in Settings › Remote access, or paste its link; the
// owner then allows the phone on the computer.

import { useRef, useState } from 'react'
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { CameraView, useCameraPermissions } from 'expo-camera'
import type { KeyPair } from '@shared/remote/noise'
import type { Paired, PairFailure } from '@shared/remote/pair'
import type { PairingPayload } from '@shared/remote/pairing'
import { pairWith, parseScanned } from '../connection'
import type { SavedHost } from '../store'
import { Glass } from '../ui/GlassTabBar'
import { haptic } from '../ui/haptics'
import { Icon } from '../ui/Icon'
import { Press } from '../ui/Press'
import { Screen } from '../ui/Screen'
import { radius, size as sizes, space, type as typeScale, useTokens } from '../ui/tokens'

const FAILURES: Record<PairFailure, string> = {
  void: '这个配对码已经失效或用过了，请在电脑上重新显示二维码。',
  rejected: '电脑上拒绝了这台手机。',
  unreachable: '连不上电脑。确认手机和电脑在同一个网络，或者都开着 Tailscale。',
  update_client: '这个 App 版本太旧，电脑上的 Huli 不支持，请更新 App。',
  update_host: '电脑上的 Huli 版本太旧，请先更新电脑端。',
  relay_off: '这个配对码需要中继，而 Huli 不使用中继。请在电脑上用直连的二维码。',
  wrong_account: '这个配对码属于另一个账号。',
  host_offline: '电脑现在不在线。',
}

const STEPS = [
  '在电脑上的 Huli 里打开「设置 › 远程访问」并开启。',
  '手机和电脑连同一个网络，或者都开着 Tailscale。',
  '扫描电脑上显示的二维码，再在电脑上点「允许」。',
]

type Step =
  { kind: 'start'; error: string | null } | { kind: 'scan' } | { kind: 'working'; text: string }

export function PairScreen(props: {
  notice: string | null
  onPaired(host: SavedHost, key: KeyPair, paired: Paired): void
}) {
  const { c } = useTokens()
  const insets = useSafeAreaInsets()
  const [permission, requestPermission] = useCameraPermissions()
  const [step, setStep] = useState<Step>({ kind: 'start', error: props.notice })
  const [pasting, setPasting] = useState(false)
  const [link, setLink] = useState('')
  const scanned = useRef(false)

  const run = async (payload: PairingPayload | null) => {
    if (!payload) {
      haptic.warning()
      setStep({ kind: 'start', error: '这不是 Huli 的配对码。' })
      return
    }
    setStep({ kind: 'working', text: '正在连接电脑…' })
    let failure: PairFailure | null = null
    try {
      const result = await pairWith(payload, (progress) => {
        if (progress.state === 'connecting') setStep({ kind: 'working', text: '正在连接电脑…' })
        if (progress.state === 'waiting') {
          setStep({ kind: 'working', text: '请在电脑上点「允许」，让这台手机连接。' })
        }
        if (progress.state === 'failed') failure = progress.reason
      })
      if (result) {
        haptic.success()
        return props.onPaired(result.host, result.key, result.paired)
      }
      haptic.warning()
      setStep({ kind: 'start', error: FAILURES[failure ?? 'unreachable'] })
    } catch (error) {
      haptic.warning()
      setStep({ kind: 'start', error: `配对失败：${(error as Error).message}` })
    }
  }

  const scan = async () => {
    const granted = permission?.granted || (await requestPermission()).granted
    if (!granted) {
      setStep({
        kind: 'start',
        error: '没有相机权限。可以到「设置 › Huli」里打开，或者粘贴配对链接。',
      })
      return
    }
    scanned.current = false
    setStep({ kind: 'scan' })
  }

  if (step.kind === 'scan') {
    return (
      <View style={[styles.flex, { backgroundColor: c.shadow }]}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            // The camera reports the code on every frame it sees it; the first one counts.
            if (scanned.current) return
            scanned.current = true
            haptic.tap()
            void run(parseScanned(data))
          }}
        />
        <View style={styles.viewfinderWrap} pointerEvents="none">
          <View style={[styles.viewfinder, { borderColor: c.onAccent }]} />
        </View>
        <View style={[styles.scanBar, { paddingBottom: insets.bottom + space.xl }]}>
          <Text style={[typeScale.callout, styles.center, { color: c.onAccent }]}>
            对准电脑上「设置 › 远程访问」里的二维码
          </Text>
          <Press
            onPress={() => setStep({ kind: 'start', error: null })}
            accessibilityRole="button"
            style={styles.scanCancel}
          >
            <Glass round={radius.pill} />
            <Text style={[typeScale.body, { color: c.text, fontWeight: '600' }]}>取消</Text>
          </Press>
        </View>
      </View>
    )
  }

  return (
    <Screen edges={['top']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + space.xl }]}
          keyboardShouldPersistTaps="handled"
        >
          <Image
            source={require('../../assets/icon.png')}
            style={styles.appIcon}
            accessibilityIgnoresInvertColors
          />
          <Text style={[typeScale.hero, { color: c.text }]}>连接你的电脑</Text>
          <Text style={[typeScale.body, { color: c.textSecondary }]}>
            Huli 在手机上看着、指挥电脑上的智能体。配对一次，之后打开就连上。
          </Text>

          <View style={[styles.steps, { backgroundColor: c.surface, borderColor: c.border }]}>
            {STEPS.map((text, i) => (
              <View key={text} style={styles.stepRow}>
                <View style={[styles.stepNumber, { backgroundColor: c.tintSoft }]}>
                  <Text style={[typeScale.subhead, { color: c.tint, fontWeight: '700' }]}>
                    {i + 1}
                  </Text>
                </View>
                <Text style={[typeScale.callout, styles.flex, { color: c.text }]}>{text}</Text>
              </View>
            ))}
          </View>

          {step.kind === 'working' ? (
            <View style={[styles.working, { backgroundColor: c.fill }]}>
              <ActivityIndicator color={c.textSecondary} />
              <Text style={[typeScale.callout, styles.flex, { color: c.text }]}>{step.text}</Text>
            </View>
          ) : (
            <>
              {step.error ? (
                <View style={[styles.error, { backgroundColor: c.removedBg }]}>
                  <Icon name="warning" size={18} color={c.danger} />
                  <Text style={[typeScale.callout, styles.flex, { color: c.text }]}>
                    {step.error}
                  </Text>
                </View>
              ) : null}

              <Press
                onPress={() => void scan()}
                accessibilityRole="button"
                style={[styles.primary, { backgroundColor: c.accent }]}
              >
                <Icon name="scan" size={20} color={c.onAccent} weight="semibold" />
                <Text style={[typeScale.headline, { color: c.onAccent }]}>扫描二维码</Text>
              </Press>

              {pasting ? (
                <View style={styles.paste}>
                  <TextInput
                    value={link}
                    onChangeText={setLink}
                    autoFocus
                    placeholder="https://…/pair#…"
                    placeholderTextColor={c.textTertiary}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="go"
                    onSubmitEditing={() => link.trim() && void run(parseScanned(link))}
                    style={[
                      typeScale.body,
                      styles.input,
                      { color: c.text, backgroundColor: c.fill },
                    ]}
                  />
                  <Press
                    disabled={!link.trim()}
                    onPress={() => void run(parseScanned(link))}
                    accessibilityRole="button"
                    style={[styles.secondary, { backgroundColor: c.fillStrong }]}
                  >
                    <Text style={[typeScale.headline, { color: c.text }]}>用链接配对</Text>
                  </Press>
                </View>
              ) : (
                <Press
                  onPress={() => setPasting(true)}
                  accessibilityRole="button"
                  style={styles.linkButton}
                >
                  <Icon name="link" size={16} color={c.tint} />
                  <Text style={[typeScale.callout, { color: c.tint }]}>改用配对链接</Text>
                </Press>
              )}
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  center: { textAlign: 'center' },
  page: { paddingHorizontal: space.xl + 4, paddingTop: space.xxxl, gap: space.lg },
  appIcon: { width: 72, height: 72, borderRadius: 18, marginBottom: space.sm },
  steps: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.lg,
    gap: space.lg,
    marginTop: space.sm,
  },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  stepNumber: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  working: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.lg,
  },
  error: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm + 2,
    padding: space.md + 2,
    borderRadius: radius.md,
  },
  primary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    height: 54,
    borderRadius: radius.pill,
    marginTop: space.sm,
  },
  paste: { gap: space.sm + 2 },
  input: { borderRadius: radius.md, paddingHorizontal: space.lg, height: 50 },
  secondary: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 50,
    borderRadius: radius.pill,
  },
  linkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm - 2,
    minHeight: sizes.hit,
  },
  viewfinderWrap: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  viewfinder: { width: 240, height: 240, borderRadius: radius.xl, borderWidth: 2, opacity: 0.85 },
  scanBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: space.xl,
    alignItems: 'center',
    gap: space.lg,
  },
  scanCancel: {
    paddingHorizontal: space.xxl,
    height: 48,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
})
