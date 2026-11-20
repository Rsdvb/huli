// Settings › 面容 ID 与锁定: whether Huli locks, how long it may be away first, and whether
// notifications keep what they are about to themselves.

import { Alert, Animated, Switch } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useMaybeLink } from '../../host'
import { authenticate, useBiometryName } from '../../lock'
import { LOCK_DELAYS, setPrefs, usePrefs, type LockDelay } from '../../prefs'
import { pushChoicesChanged } from '../../push/sync'
import { errorText } from '../../sessions'
import { THIS_DEVICE } from '../../system/device'
import { haptic } from '../../ui/haptics'
import { Icon } from '../../ui/Icon'
import { ListGroup, ListRow } from '../../ui/ListRow'
import { NavBar } from '../../ui/NavBar'
import { Screen } from '../../ui/Screen'
import { useCollapsingHeader } from '../../ui/ScrollHeader'
import { space, useTokens } from '../../ui/tokens'

const DELAY_TEXT: Record<LockDelay, string> = {
  0: '立即',
  60: '1 分钟后',
  300: '5 分钟后',
  900: '15 分钟后',
  3600: '1 小时后',
}

export default function LockSettings() {
  const { c } = useTokens()
  const link = useMaybeLink()
  const prefs = usePrefs()
  const header = useCollapsingHeader()
  const insets = useSafeAreaInsets()
  const biometry = useBiometryName()

  const toggleLock = async (on: boolean) => {
    const result = await authenticate(on ? `开启${biometry}锁定` : `关闭${biometry}锁定`)
    if (result.ok) {
      haptic.select()
      setPrefs({ lock: on })
    } else if (result.error === 'passcode_not_set' || result.error === 'not_available') {
      haptic.warning()
      Alert.alert(`${THIS_DEVICE}没有设置密码`, '先在系统设置里设置锁屏密码，才能用它锁定纸鸢。')
    }
  }

  return (
    <Screen>
      <Animated.ScrollView
        {...header.scrollProps}
        contentContainerStyle={{
          paddingTop: header.contentTop + space.md,
          paddingHorizontal: space.lg,
          paddingBottom: insets.bottom + space.xxxl,
          gap: space.xxl,
        }}
      >
        <ListGroup
          footer={`开启后，多任务界面里看不到纸鸢的画面；离开纸鸢超过下面选的时间，再打开时需要${biometry}或密码。`}
        >
          <ListRow
            title={`需要${biometry}`}
            icon="faceId"
            plainIcon
            trailing={
              <Switch
                value={prefs.lock}
                onValueChange={(on) => void toggleLock(on)}
                trackColor={{ true: c.success }}
                accessibilityLabel={`需要${biometry}`}
              />
            }
          />
        </ListGroup>

        <ListGroup header="离开多久后锁定">
          {LOCK_DELAYS.map((delay) => (
            <ListRow
              key={delay}
              title={DELAY_TEXT[delay]}
              disabled={!prefs.lock}
              trailing={
                prefs.lockAfter === delay ? (
                  <Icon name="check" size={18} color={c.tint} weight="semibold" />
                ) : undefined
              }
              onPress={() => {
                haptic.select()
                setPrefs({ lockAfter: delay })
              }}
            />
          ))}
        </ListGroup>

        <ListGroup
          header="通知"
          footer="开启后，通知只说是哪类事（比如“回复完成”“需要你确认”），不显示会话标题和内容。锁屏上也一样。"
        >
          <ListRow
            title="通知中隐藏内容"
            icon="eyeSlash"
            plainIcon
            trailing={
              <Switch
                value={prefs.hidePreviews}
                onValueChange={(on) => {
                  haptic.select()
                  setPrefs({ hidePreviews: on })
                  void pushChoicesChanged(link).catch((failure: unknown) =>
                    Alert.alert('没能更新通知设置', errorText(failure)),
                  )
                }}
                trackColor={{ true: c.success }}
                accessibilityLabel="通知中隐藏内容"
              />
            }
          />
        </ListGroup>
      </Animated.ScrollView>
      <NavBar header={header} title={`${biometry}与锁定`} titleAlways />
    </Screen>
  )
}
