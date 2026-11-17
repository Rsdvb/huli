// A year of days as a grid, a week to a column and the first day of the week on top, shaded by
// how much each day used. Today is outlined and a chosen range framed; it scrolls sideways and
// opens at today. A tap on a day keeps its tooltip up, a touch and hold shows it while held.

import { memo, useMemo, useRef, useState, type ComponentRef } from 'react'
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from 'react-native'
import Svg, { Path, Rect } from 'react-native-svg'
import { ChartTip, type TipContent } from './charts'
import { haptic } from './haptics'
import { space, type as typeScale, useTokens, type Palette } from './tokens'

const CELL = 11
const GAP = 3
const PITCH = CELL + GAP
/** Room around the grid for the frame's stroke. */
const PAD = 3
const LABELS = 18
const SHADES = [0.3, 0.5, 0.75, 1] as const

export function heatColor(c: Palette, level: number): { color: string; opacity: number } {
  return level <= 0
    ? { color: c.fillStrong, opacity: 1 }
    : { color: c.tint, opacity: SHADES[level - 1]! }
}

/** The outline around the cells from index `a` to `b`, column by column, as one or two shapes. */
function framePath(a: number, b: number): string {
  const at = (k: number) => PAD + k * PITCH - GAP / 2
  const [ca, ra, cb, rb] = [Math.floor(a / 7), a % 7, Math.floor(b / 7), b % 7]
  const box = (x0: number, y0: number, x1: number, y1: number) =>
    `M${at(x0)} ${at(y0)}H${at(x1)}V${at(y1)}H${at(x0)}Z`
  if (ca === cb) return box(ca, ra, ca + 1, rb + 1)
  // Two columns side by side that share no row are two pieces.
  if (cb === ca + 1 && rb + 1 < ra) return box(ca, ra, ca + 1, 7) + box(cb, 0, cb + 1, rb + 1)
  return [
    `M${at(ca)} ${at(ra)}`,
    `H${at(ca + 1)}`,
    `V${at(0)}`,
    `H${at(cb + 1)}`,
    `V${at(rb + 1)}`,
    `H${at(cb)}`,
    `V${at(7)}`,
    `H${at(ca)}`,
    'Z',
  ].join('')
}

/** Month names over the columns where a month begins, never closer than a name's width. */
function monthLabels(days: readonly number[]): { col: number; text: string }[] {
  const labels: { col: number; text: string }[] = []
  const columns = Math.ceil(days.length / 7)
  for (let col = 0; col < columns; col++) {
    const week = days.slice(col * 7, col * 7 + 7)
    const first = week.find((day) => new Date(day).getDate() === 1)
    const day = first ?? (col === 0 ? week[0] : undefined)
    if (day === undefined) continue
    const last = labels[labels.length - 1]
    if (last && col - last.col < 3) {
      if (last.col === 0) labels.pop()
      else continue
    }
    labels.push({ col, text: `${new Date(day).getMonth() + 1}月` })
  }
  return labels
}

const cellX = (i: number) => PAD + Math.floor(i / 7) * PITCH
const cellY = (i: number) => PAD + (i % 7) * PITCH

/** The days' cells, the frame and today's outline: hundreds of shapes, drawn again only when they change. */
const HeatGrid = memo(function HeatGrid(props: {
  days: readonly number[]
  levels: readonly number[]
  frame: string | null
  width: number
  height: number
}) {
  const { c } = useTokens()
  const n = props.days.length
  const today = n - 1
  return (
    <Svg width={props.width} height={props.height}>
      {props.days.map((day, i) => {
        const shade = heatColor(c, props.levels[i] ?? 0)
        return (
          <Rect
            key={day}
            x={cellX(i)}
            y={cellY(i)}
            width={CELL}
            height={CELL}
            rx={2.5}
            fill={shade.color}
            opacity={shade.opacity}
          />
        )
      })}
      {props.frame && (
        <Path
          d={props.frame}
          fill="none"
          stroke={c.text}
          strokeOpacity={0.85}
          strokeWidth={1.5}
          strokeLinejoin="round"
        />
      )}
      {n > 0 && (
        <Rect
          x={cellX(today) - 1}
          y={cellY(today) - 1}
          width={CELL + 2}
          height={CELL + 2}
          rx={3.5}
          fill="none"
          stroke={c.text}
          strokeWidth={1.5}
        />
      )}
    </Svg>
  )
})

export function Heatmap(props: {
  /** Day starts, oldest first, starting on the first day of a week and ending today. */
  days: readonly number[]
  levels: readonly number[]
  /** The days to frame, [from, to). */
  frame: { from: number; to: number } | null
  tip: (index: number) => TipContent
  accessibilityLabel: string
}) {
  const { c } = useTokens()
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null)
  const offset = useRef(0)
  const [, setScrolled] = useState(0)
  const [chosen, setChosen] = useState<number | null>(null)
  const holding = useRef(false)
  const [width, setWidth] = useState(0)
  const n = props.days.length
  const columns = Math.ceil(n / 7)
  const gridWidth = PAD * 2 + columns * PITCH - GAP
  const gridHeight = PAD * 2 + 7 * PITCH - GAP
  const today = n - 1
  const months = useMemo(() => monthLabels(props.days), [props.days])

  let frame: string | null = null
  if (
    props.frame &&
    n > 0 &&
    props.frame.to > props.days[0]! &&
    props.frame.from <= props.days[today]!
  ) {
    const a = Math.max(
      0,
      props.days.findIndex((d) => d >= props.frame!.from),
    )
    let b = today
    while (b > 0 && props.days[b]! >= props.frame.to) b--
    if (b >= a) frame = framePath(a, b)
  }

  const indexAt = (e: GestureResponderEvent) => {
    const col = Math.floor((e.nativeEvent.locationX - PAD + GAP / 2) / PITCH)
    const row = Math.floor((e.nativeEvent.locationY - PAD + GAP / 2) / PITCH)
    if (col < 0 || row < 0 || row > 6) return null
    const index = col * 7 + row
    return index < n ? index : null
  }

  return (
    <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      <ScrollView
        ref={scroll}
        horizontal
        showsHorizontalScrollIndicator={false}
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: false })}
        scrollEventThrottle={32}
        onScroll={(e) => {
          offset.current = e.nativeEvent.contentOffset.x
          if (chosen !== null) setScrolled(offset.current)
        }}
        onScrollBeginDrag={() => setChosen(null)}
        accessible
        accessibilityRole="image"
        accessibilityLabel={props.accessibilityLabel}
      >
        <View>
          <View style={{ height: LABELS, width: gridWidth }}>
            {months.map((label) => (
              <Text
                key={label.col}
                style={[
                  typeScale.caption,
                  styles.month,
                  { color: c.textSecondary, left: PAD + label.col * PITCH },
                ]}
              >
                {label.text}
              </Text>
            ))}
          </View>
          <Pressable
            onPress={(e) => {
              const index = indexAt(e)
              haptic.select()
              setChosen(index === chosen ? null : index)
            }}
            onLongPress={(e) => {
              const index = indexAt(e)
              if (index === null) return
              haptic.select()
              holding.current = true
              setChosen(index)
            }}
            onPressOut={() => {
              if (!holding.current) return
              holding.current = false
              setChosen(null)
            }}
            delayLongPress={250}
          >
            <HeatGrid
              days={props.days}
              levels={props.levels}
              frame={frame}
              width={gridWidth}
              height={gridHeight}
            />
            {/* The chosen day is drawn over the grid, so choosing one redraws only this. */}
            <Svg
              width={gridWidth}
              height={gridHeight}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            >
              {chosen !== null && chosen !== today && (
                <Rect
                  x={cellX(chosen) - 1}
                  y={cellY(chosen) - 1}
                  width={CELL + 2}
                  height={CELL + 2}
                  rx={3.5}
                  fill="none"
                  stroke={c.tint}
                  strokeWidth={1.5}
                />
              )}
            </Svg>
          </Pressable>
        </View>
      </ScrollView>
      {chosen !== null && width > 0 && (
        <ChartTip
          x={cellX(chosen) + CELL / 2 - offset.current}
          y={LABELS + cellY(chosen)}
          width={width}
          content={props.tip(chosen)}
        />
      )}
    </View>
  )
}

/** "少 ▢▢▢▢▢ 更多": what the shades mean. */
export function HeatLegend() {
  const { c } = useTokens()
  return (
    <View
      style={styles.legend}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text style={[typeScale.caption, { color: c.textSecondary }]}>少</Text>
      {[0, 1, 2, 3, 4].map((level) => {
        const shade = heatColor(c, level)
        return (
          <View
            key={level}
            style={[styles.swatch, { backgroundColor: shade.color, opacity: shade.opacity }]}
          />
        )
      })}
      <Text style={[typeScale.caption, { color: c.textSecondary }]}>更多</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  month: { position: 'absolute', top: 0 },
  legend: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 3,
    marginTop: space.sm,
  },
  swatch: { width: CELL, height: CELL, borderRadius: 2.5, marginHorizontal: 0.5 },
})
