// A unified diff: one fixed-height row per line in a virtualized list, wide enough for its longest
// line and scrolled sideways as a whole, so line numbers stay beside their lines. Rows grow with
// the system's text size up to the dense cap, as the file viewer's do (app/file.tsx). Where lines
// take comments, a tap picks a line or stretches the pick, a long press comments, and the rows a
// comment covers carry a bar by their numbers; only the rows whose state changed draw again.
// Huli: rows a review's finding sits on carry a bar of its severity's color.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  pickBg: string
  note: string
}

const SCALE = FONT_SCALE.dense

const Row = memo(function Row(props: {
  row: DiffRow
  index: number
  colors: Colors
  gutter: number
  height: number
  sign: number
  picked: boolean
  noted: boolean
  /** The color of a finding's severity, for a row a finding sits on. */
  flag: string | null
  onPress: ((index: number) => void) | undefined
  onLongPress: ((index: number) => void) | undefined
}) {
  const { row, colors, gutter, height, index, onPress, onLongPress } = props
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
  const bg = props.picked
    ? colors.pickBg
    : row.kind === 'add'
      ? colors.addBg
      : row.kind === 'del'
        ? colors.delBg
        : undefined
  const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '
  const signColor = row.kind === 'add' ? colors.add : colors.del
  const numberColor = props.noted ? colors.note : colors.muted
  const cells = (
    <>
      {props.noted || props.picked ? (
        <View style={[styles.noteBar, { backgroundColor: colors.note }]} />
      ) : props.flag ? (
        <View style={[styles.noteBar, { backgroundColor: props.flag }]} />
      ) : null}
      <Text
        style={[styles.text, styles.number, { width: gutter, color: numberColor }]}
        maxFontSizeMultiplier={SCALE}
      >
        {row.old ?? ''}
      </Text>
      <Text
        style={[styles.text, styles.number, { width: gutter, color: numberColor }]}
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
    </>
  )
  const style = [styles.row, { height }, bg ? { backgroundColor: bg } : null]
  if (!onPress) return <View style={style}>{cells}</View>
  return (
    <Pressable
      style={style}
      onPress={() => onPress(index)}
      {...(onLongPress ? { onLongPress: () => onLongPress(index), delayLongPress: 350 } : {})}
      accessibilityRole="button"
      accessibilityState={{ selected: props.picked }}
    >
      {cells}
    </Pressable>
  )
})

const NONE: ReadonlySet<number> = new Set()
const NO_FLAGS: ReadonlyMap<number, string> = new Map()

export function DiffView(props: {
  diff: Diff
  /** The rows picked to comment on, first and last, by index into the diff's rows. */
  picked?: readonly [number, number] | null
  /** The rows a comment in the draft covers. */
  noted?: ReadonlySet<number>
  onPressRow?: (index: number) => void
  onLongPressRow?: (index: number) => void
  /** Room under the last row for a bar laid over the list's bottom. */
  bottomInset?: number
  /** The rows a review's finding sits on, with its severity's color. */
  flags?: ReadonlyMap<number, string>
  /** A row to scroll to, as a step to a finding asks; `at` tells one ask from the next. */
  focus?: { row: number; at: number } | null
}) {
  const {
    diff,
    picked = null,
    noted = NONE,
    flags = NO_FLAGS,
    focus = null,
    onPressRow,
    onLongPressRow,
  } = props
  const { c, s } = useSessionTokens()
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
      pickBg: s.accentSoft,
      note: c.accent,
    }),
    [c, s],
  )
  const rows = useMemo(() => diff.rows.slice(0, limit), [diff.rows, limit])
  const list = useRef<FlatList<DiffRow>>(null)
  // A row past the rows drawn so far is drawn first, then scrolled to.
  const focusRow = focus?.row ?? null
  const focusAt = focus?.at ?? 0
  useEffect(() => {
    if (focusRow === null) return
    if (focusRow >= limit) {
      setLimit(Math.ceil((focusRow + 1) / PAGE) * PAGE)
      return
    }
    list.current?.scrollToIndex({ index: focusRow, viewPosition: 0.3, animated: true })
  }, [focusRow, focusAt, limit])
  const gutter = Math.ceil(String(Math.max(diff.lastLine, 9)).length * advance) + PAD
  const width = Math.max(
    window.width,
    Math.ceil(gutter * 2 + advance * (diff.columns + 2) + PAD * 3),
  )
  const left = diff.rows.length - rows.length

  const first = picked?.[0] ?? -1
  const last = picked?.[1] ?? -1
  const renderItem = useCallback<ListRenderItem<DiffRow>>(
    ({ item, index }) => (
      <Row
        row={item}
        index={index}
        colors={colors}
        gutter={gutter}
        height={rowHeight}
        sign={signWidth}
        picked={index >= first && index <= last}
        noted={noted.has(index)}
        flag={flags.get(index) ?? null}
        onPress={item.kind === 'hunk' ? undefined : onPressRow}
        onLongPress={item.kind === 'hunk' ? undefined : onLongPressRow}
      />
    ),
    [colors, gutter, rowHeight, signWidth, first, last, noted, flags, onPressRow, onLongPressRow],
  )
  const bottom = props.bottomInset ?? 0

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
          ref={list}
          style={{ width }}
          data={rows}
          keyExtractor={(_, index) => String(index)}
          renderItem={renderItem}
          getItemLayout={(_, index) => ({ length: rowHeight, offset: rowHeight * index, index })}
          extraData={renderItem}
          initialNumToRender={40}
          maxToRenderPerBatch={60}
          windowSize={11}
          ListFooterComponent={
            left > 0 ? (
              <View
                style={{
                  width: window.width,
                  padding: space.lg,
                  paddingBottom: space.lg + insets.bottom + bottom,
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
              <View style={{ height: space.xl + insets.bottom + bottom }} />
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
  noteBar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
  more: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
})
