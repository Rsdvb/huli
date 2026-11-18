// 连接账号里的电脑: pairs with a computer of the phone's Huli Cloud account without its code. The
// phone asks the computer through the relay, both show the same six digits, the computer's owner
// allows the phone there and the user here says the digits match; then it is kept like a computer
// paired by its code.

import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router, useLocalSearchParams } from 'expo-router'
import type { AccountPairFailure, AccountPairing } from '@shared/remote/pair-account'
import { listAccount } from '../cloud'
import { pairWithAccount } from '../connection'
import { useHost } from '../host'
import { LockLayer } from '../lock'
import { haptic } from '../ui/haptics'
import { Icon } from '../ui/Icon'
import { OsIcon } from '../ui/OsIcon'
import { Press } from '../ui/Press'
import { Screen } from '../ui/Screen'
import { radius, size as sizes, space, type as typeScale, useTokens } from '../ui/tokens'

const FAILURES: Record<AccountPairFailure, string> = {
  void: '电脑结束了这次请求，请再试一次。',
  rejected: '电脑上拒绝了这台手机。',
  busy: '电脑正在处理另一台设备的请求，稍后再试。',
  cooling_down: '电脑上的请求被拒绝太多次，暂时不接受新的请求，过十分钟再试。',
  update_client: '这个 App 版本太旧，电脑上的 Huli 不支持，请更新 App。',
  update_host: '电脑上的 Huli 版本太旧，请先更新电脑端。',
  refused:
    '电脑没有接受请求：它可能关了「让账号下的设备找到这台电脑」，或者账号里记的不是它的密钥。',
  host_offline: '电脑现在不在线。打开电脑上的 Huli，并在「设置 › 远程访问」里开着中转。',
  wrong_account: '这台电脑不在你的 Huli Cloud 账号下，或者这台手机已退出登录。',
  unreachable: '连不上 Huli Cloud 的中转，检查网络后再试。',
  cancelled: '已取消。',
}

type Step =
  | { kind: 'connecting' }
  | { kind: 'compare'; code: string; matched: boolean }
  | { kind: 'failed'; text: string }

export default function PairComputer() {
  const { c } = useTokens()
  const insets = useSafeAreaInsets()
  const host = useHost()
  const params = useLocalSearchParams<{ id?: string; name?: string; platform?: string }>()
  const [step, setStep] = useState<Step>({ kind: 'connecting' })
  const [attempt, setAttempt] = useState(0)
  const pairing = useRef<AccountPairing | null>(null)
  const name = params.name || '电脑'

  const close = () => {
    pairing.current?.cancel()
    if (router.canGoBack()) router.back()
    else router.replace('/')
  }

  useEffect(() => {
    let live = true
    const id = params.id
    setStep({ kind: 'connecting' })
    void (async () => {
      // The key comes from the account's list as it is now, never from the link that opened this.
      const listed = await listAccount().catch(() => null)
      const computer = listed?.computers.find((c) => c.id === id)
      if (!live) return
      if (!listed) return setStep({ kind: 'failed', text: '读不到账号里的电脑，检查网络后再试。' })
      if (!computer?.key) return setStep({ kind: 'failed', text: '账号里没有这台电脑了。' })
      if (!computer.online) return setStep({ kind: 'failed', text: FAILURES.host_offline })
      const started = await pairWithAccount({ id: computer.id, key: computer.key }, (state) => {
        if (!live) return
        if (state.state === 'compare') {
          setStep({ kind: 'compare', code: state.code, matched: state.matched })
        } else if (state.state === 'failed') {
          if (state.reason !== 'cancelled') haptic.warning()
          setStep({ kind: 'failed', text: FAILURES[state.reason] })
        }
      })
      if (!live) return started.pairing.cancel()
      pairing.current = started.pairing
      const done = await started.finished
      if (!done || !live) return
      haptic.success()
      pairing.current = null
      if (router.canDismiss()) router.dismissAll()
      void host.paired(done.host, done.key, done.paired)
    })()
    return () => {
      live = false
      pairing.current?.cancel()
      pairing.current = null
    }
    // A new attempt starts it over; the host's actions stay the same for the app's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id, attempt])

  const answer = (same: boolean) => {
    haptic.tap()
    pairing.current?.match(same)
  }

  return (
    <>
      <Screen edges={['top']}>
        <ScrollView
          contentContainerStyle={[styles.page, { paddingBottom: insets.bottom + space.xl }]}
        >
          <Press onPress={close} accessibilityRole="button" hitSlop={10} style={styles.cancel}>
            <Text style={[typeScale.body, { color: c.tint }]}>取消</Text>
          </Press>
          <View style={[styles.icon, { backgroundColor: c.tintSoft }]}>
            <OsIcon platform={params.platform} size={30} color={c.tint} />
          </View>
          <Text style={[typeScale.title, { color: c.text }]}>连接「{name}」</Text>

          {step.kind === 'connecting' ? (
            <View style={[styles.working, { backgroundColor: c.fill }]}>
              <ActivityIndicator color={c.textSecondary} />
              <Text style={[typeScale.callout, styles.flex, { color: c.text }]}>
                正在通过 Huli Cloud 联系电脑…
              </Text>
            </View>
          ) : null}

          {step.kind === 'compare' ? (
            <>
              <Text style={[typeScale.body, { color: c.textSecondary }]}>
                电脑上会弹出「要添加这台设备吗？」。核对那里的数字和下面一样，再在电脑上点「添加」。
                不一样的话，点「不一致」——可能有人在冒充这台电脑。
              </Text>
              <View
                style={[styles.codeBox, { backgroundColor: c.surface, borderColor: c.border }]}
                accessible
                accessibilityLabel={`配对数字 ${step.code.split('').join(' ')}`}
              >
                <Text style={[styles.code, { color: c.text }]} selectable={false}>
                  {`${step.code.slice(0, 3)} ${step.code.slice(3)}`}
                </Text>
              </View>
              {step.matched ? (
                <View style={[styles.working, { backgroundColor: c.fill }]}>
                  <ActivityIndicator color={c.textSecondary} />
                  <Text style={[typeScale.callout, styles.flex, { color: c.text }]}>
                    请在电脑上点「添加」，让这台手机连接。
                  </Text>
                </View>
              ) : (
                <View style={styles.buttons}>
                  <Press
                    onPress={() => answer(true)}
                    accessibilityRole="button"
                    style={[styles.primary, { backgroundColor: c.accent }]}
                  >
                    <Icon name="check" size={18} color={c.onAccent} weight="semibold" />
                    <Text style={[typeScale.headline, { color: c.onAccent }]}>数字一致</Text>
                  </Press>
                  <Press
                    onPress={() => answer(false)}
                    accessibilityRole="button"
                    style={[styles.secondary, { backgroundColor: c.fillStrong }]}
                  >
                    <Text style={[typeScale.headline, { color: c.danger }]}>不一致</Text>
                  </Press>
                </View>
              )}
            </>
          ) : null}

          {step.kind === 'failed' ? (
            <>
              <View style={[styles.error, { backgroundColor: c.removedBg }]}>
                <Icon name="warning" size={18} color={c.danger} />
                <Text style={[typeScale.callout, styles.flex, { color: c.text }]}>{step.text}</Text>
              </View>
              <Press
                onPress={() => setAttempt((n) => n + 1)}
                accessibilityRole="button"
                style={[styles.primary, { backgroundColor: c.accent }]}
              >
                <Icon name="refresh" size={18} color={c.onAccent} weight="semibold" />
                <Text style={[typeScale.headline, { color: c.onAccent }]}>再试一次</Text>
              </Press>
            </>
          ) : null}

          <Text style={[typeScale.footnote, { color: c.textTertiary }]}>
            Huli Cloud
            只负责转交加密的连接，看不到内容；它也无法替你完成配对——那需要电脑上的同意和这里的数字核对。
          </Text>
        </ScrollView>
      </Screen>
      <LockLayer />
    </>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  page: { paddingHorizontal: space.xl + 4, paddingTop: space.xxxl, gap: space.lg },
  cancel: { alignSelf: 'flex-end', minHeight: sizes.hit, justifyContent: 'center' },
  icon: {
    width: 64,
    height: 64,
    borderRadius: radius.lg,
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
  codeBox: {
    alignItems: 'center',
    paddingVertical: space.xl,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
  },
  code: { ...typeScale.stat, letterSpacing: space.sm, fontVariant: ['tabular-nums'] },
  buttons: { gap: space.sm + 2 },
  primary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    height: 54,
    borderRadius: radius.pill,
  },
  secondary: {
    alignItems: 'center',
    justifyContent: 'center',
    height: 50,
    borderRadius: radius.pill,
  },
  error: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm + 2,
    padding: space.md + 2,
    borderRadius: radius.md,
  },
})
