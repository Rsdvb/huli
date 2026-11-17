// Pairing: scan the code the computer shows in Settings › Remote access, or paste its link; the
// owner then allows the phone on the computer.

import { useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { CameraView, useCameraPermissions } from 'expo-camera'
import type { KeyPair } from '@shared/remote/noise'
import type { Paired, PairFailure } from '@shared/remote/pair'
import type { PairingPayload } from '@shared/remote/pairing'
import { pairWith, parseScanned } from '../connection'
import type { SavedHost } from '../store'
import { useTheme } from '../theme'

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

type Step =
  | { kind: 'start'; error: string | null }
  | { kind: 'scan' }
  | { kind: 'working'; text: string }

export function PairScreen(props: {
  notice: string | null
  onPaired(host: SavedHost, key: KeyPair, paired: Paired): void
}) {
  const theme = useTheme()
  const [permission, requestPermission] = useCameraPermissions()
  const [step, setStep] = useState<Step>({ kind: 'start', error: props.notice })
  const [link, setLink] = useState('')
  const scanned = useRef(false)

  const run = async (payload: PairingPayload | null) => {
    if (!payload) {
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
      if (result) return props.onPaired(result.host, result.key, result.paired)
      setStep({ kind: 'start', error: FAILURES[failure ?? 'unreachable'] })
    } catch (error) {
      setStep({ kind: 'start', error: `配对失败：${(error as Error).message}` })
    }
  }

  const scan = async () => {
    const granted = permission?.granted || (await requestPermission()).granted
    if (!granted) {
      setStep({ kind: 'start', error: '没有相机权限。可以到「设置 › Huli」里打开，或者粘贴配对链接。' })
      return
    }
    scanned.current = false
    setStep({ kind: 'scan' })
  }

  if (step.kind === 'scan') {
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            // The camera reports the code on every frame it sees it; the first one counts.
            if (scanned.current) return
            scanned.current = true
            void run(parseScanned(data))
          }}
        />
        <SafeAreaView edges={['bottom']} style={styles.scanBar}>
          <Text style={styles.scanText}>对准电脑上「设置 › 远程访问」里的二维码</Text>
          <Pressable onPress={() => setStep({ kind: 'start', error: null })} style={styles.scanCancel}>
            <Text style={{ color: '#fff', fontSize: 16 }}>取消</Text>
          </Pressable>
        </SafeAreaView>
      </View>
    )
  }

  return (
    <SafeAreaView style={[styles.page, { backgroundColor: theme.bg }]}>
      <View style={[styles.mark, { backgroundColor: theme.accent }]}>
        <Text style={styles.markText}>狐</Text>
      </View>
      <Text style={[styles.title, { color: theme.text }]}>连接你的电脑</Text>
      <Text style={[styles.lead, { color: theme.muted }]}>
        在电脑上的 Huli 里打开「设置 › 远程访问」，开启后会显示一个二维码。手机和电脑要在同一个网络，或者都开着 Tailscale。
      </Text>

      {step.kind === 'working' ? (
        <View style={styles.working}>
          <ActivityIndicator color={theme.accent} />
          <Text style={[styles.lead, { color: theme.text, marginTop: 12 }]}>{step.text}</Text>
        </View>
      ) : (
        <>
          <Pressable
            onPress={() => void scan()}
            style={({ pressed }) => [
              styles.primary,
              { backgroundColor: theme.accent, opacity: pressed ? 0.8 : 1 },
            ]}
          >
            <Text style={[styles.primaryText, { color: theme.accentText }]}>扫描二维码</Text>
          </Pressable>

          <Text style={[styles.or, { color: theme.muted }]}>或者粘贴配对链接</Text>
          <TextInput
            value={link}
            onChangeText={setLink}
            placeholder="https://…/pair#…"
            placeholderTextColor={theme.muted}
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.input, { color: theme.text, borderColor: theme.line, backgroundColor: theme.card }]}
          />
          <Pressable
            disabled={!link.trim()}
            onPress={() => void run(parseScanned(link))}
            style={({ pressed }) => [
              styles.secondary,
              { borderColor: theme.line, opacity: !link.trim() ? 0.4 : pressed ? 0.7 : 1 },
            ]}
          >
            <Text style={{ color: theme.text, fontSize: 16 }}>用链接配对</Text>
          </Pressable>

          {step.error && <Text style={[styles.error, { color: theme.danger }]}>{step.error}</Text>}
        </>
      )}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1, paddingHorizontal: 24, paddingTop: 48 },
  mark: { width: 56, height: 56, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  markText: { color: '#fff', fontSize: 30, fontWeight: '700' },
  title: { fontSize: 28, fontWeight: '700', marginTop: 24 },
  lead: { fontSize: 15, lineHeight: 22, marginTop: 8 },
  working: { marginTop: 40, alignItems: 'center' },
  primary: { marginTop: 32, borderRadius: 12, paddingVertical: 14, alignItems: 'center' },
  primaryText: { fontSize: 17, fontWeight: '600' },
  or: { marginTop: 28, fontSize: 13 },
  input: { marginTop: 8, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  secondary: { marginTop: 10, borderWidth: 1, borderRadius: 12, paddingVertical: 12, alignItems: 'center' },
  error: { marginTop: 20, fontSize: 14, lineHeight: 20 },
  scanBar: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: 24, alignItems: 'center' },
  scanText: { color: '#fff', fontSize: 15, marginBottom: 16, textAlign: 'center' },
  scanCancel: { paddingVertical: 10, paddingHorizontal: 28, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.2)' },
})
