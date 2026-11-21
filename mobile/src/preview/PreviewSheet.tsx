// The sheet a file's preview shows while its download takes a while: the file, how much has come
// of how much, and 取消; then why it could not open, with what to do next. The root layout holds it
// once, over every screen; `previewFile` drives it (preview.ts).

import { useState } from 'react'
import { Platform, StyleSheet, Text, View } from 'react-native'
import { formatBytes } from '../attachments'
import { useConnected } from '../host'
import { Button, Buttons } from '../manage/kit'
import { BottomSheet } from '../ui/BottomSheet'
import { Icon } from '../ui/Icon'
import { FileMark } from '../ui/session/icons'
import { radius, space, type as typeScale, useTokens } from '../ui/tokens'
import {
  closePreview,
  retryPreview,
  shareUnviewable,
  usePreview,
  type PreviewPhase,
} from './preview'

/** What the action that hands a file to another app says. */
export const SHARE_LABEL = '用其他 App 打开 / 分享'

export function PreviewSheet() {
  const { phase, sheet } = usePreview()
  // The sheet slides away showing what it showed, not an empty sheet.
  const [shown, setShown] = useState<Exclude<PreviewPhase, { kind: 'idle' }> | null>(null)
  if (phase.kind !== 'idle' && phase !== shown) setShown(phase)
  return (
    <BottomSheet visible={sheet && phase.kind !== 'idle'} onClose={closePreview} solid>
      {shown ? <Body phase={shown} /> : null}
    </BottomSheet>
  )
}

function Body(props: { phase: Exclude<PreviewPhase, { kind: 'idle' }> }) {
  const { c } = useTokens()
  const connected = useConnected()
  const { phase } = props
  return (
    <View style={styles.body}>
      <View style={styles.file}>
        <FileMark path={phase.name} size={22} />
        <Text
          style={[typeScale.headline, styles.name, { color: c.text }]}
          numberOfLines={2}
          ellipsizeMode="middle"
        >
          {phase.name}
        </Text>
      </View>
      {phase.kind === 'downloading' ? (
        <Downloading phase={phase} connected={connected} />
      ) : (
        <View
          style={[styles.note, { backgroundColor: phase.kind === 'failed' ? c.removedBg : c.fill }]}
        >
          <Icon
            name={phase.kind === 'failed' ? 'warning' : 'info'}
            size={18}
            color={phase.kind === 'failed' ? c.danger : c.textSecondary}
          />
          <Text style={[typeScale.callout, styles.flex, { color: c.text }]}>{phase.text}</Text>
        </View>
      )}
      <Buttons style={styles.buttons}>
        {phase.kind === 'failed' && phase.retry ? (
          <Button label="重试" tone="primary" icon="refresh" wide onPress={retryPreview} />
        ) : null}
        {phase.kind === 'unviewable' ? (
          <Button
            label={Platform.OS === 'ios' ? SHARE_LABEL : '分享'}
            tone="primary"
            icon="external"
            wide
            onPress={shareUnviewable}
          />
        ) : null}
        <Button
          label={phase.kind === 'downloading' ? '取消' : '关闭'}
          wide
          onPress={closePreview}
        />
      </Buttons>
    </View>
  )
}

function Downloading(props: {
  phase: Extract<PreviewPhase, { kind: 'downloading' }>
  connected: boolean
}) {
  const { c } = useTokens()
  const { written, size } = props.phase
  const share = size ? Math.min(1, written / size) : 0
  const text =
    !props.connected && written === 0
      ? '正在连接电脑…'
      : size
        ? `正在从电脑下载 · ${formatBytes(written)} / ${formatBytes(size)}`
        : '正在从电脑下载…'
  return (
    <View style={styles.progress}>
      <View
        style={[styles.track, { backgroundColor: c.track }]}
        accessibilityRole="progressbar"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(share * 100) }}
      >
        <View style={[styles.fill, { backgroundColor: c.tint, transform: [{ scaleX: share }] }]} />
      </View>
      <Text style={[typeScale.footnote, { color: c.textSecondary }]}>{text}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  body: { gap: space.lg, paddingTop: space.xs },
  file: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  name: { flex: 1 },
  progress: { gap: space.sm },
  track: { height: 6, borderRadius: radius.pill, overflow: 'hidden' },
  fill: { height: '100%', width: '100%', transformOrigin: 'left' },
  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
  },
  buttons: { marginTop: space.xs },
})
