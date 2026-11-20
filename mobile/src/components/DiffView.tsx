// A unified diff: one fixed-height row per line in a virtualized list, wide enough for its longest
// line and scrolled sideways as a whole, so line numbers stay beside their lines. Rows grow with
// the system's text size up to the dense cap, as the file viewer's do (app/file.tsx).

import { memo, useCallback, useMemo, useState } from 'react'
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ListRenderItem,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { Diff, DiffRow } from '../diff'
import { MONO, useSessionTokens } from '../ui/session/palette'
import { FONT_SCALE, space } from '../ui/tokens'

export { MONO }

const FONT = 12
const ROW = 20
const PAGE = 1500
const PAD = 8
// A guess at the face's advance until the measuring line below reports it.
const GUESS = FONT * 0.6
const RULER = 'M'.repeat(40)

interface Colors {
  addBg: string
  delBg: string
  hunkBg: string
  hunk: string
  add: string
  del: string
  text: string
  muted: string
}

const SCALE = FONT_SCALE.dense

const Row = memo(function Row(props: {
  row: DiffRow
  colors: Colors
  gutter: number
  height: number
  sign: number
}) {
  const { row, colors, gutter, height } = props
  if (row.kind === 'hunk') {
    return (
      <View style={[styles.row, { height, backgroundColor: colors.hunkBg }]}>
        <Text
          style={[styles.text, { color: colors.hunk, paddingLeft: PAD }]}
          numberOfLines={1}
          maxFontSizeMultiplier={SCALE}
        >
          {row.text}
        </Text>
      </View>
    )
  }
  const bg = row.kind === 'add' ? colors.addBg : row.kind === 'del' ? colors.delBg : undefined
  const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '
  const signColor = row.kind === 'add' ? colors.add : colors.del
  return (
    <View style={[styles.row, { height }, bg ? { backgroundColor: bg } : null]}>
      <Text
        style={[styles.text, styles.number, { width: gutter, color: colors.muted }]}
        maxFontSizeMultiplier={SCALE}
      >
        {row.old ?? ''}
      </Text>
      <Text
        style={[styles.text, styles.number, { width: gutter, color: colors.muted }]}
        maxFontSizeMultiplier={SCALE}
      >
        {row.new ?? ''}
      </Text>
      <Text
        style={[styles.text, styles.sign, { width: props.sign, color: signColor }]}
        maxFontSizeMultiplier={SCALE}
      >
        {sign}
      </Text>
      <Text
        style={[styles.text, { color: colors.text }]}
        numberOfLines={1}
        maxFontSizeMultiplier={SCALE}
      >
        {row.text}
      </Text>
    </View>
  )
})

export function DiffView(props: { diff: Diff }) {
  const { diff } = props
  const { c } = useSessionTokens()
  const window = useWindowDimensions()
  const insets = useSafeAreaInsets()
  // React Native scales a line height with its text, so the styles keep the unscaled one.
  const scale = Math.min(window.fontScale, SCALE)
  const rowHeight = Math.ceil(ROW * scale)
  const signWidth = Math.ceil(FONT * scale)
  const [advance, setAdvance] = useState(GUESS * scale)
  const [limit, setLimit] = useState(PAGE)
  const colors = useMemo<Colors>(
    () => ({
      addBg: c.addedBg,
      delBg: c.removedBg,
      hunkBg: c.tintSoft,
      hunk: c.tint,
      add: c.added,
      del: c.removed,
      text: c.text,
      muted: c.textTertiary,
    }),
    [c],
  )
  const rows = useMemo(() => diff.rows.slice(0, limit), [diff.rows, limit])
  const gutter = Math.ceil(String(Math.max(diff.lastLine, 9)).length * advance) + PAD
  const width = Math.max(
    window.width,
    Math.ceil(gutter * 2 + advance * (diff.columns + 2) + PAD * 3),
  )
  const left = diff.rows.length - rows.length

  const renderItem = useCallback<ListRenderItem<DiffRow>>(
    ({ item }) => (
      <Row row={item} colors={colors} gutter={gutter} height={rowHeight} sign={signWidth} />
    ),
    [colors, gutter, rowHeight, signWidth],
  )

  return (
    <View style={{ flex: 1 }}>
      <Text
        style={[styles.text, styles.ruler]}
        maxFontSizeMultiplier={SCALE}
        onLayout={(event) => setAdvance(event.nativeEvent.layout.width / RULER.length)}
      >
        {RULER}
      </Text>
      <ScrollView horizontal directionalLockEnabled bounces={false} style={{ flex: 1 }}>
        <FlatList
          style={{ width }}
          data={rows}
          keyExtractor={(_, index) => String(index)}
          renderItem={renderItem}
          getItemLayout={(_, index) => ({ length: rowHeight, offset: rowHeight * index, index })}
          initialNumToRender={40}
          maxToRenderPerBatch={60}
          windowSize={11}
          ListFooterComponent={
            left > 0 ? (
              <View
                style={{
                  width: window.width,
                  padding: space.lg,
                  paddingBottom: space.lg + insets.bottom,
                }}
              >
                <Pressable
                  onPress={() => setLimit((n) => n + PAGE)}
                  style={({ pressed }) => [
                    styles.more,
                    { backgroundColor: c.fillStrong, opacity: pressed ? 0.6 : 1 },
                  ]}
                >
                  <Text style={{ color: c.text, fontSize: 14, fontWeight: '600' }}>
                    显示更多（还有 {left} 行）
                  </Text>
                </Pressable>
              </View>
            ) : (
              <View style={{ height: space.xl + insets.bottom }} />
            )
          }
        />
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  text: { fontFamily: MONO, fontSize: FONT, lineHeight: ROW },
  number: { textAlign: 'right', paddingRight: PAD },
  sign: { textAlign: 'center', marginRight: space.xs },
  ruler: { position: 'absolute', opacity: 0, left: 0, top: 0 },
  more: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
})
