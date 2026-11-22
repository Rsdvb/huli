// Marking a picture up before it is sent, as the desktop's editor does (@shared/markup): a pen,
// arrows, boxes, labels and a crop, in four colors, with undo. The marks are drawn in SVG over the
// picture; Done takes the SVG's own snapshot (react-native-svg's toDataURL), which holds the
// picture and its marks, then cuts it to the crop with expo-image-manipulator. A crop alone cuts
// the picture itself, at its full size. Loaded only when a picture is marked up.

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
} from 'react-native'
import { File, Paths } from 'expo-file-system'
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import {
  GestureDetector,
  GestureHandlerRootView,
  usePanGesture,
} from 'react-native-gesture-handler'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Svg, {
  G as SvgGroup,
  Image as SvgImage,
  Line,
  Path,
  Polygon,
  Rect,
  Text as SvgText,
} from 'react-native-svg'
import { ArrowUpRight, Crop, PenLine, Square, Type, Undo2 } from 'lucide-react-native'
import { IMAGE_SIDE } from '@shared/attachments'
import {
  arrowGeometry,
  MARKUP_COLORS,
  MARKUP_MIN_SPAN,
  MARKUP_TOOLS,
  markupCrop,
  markupShapes,
  markupSizes,
  spanRect,
  type MarkupColor,
  type MarkupOp,
  type MarkupPoint,
  type MarkupRect,
  type MarkupShape,
  type MarkupTool,
} from '@shared/markup'
import { haptic } from '../ui/session/feedback'
import { Icon, type IconSpec } from '../ui/session/icons'
import { useSessionTokens } from '../ui/session/palette'

/** The marks' colors, the desktop's own (--markup-* in tokens.css), alike in every theme. */
const COLORS: Record<MarkupColor, string> = {
  red: '#e5484d',
  yellow: '#f5b800',
  green: '#30a46c',
  blue: '#0090ff',
}
const COLOR_NAMES: Record<MarkupColor, string> = {
  red: '红色',
  yellow: '黄色',
  green: '绿色',
  blue: '蓝色',
}
const HALO = '#ffffff'
const VEIL = 'rgba(0,0,0,0.55)'

const TOOLS: Record<MarkupTool, { icon: IconSpec; name: string }> = {
  pen: { icon: { sf: 'pencil.tip', lucide: PenLine }, name: '画笔' },
  arrow: { icon: { sf: 'arrow.up.right', lucide: ArrowUpRight }, name: '箭头' },
  rect: { icon: { sf: 'rectangle', lucide: Square }, name: '方框' },
  text: { icon: { sf: 'textformat', lucide: Type }, name: '文字' },
  crop: { icon: { sf: 'crop', lucide: Crop }, name: '裁剪' },
}
const UNDO: IconSpec = { sf: 'arrow.uturn.backward', lucide: Undo2 }

/** The picture as the editor works on it: a copy no larger than what is sent. */
interface Working {
  uri: string
  width: number
  height: number
  png: boolean
}

type Draft =
  | { kind: 'shape'; shape: MarkupShape }
  | { kind: 'crop'; from: MarkupPoint; to: MarkupPoint }
  | { kind: 'tap'; at: MarkupPoint }

interface Writing {
  x: number
  y: number
  text: string
}

/** One mark in SVG, in the picture's pixels. */
function ShapeView({ shape }: { shape: MarkupShape }) {
  const color = COLORS[shape.color]
  switch (shape.kind) {
    case 'pen': {
      const p = shape.points
      if (p.length < 3) return null
      let d = `M${p[0]},${p[1]}`
      for (let i = 3; i < p.length; i += 3) d += ` L${p[i]},${p[i + 1]}`
      // A single tap draws a dot.
      if (p.length === 3) d += ` L${p[0]! + 0.1},${p[1]}`
      return (
        <Path
          d={d}
          stroke={color}
          strokeWidth={shape.width * 2}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      )
    }
    case 'arrow': {
      const { shaftEnd, head } = arrowGeometry(shape.from, shape.to, shape.width)
      return (
        <SvgGroup>
          <Line
            x1={shape.from.x}
            y1={shape.from.y}
            x2={shaftEnd.x}
            y2={shaftEnd.y}
            stroke={color}
            strokeWidth={shape.width}
            strokeLinecap="round"
          />
          <Polygon
            points={head.map((point) => `${point.x},${point.y}`).join(' ')}
            fill={color}
            stroke={color}
            strokeWidth={shape.width / 2}
            strokeLinejoin="round"
          />
        </SvgGroup>
      )
    }
    case 'rect':
      return (
        <Rect
          x={shape.rect.x}
          y={shape.rect.y}
          width={shape.rect.width}
          height={shape.rect.height}
          rx={shape.width}
          stroke={color}
          strokeWidth={shape.width}
          fill="none"
        />
      )
    case 'text':
      return (
        <SvgGroup>
          {shape.text.split('\n').map((line, index) => {
            const y = shape.y + shape.size * (0.85 + index * 1.25)
            return (
              <SvgGroup key={index}>
                <SvgText
                  x={shape.x}
                  y={y}
                  fontSize={shape.size}
                  fontWeight="600"
                  stroke={HALO}
                  strokeWidth={Math.max(3, shape.size / 4)}
                  strokeLinejoin="round"
                  fill={HALO}
                >
                  {line}
                </SvgText>
                <SvgText x={shape.x} y={y} fontSize={shape.size} fontWeight="600" fill={color}>
                  {line}
                </SvgText>
              </SvgGroup>
            )
          })}
        </SvgGroup>
      )
  }
}

function CropVeil(props: { crop: MarkupRect; width: number; height: number; line: number }) {
  const { crop, width, height, line } = props
  return (
    <SvgGroup>
      <Path
        d={`M0,0 H${width} V${height} H0 Z M${crop.x},${crop.y} V${crop.y + crop.height} H${crop.x + crop.width} V${crop.y} Z`}
        fill={VEIL}
        fillRule="evenodd"
      />
      <Rect
        x={crop.x}
        y={crop.y}
        width={crop.width}
        height={crop.height}
        stroke={HALO}
        strokeWidth={line}
        strokeDasharray={[line * 4, line * 3]}
        fill="none"
      />
    </SvgGroup>
  )
}

/** A picture saved to the cache, cut to `crop` in its own pixels when given. */
async function saveCut(
  uri: string,
  crop: MarkupRect | null,
  png: boolean,
): Promise<{ uri: string; mimeType: string }> {
  const context = ImageManipulator.manipulate(uri)
  if (crop) {
    context.crop({
      originX: Math.round(crop.x),
      originY: Math.round(crop.y),
      width: Math.max(1, Math.round(crop.width)),
      height: Math.max(1, Math.round(crop.height)),
    })
  }
  const image = await context.renderAsync()
  try {
    const saved = await image.saveAsync({
      format: png ? SaveFormat.PNG : SaveFormat.JPEG,
      compress: png ? 1 : 0.92,
    })
    return { uri: saved.uri, mimeType: png ? 'image/png' : 'image/jpeg' }
  } finally {
    image.release()
  }
}

export default function MarkupEditor(props: {
  uri: string
  mimeType: string | null
  onDone(result: { uri: string; mimeType: string }): void
  onCancel(): void
}) {
  const { c } = useSessionTokens()
  const insets = useSafeAreaInsets()
  const [working, setWorking] = useState<Working | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [area, setArea] = useState<{ width: number; height: number } | null>(null)
  const [tool, setTool] = useState<MarkupTool>('pen')
  const [color, setColor] = useState<MarkupColor>('red')
  const [ops, setOps] = useState<MarkupOp[]>([])
  // The drag under way, changed in place as the finger moves; `drawn` redraws it.
  const draft = useRef<Draft | null>(null)
  const anchor = useRef<MarkupPoint | null>(null)
  const [, setDrawn] = useState(0)
  const redraw = () => setDrawn((n) => n + 1)
  const [writing, setShownWriting] = useState<Writing | null>(null)
  // The label being written, as its input's blur and Done read it.
  const writingNow = useRef<Writing | null>(null)
  const setWriting = (next: Writing | null) => {
    writingNow.current = next
    setShownWriting(next)
  }
  const [exporting, setExporting] = useState(false)
  const svg = useRef<Svg>(null)

  // A copy no larger than what is sent, so a camera's full picture never sits in memory twice.
  useEffect(() => {
    let live = true
    let made: string | null = null
    const png = props.mimeType === 'image/png'
    ;(async () => {
      const image = await ImageManipulator.manipulate(props.uri, {
        maxWidth: IMAGE_SIDE,
        maxHeight: IMAGE_SIDE,
      }).renderAsync()
      try {
        const saved = await image.saveAsync({
          format: png ? SaveFormat.PNG : SaveFormat.JPEG,
          compress: png ? 1 : 0.95,
        })
        made = saved.uri
        if (live) setWorking({ uri: saved.uri, width: saved.width, height: saved.height, png })
      } finally {
        image.release()
      }
    })().catch((error: unknown) => {
      console.warn('Could not open the picture to mark up', error)
      if (live) setFailed('没能打开这张图片。')
    })
    return () => {
      live = false
      if (made) new File(made).delete()
    }
  }, [props.uri, props.mimeType])

  const scale =
    working && area ? Math.min(area.width / working.width, area.height / working.height) : 1
  const sizes = working ? markupSizes(working.width, working.height) : { stroke: 4, text: 24 }

  // The gesture's callbacks read these as they are when each event comes.
  const now = useRef({ tool, color, scale, sizes, working })
  useEffect(() => {
    now.current = { tool, color, scale, sizes, working }
  })

  const at = (x: number, y: number): MarkupPoint => ({
    x: x / now.current.scale,
    y: y / now.current.scale,
  })

  /** The label being written as a step, or null when it holds no text. */
  const labelOp = (): MarkupOp | null => {
    const current = writingNow.current
    const text = current?.text.trim()
    if (!current || !text) return null
    const { color: ink, sizes: size } = now.current
    return {
      kind: 'shape',
      shape: { kind: 'text', color: ink, size: size.text, x: current.x, y: current.y, text },
    }
  }

  /** Ends the label being written, keeping it when it holds text. */
  const commitWriting = () => {
    const op = labelOp()
    setWriting(null)
    if (op) setOps((list) => [...list, op])
  }

  const pan = usePanGesture({
    minDistance: 0,
    maxPointers: 1,
    runOnJS: true,
    enabled: working !== null && !exporting,
    onBegin: (event) => {
      const { tool: current, color: ink, sizes: size } = now.current
      const point = at(event.x, event.y)
      const width = size.stroke
      anchor.current = point
      draft.current =
        current === 'text'
          ? { kind: 'tap', at: point }
          : current === 'crop'
            ? { kind: 'crop', from: point, to: point }
            : current === 'pen'
              ? {
                  kind: 'shape',
                  shape: { kind: 'pen', color: ink, width, points: [point.x, point.y, 0.5] },
                }
              : current === 'arrow'
                ? {
                    kind: 'shape',
                    shape: { kind: 'arrow', color: ink, width, from: point, to: point },
                  }
                : {
                    kind: 'shape',
                    shape: {
                      kind: 'rect',
                      color: ink,
                      width,
                      rect: { ...point, width: 0, height: 0 },
                    },
                  }
      redraw()
    },
    onUpdate: (event) => {
      const image = now.current.working
      const current = draft.current
      if (!image || !current || current.kind === 'tap') return
      const point = at(event.x, event.y)
      if (current.kind === 'crop') current.to = point
      else if (current.shape.kind === 'pen') current.shape.points.push(point.x, point.y, 0.5)
      else if (current.shape.kind === 'arrow') current.shape.to = point
      else if (current.shape.kind === 'rect' && anchor.current) {
        current.shape.rect = spanRect(anchor.current, point, image.width, image.height)
      }
      redraw()
    },
    onFinalize: (event) => {
      const image = now.current.working
      const current = draft.current
      draft.current = null
      anchor.current = null
      redraw()
      if (!image || !current || event.canceled) return
      if (current.kind === 'tap') {
        if (writingNow.current) commitWriting()
        setWriting({ x: current.at.x, y: current.at.y - now.current.sizes.text / 2, text: '' })
        return
      }
      if (current.kind === 'crop') {
        const rect = spanRect(current.from, current.to, image.width, image.height)
        if (rect.width >= MARKUP_MIN_SPAN && rect.height >= MARKUP_MIN_SPAN) {
          haptic.pick()
          setOps((list) => [...list, { kind: 'crop', rect }])
        }
        return
      }
      const shape = current.shape
      const big =
        shape.kind === 'arrow'
          ? Math.hypot(shape.to.x - shape.from.x, shape.to.y - shape.from.y) >= MARKUP_MIN_SPAN
          : shape.kind === 'rect'
            ? shape.rect.width >= MARKUP_MIN_SPAN && shape.rect.height >= MARKUP_MIN_SPAN
            : true
      if (big) setOps((list) => [...list, { kind: 'shape', shape }])
    },
  })

  const shapes = useMemo(() => markupShapes(ops), [ops])
  const crop = markupCrop(ops)
  const dragging = draft.current
  const shownCrop =
    dragging?.kind === 'crop' && working
      ? spanRect(dragging.from, dragging.to, working.width, working.height)
      : crop

  const undo = () => {
    haptic.tap()
    if (writing) setWriting(null)
    else setOps((list) => list.slice(0, -1))
  }

  const done = async () => {
    if (!working || exporting) return
    const label = labelOp()
    setWriting(null)
    const steps = label ? [...ops, label] : ops
    if (label) setOps(steps)
    if (steps.length === 0) {
      props.onCancel()
      return
    }
    const marks = markupShapes(steps)
    const cutTo = markupCrop(steps)
    setExporting(true)
    try {
      if (marks.length === 0) {
        props.onDone(await saveCut(working.uri, cutTo, working.png))
        return
      }
      // A frame with the last label and without the crop's veil, which the snapshot must not hold.
      await new Promise((resolve) => setTimeout(resolve, 80))
      const base64 = await new Promise<string>((resolve, reject) => {
        const view = svg.current
        if (!view) return reject(new Error('No drawing to save'))
        view.toDataURL((data) => (data ? resolve(data) : reject(new Error('Empty snapshot'))))
      })
      const file = new File(Paths.cache, `huli-markup-${Date.now()}.png`)
      file.create({ overwrite: true })
      await file.write(base64, { encoding: 'base64' })
      try {
        let cut: MarkupRect | null = null
        const crop = cutTo
        if (crop) {
          // The snapshot is the view's size at the screen's scale, not the picture's.
          const probe = await ImageManipulator.manipulate(file.uri).renderAsync()
          const ratio = probe.width / working.width
          probe.release()
          cut = {
            x: crop.x * ratio,
            y: crop.y * ratio,
            width: crop.width * ratio,
            height: crop.height * ratio,
          }
        }
        props.onDone(await saveCut(file.uri, cut, true))
      } finally {
        file.delete()
      }
    } catch (error) {
      console.warn('Could not save the marked-up picture', error)
      setExporting(false)
      Alert.alert('没能保存标注', (error as Error).message)
    }
  }

  const onArea = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout
    setArea({ width, height })
  }

  const displayWidth = working ? working.width * scale : 0
  const displayHeight = working ? working.height * scale : 0
  const line = 1.5 / scale

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={props.onCancel}
    >
      <GestureHandlerRootView
        style={[styles.root, { backgroundColor: c.bg, paddingTop: insets.top }]}
      >
        <View style={styles.bar}>
          <Pressable
            onPress={props.onCancel}
            hitSlop={10}
            accessibilityRole="button"
            disabled={exporting}
          >
            <Text style={[styles.barButton, { color: c.text }]}>取消</Text>
          </Pressable>
          <Text style={[styles.title, { color: c.text }]} accessibilityRole="header">
            标注
          </Text>
          <Pressable
            onPress={() => void done()}
            hitSlop={10}
            accessibilityRole="button"
            disabled={!working || exporting}
            style={{ opacity: !working || exporting ? 0.5 : 1 }}
          >
            {exporting ? (
              <ActivityIndicator size="small" color={c.tint} />
            ) : (
              <Text style={[styles.barButton, styles.done, { color: c.tint }]}>完成</Text>
            )}
          </Pressable>
        </View>

        <View style={styles.area} onLayout={onArea}>
          {failed ? (
            <Text style={[styles.note, { color: c.danger }]}>{failed}</Text>
          ) : !working || !area ? (
            <ActivityIndicator color={c.textSecondary} />
          ) : (
            <GestureDetector gesture={pan}>
              <View style={{ width: displayWidth, height: displayHeight }} collapsable={false}>
                <Svg
                  ref={svg}
                  width={displayWidth}
                  height={displayHeight}
                  viewBox={`0 0 ${working.width} ${working.height}`}
                >
                  <SvgImage
                    href={{ uri: working.uri }}
                    x={0}
                    y={0}
                    width={working.width}
                    height={working.height}
                    preserveAspectRatio="none"
                  />
                  {shapes.map((shape, index) => (
                    <ShapeView key={index} shape={shape} />
                  ))}
                  {dragging?.kind === 'shape' && <ShapeView shape={dragging.shape} />}
                  {shownCrop && !exporting && (
                    <CropVeil
                      crop={shownCrop}
                      width={working.width}
                      height={working.height}
                      line={line}
                    />
                  )}
                </Svg>
                {writing && (
                  <TextInput
                    autoFocus
                    value={writing.text}
                    onChangeText={(text) => setWriting({ ...writing, text })}
                    onSubmitEditing={commitWriting}
                    onBlur={commitWriting}
                    placeholder="输入文字"
                    placeholderTextColor={HALO}
                    returnKeyType="done"
                    accessibilityLabel="标注文字"
                    style={[
                      styles.input,
                      {
                        left: writing.x * scale,
                        top: writing.y * scale,
                        fontSize: Math.max(14, sizes.text * scale),
                        color: COLORS[color],
                      },
                    ]}
                  />
                )}
              </View>
            </GestureDetector>
          )}
        </View>

        <View
          style={[styles.tools, { paddingBottom: insets.bottom + 10, borderTopColor: c.border }]}
        >
          <View style={styles.row}>
            {MARKUP_TOOLS.map((each) => {
              const on = tool === each
              return (
                <Pressable
                  key={each}
                  onPress={() => {
                    haptic.pick()
                    setTool(each)
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={TOOLS[each].name}
                  accessibilityState={{ selected: on }}
                  style={[styles.tool, on && { backgroundColor: c.fillStrong }]}
                >
                  <Icon icon={TOOLS[each].icon} size={20} color={on ? c.text : c.textSecondary} />
                </Pressable>
              )
            })}
            <Pressable
              onPress={undo}
              disabled={ops.length === 0 && !writing}
              accessibilityRole="button"
              accessibilityLabel="撤销"
              style={[styles.tool, { opacity: ops.length === 0 && !writing ? 0.35 : 1 }]}
            >
              <Icon icon={UNDO} size={20} color={c.textSecondary} />
            </Pressable>
          </View>
          <View style={styles.row}>
            {MARKUP_COLORS.map((each) => {
              const on = color === each
              return (
                <Pressable
                  key={each}
                  onPress={() => {
                    haptic.pick()
                    setColor(each)
                  }}
                  accessibilityRole="radio"
                  accessibilityLabel={COLOR_NAMES[each]}
                  accessibilityState={{ checked: on }}
                  hitSlop={6}
                  style={[
                    styles.swatch,
                    { backgroundColor: COLORS[each], borderColor: on ? c.text : 'transparent' },
                  ]}
                />
              )
            })}
          </View>
          <Text style={[styles.note, { color: c.textSecondary }]}>
            {crop ? '完成后只保留裁剪框里的部分。' : '直接在图片上画，完成后替换原图。'}
          </Text>
        </View>
      </GestureHandlerRootView>
    </Modal>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    height: 48,
  },
  barButton: { fontSize: 17 },
  done: { fontWeight: '600' },
  title: { fontSize: 17, fontWeight: '600' },
  area: { flex: 1, alignItems: 'center', justifyContent: 'center', margin: 12 },
  input: {
    position: 'absolute',
    minWidth: 80,
    padding: 0,
    fontWeight: '600',
    borderBottomWidth: 1,
    borderBottomColor: HALO,
  },
  tools: { gap: 12, paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 10 },
  tool: { width: 44, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  swatch: { width: 30, height: 30, borderRadius: 15, borderWidth: 2.5 },
  note: { fontSize: 13, lineHeight: 18, textAlign: 'center', paddingHorizontal: 18 },
})
