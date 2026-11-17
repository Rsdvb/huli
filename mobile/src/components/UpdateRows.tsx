// Settings › About on Android: the newest build, its download, and checking by hand.

import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { checkForUpdate, openUpdate, useUpdate } from '../update'
import { useTheme } from '../theme'

type Check = 'idle' | 'checking' | 'latest' | 'available' | 'failed'

const CHECK_TEXT: Record<Check, string> = {
  idle: '',
  checking: '正在检查…',
  latest: '已是最新',
  available: '有新版本',
  failed: '检查失败',
}

export function UpdateRows() {
  const theme = useTheme()
  const { latest } = useUpdate()
  const [check, setCheck] = useState<Check>('idle')
  const line = { borderBottomColor: theme.line, borderBottomWidth: StyleSheet.hairlineWidth }

  const checkNow = () => {
    setCheck('checking')
    checkForUpdate().then(
      (release) => setCheck(release ? 'available' : 'latest'),
      () => setCheck('failed'),
    )
  }

  return (
    <>
      {latest && (
        <>
          <View style={[styles.row, line]}>
            <Text style={{ color: theme.text, fontSize: 15 }}>最新版本</Text>
            <Text style={[styles.value, { color: theme.muted }]} numberOfLines={1}>
              {latest.version}
            </Text>
          </View>
          <Pressable
            onPress={() => openUpdate(latest)}
            style={({ pressed }) => [styles.row, line, { opacity: pressed ? 0.6 : 1 }]}
          >
            <Text style={{ color: theme.accent, fontSize: 15, fontWeight: '600' }}>下载新版本</Text>
          </Pressable>
        </>
      )}
      <Pressable
        onPress={checkNow}
        disabled={check === 'checking'}
        style={({ pressed }) => [styles.row, { opacity: pressed ? 0.6 : 1 }]}
      >
        <Text style={{ color: theme.accent, fontSize: 15 }}>检查更新</Text>
        <Text
          style={[styles.value, { color: check === 'failed' ? theme.danger : theme.muted }]}
          numberOfLines={1}
        >
          {CHECK_TEXT[check]}
        </Text>
      </Pressable>
    </>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  value: { fontSize: 15, flexShrink: 1, textAlign: 'right' },
})
