// The usage tab's charts, drawn with react-native-svg: a progress ring, rings inside each other for
// a plan's windows, a donut of shares, and a row of bars.

import { useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import Svg, { Circle, G, Line, Path } from 'react-native-svg'
import { space, type as typeScale, useTokens } from './tokens'

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

function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h)
  return `M${x} ${y + h}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${y + h}Z`
}

/**
 * Bars on a shared baseline, one series in one color; a tap picks a bar and dims the rest, which
 * is the phone's hover.
 */
export function BarChart(props: {
  values: number[]
  height?: number
  color?: string
  /** Labels under some bars, by index. */
  labels?: Record<number, string>
  selected?: number | null
  onSelect?: (index: number | null) => void
}) {
  const { c } = useTokens()
  const [width, setWidth] = useState(0)
  const height = props.height ?? 120
  const max = Math.max(0, ...props.values)
  const n = props.values.length
  const gap = 2
  const barWidth = n > 0 && width > 0 ? (width - gap * (n - 1)) / n : 0
  const color = props.color ?? c.tint
  const selected = props.selected ?? null

  const pick = (x: number) => {
    if (!props.onSelect || barWidth <= 0) return
    const index = Math.min(n - 1, Math.max(0, Math.floor(x / (barWidth + gap))))
    props.onSelect(index === selected ? null : index)
  }

  return (
    <View>
      <Pressable
        onPress={(e) => pick(e.nativeEvent.locationX)}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
        style={{ height }}
        accessibilityRole="adjustable"
      >
        {width > 0 && (
          <Svg width={width} height={height}>
            {props.values.map((value, i) => {
              const h = max > 0 && value > 0 ? Math.max(2, (value / max) * (height - 2)) : 0
              if (h === 0) return null
              return (
                <Path
                  key={i}
                  d={barPath(i * (barWidth + gap), height - h, barWidth, h)}
                  fill={color}
                  opacity={selected === null || selected === i ? 1 : 0.35}
                />
              )
            })}
            <Line x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} stroke={c.border} />
          </Svg>
        )}
      </Pressable>
      {props.labels && barWidth > 0 && (
        <View style={styles.labels}>
          {Object.entries(props.labels).map(([index, label]) => (
            <Text
              key={index}
              style={[
                typeScale.caption,
                styles.label,
                { color: c.textTertiary, left: Number(index) * (barWidth + gap) },
              ]}
            >
              {label}
            </Text>
          ))}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  center: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  labels: { height: 20, marginTop: space.xs },
  label: { position: 'absolute', fontVariant: ['tabular-nums'] },
})
