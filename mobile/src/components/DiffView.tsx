// A unified diff: one fixed-height row per line in a virtualized list, wide enough for its longest
// line and scrolled sideways as a whole, so line numbers stay beside their lines.

import { memo, useCallback, useMemo, useState } from 'react'
import {
  FlatList,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ListRenderItem,
} from 'react-native'
import type { Diff, DiffRow } from '../diff'
import type { Theme } from '../theme'

export const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' })

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
  add: string
  del: string
  text: string
  muted: string
}

const Row = memo(function Row(props: { row: DiffRow; colors: Colors; gutter: number }) {
  const { row, colors, gutter } = props
  if (row.kind === 'hunk') {
    return (
      <View style={[styles.row, { backgroundColor: colors.hunkBg }]}>
        <Text style={[styles.text, { color: colors.muted, paddingLeft: PAD }]} numberOfLines={1}>
          {row.text}
        </Text>
      </View>
    )
  }
  const bg = row.kind === 'add' ? colors.addBg : row.kind === 'del' ? colors.delBg : undefined
  const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '
  const signColor = row.kind === 'add' ? colors.add : colors.del
  return (
    <View style={[styles.row, bg ? { backgroundColor: bg } : null]}>
      <Text style={[styles.text, styles.number, { width: gutter, color: colors.muted }]}>
        {row.old ?? ''}
      </Text>
      <Text style={[styles.text, styles.number, { width: gutter, color: colors.muted }]}>
        {row.new ?? ''}
      </Text>
      <Text style={[styles.text, styles.sign, { color: signColor }]}>{sign}</Text>
      <Text style={[styles.text, { color: colors.text }]} numberOfLines={1}>
        {row.text}
      </Text>
    </View>
  )
})

export function DiffView(props: { diff: Diff; theme: Theme }) {
  const { diff, theme } = props
  const window = useWindowDimensions()
  const [advance, setAdvance] = useState(GUESS)
  const [limit, setLimit] = useState(PAGE)
  const colors = useMemo<Colors>(
    () => ({
      addBg: `${theme.ok}24`,
      delBg: `${theme.danger}24`,
      hunkBg: theme.line,
      add: theme.ok,
      del: theme.danger,
      text: theme.text,
      muted: theme.muted,
    }),
    [theme],
  )
  const rows = useMemo(() => diff.rows.slice(0, limit), [diff.rows, limit])
  const gutter = Math.ceil(String(Math.max(diff.lastLine, 9)).length * advance) + PAD
  const width = Math.max(
    window.width,
    Math.ceil(gutter * 2 + advance * (diff.columns + 2) + PAD * 3),
  )
  const left = diff.rows.length - rows.length

  const renderItem = useCallback<ListRenderItem<DiffRow>>(
    ({ item }) => <Row row={item} colors={colors} gutter={gutter} />,
    [colors, gutter],
  )

  return (
    <View style={{ flex: 1 }}>
      <Text
        style={[styles.text, styles.ruler]}
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
          getItemLayout={(_, index) => ({ length: ROW, offset: ROW * index, index })}
          initialNumToRender={40}
          maxToRenderPerBatch={60}
          windowSize={11}
          ListFooterComponent={
            left > 0 ? (
              <View style={{ width: window.width, padding: 16 }}>
                <Pressable
                  onPress={() => setLimit((n) => n + PAGE)}
                  style={({ pressed }) => [
                    styles.more,
                    { borderColor: theme.line, opacity: pressed ? 0.6 : 1 },
                  ]}
                >
                  <Text style={{ color: theme.accent, fontSize: 14 }}>
                    显示更多（还有 {left} 行）
                  </Text>
                </Pressable>
              </View>
            ) : (
              <View style={{ height: 24 }} />
            )
          }
        />
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { height: ROW, flexDirection: 'row', alignItems: 'center' },
  text: { fontFamily: MONO, fontSize: FONT, lineHeight: ROW },
  number: { textAlign: 'right', paddingRight: PAD },
  sign: { width: FONT, textAlign: 'center', marginRight: 4 },
  ruler: { position: 'absolute', opacity: 0, left: 0, top: 0 },
  more: {
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
})
