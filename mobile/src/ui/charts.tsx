// The usage tab's charts, drawn with react-native-svg: a progress ring, rings inside each other for
// a plan's windows, a donut of shares, bars (stacked by series or not), and a bar of parts. Bars
// answer a tap with a selection, a touch and hold with a tooltip, and VoiceOver's swipes up and
// down by reading one bar after another.

import { memo, useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native'
import Svg, { Circle, G, Line, Path, Rect } from 'react-native-svg'
import { haptic } from './haptics'
import { radius, space, type as typeScale, useTokens } from './tokens'

const clamp = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0))

function Arc(props: {
  center: number
  r: number
  stroke: number
  progress: number
  color: string
}) {
  const circumference = 2 * Math.PI * props.r
  const p = clamp(props.progress)
  if (p <= 0) return null
  return (
    <Circle
      cx={props.center}
      cy={props.center}
      r={props.r}
      fill="none"
      stroke={props.color}
      strokeWidth={props.stroke}
      strokeLinecap="round"
      strokeDasharray={p >= 1 ? undefined : `${circumference * p} ${circumference}`}
      transform={`rotate(-90 ${props.center} ${props.center})`}
    />
  )
}

/** One progress ring, from 12 o'clock clockwise, with anything centered inside it. */
export function Ring(props: {
  size: number
  stroke?: number
  progress: number
  color?: string
  children?: ReactNode
}) {
  const { c } = useTokens()
  const stroke = props.stroke ?? Math.max(2, Math.round(props.size / 9))
  const center = props.size / 2
  const r = center - stroke / 2
  return (
    <View style={{ width: props.size, height: props.size }}>
      <Svg width={props.size} height={props.size}>
        <Circle cx={center} cy={center} r={r} fill="none" stroke={c.track} strokeWidth={stroke} />
        <Arc
          center={center}
          r={r}
          stroke={stroke}
          progress={props.progress}
          color={props.color ?? c.tint}
        />
      </Svg>
      {props.children ? <View style={styles.center}>{props.children}</View> : null}
    </View>
  )
}

/** Rings inside each other, the first outermost, as a plan's windows. */
export function ConcentricRings(props: {
  size: number
  rings: { progress: number; color?: string }[]
  stroke?: number
  gap?: number
}) {
  const { c } = useTokens()
  const stroke = props.stroke ?? 8
  const gap = props.gap ?? 3
  const center = props.size / 2
  return (
    <Svg width={props.size} height={props.size}>
      {props.rings.map((ring, i) => {
        const r = center - stroke / 2 - i * (stroke + gap)
        if (r <= stroke / 2) return null
        return (
          <G key={i}>
            <Circle
              cx={center}
              cy={center}
              r={r}
              fill="none"
              stroke={c.track}
              strokeWidth={stroke}
            />
            <Arc
              center={center}
              r={r}
              stroke={stroke}
              progress={ring.progress}
              color={ring.color ?? c.tint}
            />
          </G>
        )
      })}
    </Svg>
  )
}

/** A donut of shares, clockwise from 12 o'clock, with a gap of the surface between segments. */
export function Donut(props: {
  size: number
  stroke?: number
  segments: { key: string; value: number; color: string }[]
  children?: ReactNode
}) {
  const { c } = useTokens()
  const stroke = props.stroke ?? Math.round(props.size * 0.15)
  const center = props.size / 2
  const r = center - stroke / 2
  const circumference = 2 * Math.PI * r
  const shown = props.segments.filter((s) => s.value > 0)
  const total = shown.reduce((sum, s) => sum + s.value, 0)
  const gap = shown.length > 1 ? 2 : 0
  let start = 0
  return (
    <View style={{ width: props.size, height: props.size }}>
      <Svg width={props.size} height={props.size}>
        <Circle cx={center} cy={center} r={r} fill="none" stroke={c.track} strokeWidth={stroke} />
        <G transform={`rotate(-90 ${center} ${center})`}>
          {total > 0 &&
            shown.map((s) => {
              const length = (s.value / total) * circumference
              const offset = start
              start += length
              const drawn = Math.max(0.5, length - gap)
              return (
                <Circle
                  key={s.key}
                  cx={center}
                  cy={center}
                  r={r}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={stroke}
                  strokeDasharray={shown.length === 1 ? undefined : `${drawn} ${circumference}`}
                  strokeDashoffset={-offset}
                />
              )
            })}
        </G>
      </Svg>
      {props.children ? <View style={styles.center}>{props.children}</View> : null}
    </View>
  )
}

/** What a tooltip says: the period, its amount, and how it splits by series. */
export interface TipContent {
  title: string
  value?: string
  rows?: { key: string; color: string; label: string; value: string }[]
}

/**
 * A tooltip over a chart, centred on `x` and kept inside `width`, its bottom `space.sm` above `y`,
 * both in the chart's own coordinates.
 */
export function ChartTip(props: { x: number; y: number; width: number; content: TipContent }) {
  const { c } = useTokens()
  const [box, setBox] = useState({ w: 0, h: 0 })
  const left = Math.min(Math.max(0, props.x - box.w / 2), Math.max(0, props.width - box.w))
  return (
    <View
      pointerEvents="none"
      onLayout={(e) => setBox({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}
      style={[
        styles.tip,
        {
          left,
          top: props.y - box.h - space.sm,
          opacity: box.w > 0 ? 1 : 0,
          backgroundColor: c.surfaceRaised,
          borderColor: c.borderStrong,
          shadowColor: c.shadow,
        },
      ]}
    >
      <Text style={[typeScale.caption, { color: c.textSecondary }]} numberOfLines={1}>
        {props.content.title}
      </Text>
      {props.content.value ? (
        <Text style={[typeScale.headline, styles.tabular, { color: c.text }]} numberOfLines={1}>
          {props.content.value}
        </Text>
      ) : null}
      {props.content.rows?.map((row) => (
        <View key={row.key} style={styles.tipRow}>
          <View style={[styles.tipSwatch, { backgroundColor: row.color }]} />
          <Text
            style={[typeScale.caption, styles.tipLabel, { color: c.textSecondary }]}
            numberOfLines={1}
          >
            {row.label}
          </Text>
          <Text style={[typeScale.caption, styles.tabular, { color: c.text }]}>{row.value}</Text>
        </View>
      ))}
    </View>
  )
}

function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h)
  return `M${x} ${y + h}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h}Z`
}

export interface BarSegment {
  key: string
  value: number
  color: string
  /** The segment's own opacity, before a selection dims it. */
  opacity?: number
}

export interface StackedBar {
  key: string
  /** Bottom first. */
  segments: BarSegment[]
}

/**
 * The bars themselves, apart from the chart's touch state: holding a bar for its tooltip, or
 * VoiceOver stepping through them, redraws the tooltip and not every bar.
 */
const Bars = memo(function Bars(props: {
  bars: StackedBar[]
  width: number
  height: number
  grid: number[] | undefined
  selected: number | null
}) {
  const { c } = useTokens()
  const { width, height, selected } = props
  const n = props.bars.length
  const totals = props.bars.map((bar) =>
    bar.segments.reduce((sum, s) => sum + Math.max(0, s.value), 0),
  )
  const max = Math.max(0, ...totals)
  const slot = n > 0 && width > 0 ? width / n : 0
  const gap = Math.max(1, Math.min(4, slot * 0.25))
  const barWidth = slot > 0 ? Math.max(1, slot - gap) : 0
  const top = height - 2
  return (
    <Svg width={width} height={height}>
      {(props.grid ?? []).map((share) => {
        const y = Math.round(height - share * top) + 0.5
        return <Line key={share} x1={0} x2={width} y1={y} y2={y} stroke={c.border} />
      })}
      {props.bars.map((bar, i) => {
        if (max <= 0 || totals[i]! <= 0) return null
        const x = i * slot + gap / 2
        const dim = selected !== null && selected !== i ? 0.35 : 1
        const shown = bar.segments.filter((s) => s.value > 0)
        let base = height
        return (
          <G key={bar.key}>
            {shown.map((s, k) => {
              const last = k === shown.length - 1
              const full = Math.max(last && k === 0 ? 2 : 1, (s.value / max) * top)
              const h = last ? full : Math.max(0.5, full - 1)
              const y = base - h
              base -= full
              return last ? (
                <Path
                  key={s.key}
                  d={barPath(x, y, barWidth, h)}
                  fill={s.color}
                  opacity={(s.opacity ?? 1) * dim}
                />
              ) : (
                <Rect
                  key={s.key}
                  x={x}
                  y={y}
                  width={barWidth}
                  height={h}
                  fill={s.color}
                  opacity={(s.opacity ?? 1) * dim}
                />
              )
            })}
          </G>
        )
      })}
      <Line x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} stroke={c.border} />
    </Svg>
  )
})

/**
 * Bars on a shared baseline, each a stack of series with a hairline between them and only the
 * top one rounded. A tap picks a bar and dims the rest, which is the phone's hover; a touch and
 * hold shows `tip` until the finger lifts.
 */
export function StackedBarChart(props: {
  bars: StackedBar[]
  height?: number
  /** Labels under some bars, by index, centred on them. */
  ticks?: Record<number, string>
  /** Faint lines at these shares of the tallest bar. */
  grid?: number[]
  selected?: number | null
  onSelect?: (index: number | null) => void
  tip?: (index: number) => TipContent | null
  /** What VoiceOver reads for a bar. */
  describe?: (index: number) => string
  accessibilityLabel: string
}) {
  const { c } = useTokens()
  const [width, setWidth] = useState(0)
  const [held, setHeld] = useState<number | null>(null)
  const n = props.bars.length
  const [spoken, setSpoken] = useState<number | null>(null)
  const height = props.height ?? 120
  const totals = props.bars.map((bar) =>
    bar.segments.reduce((sum, s) => sum + Math.max(0, s.value), 0),
  )
  const max = Math.max(0, ...totals)
  const slot = n > 0 && width > 0 ? width / n : 0
  const selected = props.selected ?? null
  const top = height - 2

  const indexAt = (e: GestureResponderEvent) =>
    Math.min(n - 1, Math.max(0, Math.floor(e.nativeEvent.locationX / (slot || 1))))

  const current = spoken ?? (n > 0 ? n - 1 : 0)
  const tip = held !== null ? props.tip?.(held) : null
  const heldTop = held !== null && max > 0 ? height - (totals[held]! / max) * top : height

  return (
    <View>
      <Pressable
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        onPress={(e) => {
          if (!props.onSelect || slot <= 0) return
          const index = indexAt(e)
          haptic.select()
          props.onSelect(index === selected ? null : index)
        }}
        onLongPress={(e) => {
          if (!props.tip || slot <= 0) return
          haptic.select()
          setHeld(indexAt(e))
        }}
        onPressOut={() => setHeld(null)}
        delayLongPress={250}
        style={{ height }}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={props.accessibilityLabel}
        accessibilityHint="上下轻扫逐个朗读"
        accessibilityValue={
          props.describe && n > 0 ? { text: props.describe(Math.min(current, n - 1)) } : undefined
        }
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => {
          const step = e.nativeEvent.actionName === 'increment' ? 1 : -1
          setSpoken(Math.min(n - 1, Math.max(0, current + step)))
        }}
      >
        {width > 0 && (
          <Bars
            bars={props.bars}
            width={width}
            height={height}
            grid={props.grid}
            selected={selected}
          />
        )}
      </Pressable>
      {props.ticks && slot > 0 && (
        <View style={styles.labels} pointerEvents="none">
          {Object.entries(props.ticks).map(([index, label]) => {
            // Centered under its bar, or held to the chart's edge, flush with it, where it would
            // overflow: a label pushed in whole would sit under the wrong bar.
            const at = (Number(index) + 0.5) * slot - TICK_WIDTH / 2
            const edge = at < 0 ? 'left' : at > width - TICK_WIDTH ? 'right' : 'center'
            return (
              <Text
                key={index}
                numberOfLines={1}
                style={[
                  typeScale.caption,
                  styles.label,
                  {
                    color: c.textTertiary,
                    left: Math.min(width - TICK_WIDTH, Math.max(0, at)),
                    textAlign: edge,
                  },
                ]}
              >
                {label}
              </Text>
            )
          })}
        </View>
      )}
      {tip && held !== null && (
        <ChartTip
          x={(held + 0.5) * slot}
          y={Math.min(heldTop, height / 3)}
          width={width}
          content={tip}
        />
      )}
    </View>
  )
}

/** One series of bars, the one at `emphasis` in full color and the rest softer. */
export function BarChart(props: {
  values: number[]
  height?: number
  color?: string
  emphasis?: number | null
  labels?: Record<number, string>
  grid?: number[]
  selected?: number | null
  onSelect?: (index: number | null) => void
  tip?: (index: number) => TipContent | null
  describe?: (index: number) => string
  accessibilityLabel: string
}) {
  const { c } = useTokens()
  const color = props.color ?? c.tint
  const emphasis = props.emphasis ?? null
  return (
    <StackedBarChart
      bars={props.values.map((value, i) => ({
        key: String(i),
        segments: [
          { key: 'v', value, color, opacity: emphasis === null || emphasis === i ? 1 : 0.55 },
        ],
      }))}
      height={props.height}
      ticks={props.labels}
      grid={props.grid}
      selected={props.selected}
      onSelect={props.onSelect}
      tip={props.tip}
      describe={props.describe}
      accessibilityLabel={props.accessibilityLabel}
    />
  )
}

/** A single bar of parts, side by side, as what a whole is made of. */
export function PartsBar(props: { parts: BarSegment[]; height?: number }) {
  const { c } = useTokens()
  const [width, setWidth] = useState(0)
  const height = props.height ?? 10
  const shown = props.parts.filter((p) => p.value > 0)
  const total = shown.reduce((sum, p) => sum + p.value, 0)
  const gap = 2
  const room = width - gap * Math.max(0, shown.length - 1)
  let x = 0
  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={[styles.parts, { height, borderRadius: height / 2, backgroundColor: c.fill }]}
    >
      {width > 0 && total > 0 && (
        <Svg width={width} height={height}>
          {shown.map((p) => {
            const w = Math.max(2, (p.value / total) * room)
            const at = x
            x += w + gap
            return (
              <Rect
                key={p.key}
                x={at}
                y={0}
                width={w}
                height={height}
                fill={p.color}
                opacity={p.opacity ?? 1}
              />
            )
          })}
        </Svg>
      )}
    </View>
  )
}

const TICK_WIDTH = 64

const styles = StyleSheet.create({
  center: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  tabular: { fontVariant: ['tabular-nums'] },
  labels: { height: 20, marginTop: space.xs },
  label: {
    position: 'absolute',
    width: TICK_WIDTH,
    textAlign: 'center',
    fontVariant: ['tabular-nums'],
  },
  tip: {
    position: 'absolute',
    zIndex: 20,
    minWidth: 160,
    maxWidth: 260,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 2,
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  tipRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 },
  tipSwatch: { width: 8, height: 8, borderRadius: 2 },
  // Grows from its own width, not from zero: the tip sizes itself to its content, and a label of
  // `flex: 1` there measured nothing and broke a name one character a line.
  tipLabel: { flexGrow: 1, flexShrink: 1, marginRight: space.md },
  parts: { overflow: 'hidden', flexDirection: 'row' },
})
