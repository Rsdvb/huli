// A slide deck, natively: one slide a page, swiped through, each laid out as the desktop's viewer
// lays it out (src/renderer/src/viewers/slides/slide.tsx and slides.css) at the deck's size and
// scaled to the screen, in the deck's own colors whatever the app's mode, and pinched to zoom.

import { memo, useMemo, useRef, useState } from 'react'
import { FlatList, StyleSheet, Text, View, useWindowDimensions, type TextStyle } from 'react-native'
import { Image } from 'expo-image'
import { CONTENT_ENTRIES } from '@shared/artifact-types'
import { useSessionTokens } from '../ui/session/palette'
import { dataUrl, textOf } from './bytes'
import type { LoadedVersion } from './content'
import { Zoomable } from './Zoomable'

// The deck's shape, colors and size, as @shared/artifact-slides has them; that module imports the
// Markdown parser, which the phone does not bundle. Every field is read as untrusted.
type Bullet = string | { text?: unknown; bullets?: unknown }
interface Column {
  heading?: unknown
  text?: unknown
  bullets?: unknown
}
interface Slide {
  layout: string
  [field: string]: unknown
}
interface Deck {
  title?: string
  theme?: 'light' | 'dark'
  aspect?: '16:9' | '4:3'
  slides: Slide[]
}

type Palette = Record<'background' | 'text' | 'muted' | 'accent' | 'surface' | 'line', string>

const PALETTES: Record<'light' | 'dark', Palette> = {
  light: {
    background: '#ffffff',
    text: '#1b1e23',
    muted: '#5d6672',
    accent: '#d9590f',
    surface: '#f3f4f6',
    line: '#dde0e5',
  },
  dark: {
    background: '#16181c',
    text: '#f2f3f5',
    muted: '#a4abb5',
    accent: '#ff8d4d',
    surface: '#22252b',
    line: '#363a41',
  },
}

function slideSize(aspect: Deck['aspect']): { width: number; height: number } {
  return aspect === '4:3' ? { width: 960, height: 720 } : { width: 1280, height: 720 }
}

/** The deck, read loosely: a slide this build cannot lay out shows as its title alone. */
export function readDeck(version: LoadedVersion): Deck | null {
  const file = version.files.get(CONTENT_ENTRIES.slides)
  if (!file) return null
  try {
    const value = JSON.parse(textOf(file.bytes)) as Partial<Deck>
    if (!Array.isArray(value.slides)) return null
    const slides = value.slides.filter(
      (s): s is Slide => typeof s === 'object' && s !== null && typeof s.layout === 'string',
    )
    return {
      title: typeof value.title === 'string' ? value.title : undefined,
      theme: value.theme === 'dark' ? 'dark' : 'light',
      aspect: value.aspect === '4:3' ? '4:3' : '16:9',
      slides,
    }
  } catch {
    return null
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

interface Look {
  k: number
  p: Palette
  image(path: unknown): string | null
}

function T(props: { value: unknown; style: TextStyle | TextStyle[]; look: Look }) {
  const value = str(props.value)
  if (value === undefined) return null
  return <Text style={[{ color: props.look.p.text }, props.style].flat()}>{value}</Text>
}

function Bullets(props: { bullets: unknown; look: Look; sub?: boolean }) {
  const { k, p } = props.look
  if (!Array.isArray(props.bullets)) return null
  const size = (props.sub ? 28 : 32) * k
  const color = props.sub ? p.muted : p.text
  return (
    <View style={{ gap: size * 0.45, marginTop: props.sub ? size * 0.3 : 0 }}>
      {(props.bullets as Bullet[]).map((bullet, i) => {
        const text = typeof bullet === 'string' ? bullet : str(bullet?.text)
        const under = typeof bullet === 'object' && bullet !== null ? bullet.bullets : undefined
        return (
          <View key={i} style={{ flexDirection: 'row' }}>
            <Text
              style={{
                color: p.accent,
                fontSize: size,
                lineHeight: size * 1.35,
                width: size * 1.1,
              }}
            >
              {props.sub ? '◦' : '•'}
            </Text>
            <View style={{ flex: 1 }}>
              <Text style={{ color, fontSize: size, lineHeight: size * 1.35 }}>{text ?? ''}</Text>
              {!props.sub && Array.isArray(under) && under.length > 0 ? (
                <Bullets bullets={under} look={props.look} sub />
              ) : null}
            </View>
          </View>
        )
      })}
    </View>
  )
}

function Picture(props: { path: unknown; alt: unknown; look: Look }) {
  const uri = props.look.image(props.path)
  if (!uri) return null
  return (
    <Image
      source={{ uri }}
      accessibilityLabel={str(props.alt) ?? ''}
      contentFit="contain"
      transition={120}
      style={{ flex: 1, width: '100%' }}
    />
  )
}

function ColumnView(props: { column: Column | undefined; look: Look }) {
  const { k } = props.look
  const column = props.column
  if (!column || typeof column !== 'object') return <View style={{ flex: 1 }} />
  return (
    <View style={{ flex: 1, gap: 14 * k }}>
      <T value={column.heading} look={props.look} style={{ fontSize: 36 * k, fontWeight: '700' }} />
      <T
        value={column.text}
        look={props.look}
        style={{ fontSize: 32 * k, lineHeight: 32 * k * 1.3 }}
      />
      {column.bullets ? <Bullets bullets={column.bullets} look={props.look} /> : null}
    </View>
  )
}

const SlideView = memo(function SlideView(props: {
  slide: Slide
  width: number
  height: number
  look: Look
}) {
  const { slide, look } = props
  const { k, p } = look
  const s = slide as Slide & Record<string, unknown>
  const title = (
    <View style={{ minHeight: 115 * k, marginBottom: 20 * k, justifyContent: 'center' }}>
      <T
        value={s.title}
        look={look}
        style={{ fontSize: 50 * k, lineHeight: 50 * k * 1.15, fontWeight: '700' }}
      />
    </View>
  )
  let body
  switch (slide.layout) {
    case 'title':
    case 'section': {
      const big = slide.layout === 'title' ? 71 : 60
      body = (
        <View style={{ flex: 1, justifyContent: 'center', gap: 20 * k }}>
          <View style={{ width: 102 * k, height: 8 * k, backgroundColor: p.accent }} />
          <T
            value={s.title}
            look={look}
            style={{ fontSize: big * k, lineHeight: big * k * 1.08, fontWeight: '700' }}
          />
          <T
            value={s.subtitle}
            look={look}
            style={{ fontSize: 36 * k, lineHeight: 36 * k * 1.3, color: p.muted }}
          />
        </View>
      )
      break
    }
    case 'bullets':
      body = (
        <>
          {title}
          <View style={{ flex: 1, flexDirection: 'row', gap: 38 * k }}>
            <View style={{ flex: 1 }}>
              <Bullets bullets={s.bullets} look={look} />
            </View>
            {s.image ? (
              <View style={{ flex: 1 }}>
                <Picture path={s.image} alt={s.alt} look={look} />
              </View>
            ) : null}
          </View>
        </>
      )
      break
    case 'two-column':
      body = (
        <>
          {s.title !== undefined ? title : null}
          <View style={{ flex: 1, flexDirection: 'row', gap: 38 * k }}>
            <ColumnView column={s.left as Column} look={look} />
            <ColumnView column={s.right as Column} look={look} />
          </View>
        </>
      )
      break
    case 'image':
      body = (
        <>
          {s.title !== undefined ? title : null}
          <View style={{ flex: 1, gap: 14 * k }}>
            <Picture path={s.image} alt={s.alt} look={look} />
            <T
              value={s.caption}
              look={look}
              style={{ fontSize: 21 * k, color: p.muted, textAlign: 'center' }}
            />
          </View>
        </>
      )
      break
    case 'quote':
      body = (
        <View style={{ flex: 1, justifyContent: 'center', gap: 28 * k, marginHorizontal: 51 * k }}>
          {str(s.quote) !== undefined ? (
            <Text
              style={{
                color: p.text,
                fontSize: 53 * k,
                lineHeight: 53 * k * 1.25,
                fontStyle: 'italic',
                textAlign: 'center',
              }}
            >
              {`“${str(s.quote)}”`}
            </Text>
          ) : null}
          {str(s.attribution) !== undefined ? (
            <Text style={{ color: p.muted, fontSize: 28 * k, textAlign: 'center' }}>
              {`— ${str(s.attribution)}`}
            </Text>
          ) : null}
        </View>
      )
      break
    case 'stats':
      body = (
        <>
          {s.title !== undefined ? title : null}
          <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>
            {(Array.isArray(s.stats) ? s.stats : []).map((stat: unknown, i: number) => {
              const o = (stat ?? {}) as Record<string, unknown>
              return (
                <View key={i} style={{ flex: 1, alignItems: 'center', gap: 8 * k }}>
                  <T
                    value={o.value}
                    look={look}
                    style={{
                      fontSize: 78 * k,
                      lineHeight: 78 * k * 1.1,
                      fontWeight: '700',
                      color: p.accent,
                      textAlign: 'center',
                    }}
                  />
                  <T
                    value={o.label}
                    look={look}
                    style={{ fontSize: 28 * k, color: p.muted, textAlign: 'center' }}
                  />
                </View>
              )
            })}
          </View>
        </>
      )
      break
    case 'table': {
      const columns = Array.isArray(s.columns) ? (s.columns as unknown[]) : []
      const rows = Array.isArray(s.rows) ? (s.rows as unknown[][]) : []
      const size = (rows.length > 10 ? 20 : 25) * k
      const cell = (value: unknown, head: boolean, c: number) => (
        <View
          key={c}
          style={{
            flex: 1,
            paddingVertical: size * 0.35,
            paddingHorizontal: size * 0.6,
            borderWidth: Math.max(StyleSheet.hairlineWidth, k),
            borderColor: p.line,
            marginLeft: c > 0 ? -Math.max(StyleSheet.hairlineWidth, k) : 0,
            backgroundColor: head ? p.surface : undefined,
          }}
        >
          <Text style={{ color: p.text, fontSize: size, fontWeight: head ? '700' : '400' }}>
            {str(value) ?? ''}
          </Text>
        </View>
      )
      body = (
        <>
          {s.title !== undefined ? title : null}
          <View>
            <View style={{ flexDirection: 'row' }}>{columns.map((v, c) => cell(v, true, c))}</View>
            {rows.map((row, r) => (
              <View
                key={r}
                style={{ flexDirection: 'row', marginTop: -Math.max(StyleSheet.hairlineWidth, k) }}
              >
                {(Array.isArray(row) ? row : []).map((v, c) => cell(v, false, c))}
              </View>
            ))}
          </View>
        </>
      )
      break
    }
    default:
      body = title
  }
  return (
    <View
      style={{
        width: props.width,
        height: props.height,
        paddingTop: 51 * k,
        paddingHorizontal: 77 * k,
        paddingBottom: 64 * k,
        backgroundColor: p.background,
        overflow: 'hidden',
      }}
    >
      {body}
    </View>
  )
})

export function SlidesView(props: {
  version: LoadedVersion
  top: number
  bottom: number
  /** The slide shown, from 0, for the page a comment names. */
  onSlide?: (index: number) => void
}) {
  const { c } = useSessionTokens()
  const window = useWindowDimensions()
  const deck = useMemo(() => readDeck(props.version), [props.version])
  const [index, setIndex] = useState(0)
  const [zoomed, setZoomed] = useState(false)
  const onSlide = useRef(props.onSlide)
  onSlide.current = props.onSlide

  const look = useMemo<Look | null>(() => {
    if (!deck) return null
    const made = new Map<string, string>()
    const size = slideSize(deck.aspect)
    const available = Math.min(
      window.width - 24,
      ((window.height - props.top - props.bottom - 64) * size.width) / size.height,
    )
    return {
      k: available / size.width,
      p: PALETTES[deck.theme === 'dark' ? 'dark' : 'light'],
      image: (path) => {
        if (typeof path !== 'string') return null
        const file = props.version.files.get(path.replace(/^\.\//, ''))
        if (!file || !file.type.startsWith('image/')) return null
        let url = made.get(file.path)
        if (url === undefined) {
          url = dataUrl(file.type, file.bytes)
          made.set(file.path, url)
        }
        return url
      },
    }
  }, [deck, window.width, window.height, props.top, props.bottom, props.version])

  const viewable = useRef(({ viewableItems }: { viewableItems: { index?: number | null }[] }) => {
    const first = viewableItems[0]
    if (first?.index !== undefined && first.index !== null) {
      setIndex(first.index)
      onSlide.current?.(first.index)
    }
  }).current

  if (!deck || !look) {
    return (
      <View style={[styles.center, { paddingTop: props.top }]}>
        <Text style={{ color: c.textSecondary, fontSize: 15 }}>没能读出这套幻灯片。</Text>
      </View>
    )
  }
  const size = slideSize(deck.aspect)
  const width = size.width * look.k
  const height = size.height * look.k

  return (
    <View style={[styles.fill, { paddingTop: props.top, paddingBottom: props.bottom }]}>
      <FlatList
        data={deck.slides}
        horizontal
        pagingEnabled
        scrollEnabled={!zoomed}
        showsHorizontalScrollIndicator={false}
        keyExtractor={(_, i) => String(i)}
        onViewableItemsChanged={viewable}
        viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
        windowSize={3}
        initialNumToRender={2}
        maxToRenderPerBatch={2}
        getItemLayout={(_, i) => ({ length: window.width, offset: window.width * i, index: i })}
        renderItem={({ item, index: i }) => (
          <View style={[styles.page, { width: window.width }]}>
            <Zoomable width={window.width} height={height + 40} onZoomed={setZoomed}>
              <View
                style={[styles.card, { borderColor: c.border }]}
                accessible
                accessibilityLabel={`第 ${i + 1} 张幻灯片`}
              >
                <SlideView slide={item} width={width} height={height} look={look} />
              </View>
            </Zoomable>
          </View>
        )}
      />
      <Text style={[styles.counter, { color: c.textSecondary }]} accessibilityRole="text">
        {index + 1} / {deck.slides.length}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  page: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  card: {
    borderRadius: 6,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
  },
  counter: {
    textAlign: 'center',
    fontSize: 13,
    paddingVertical: 10,
    fontVariant: ['tabular-nums'],
  },
})
