import {
  ArrowUpRight01Icon,
  CropIcon,
  PencilEdit02Icon,
  SquareIcon,
  TextIcon,
  Undo02Icon,
} from '@hugeicons/core-free-icons'
import type { IconSvgElement } from '@hugeicons/react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
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
  type MarkupShape,
  type MarkupTool,
} from '@shared/markup'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Skeleton } from '@renderer/components/ui/skeleton'
import { Spinner } from '@renderer/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip'
import { Glyph } from '@renderer/features/shell/glyph'
import { errorMessage } from '@renderer/lib/host'
import { isMac } from '@renderer/lib/platform'
import { cn } from '@renderer/lib/utils'
import {
  drawCropVeil,
  drawShape,
  exportMarkup,
  labelFont,
  readPaint,
  type MarkupPaint,
} from './draw'

const TOOL_ICONS: Record<MarkupTool, IconSvgElement> = {
  pen: PencilEdit02Icon,
  arrow: ArrowUpRight01Icon,
  rect: SquareIcon,
  text: TextIcon,
  crop: CropIcon,
}

const TOOL_KEYS: Record<string, MarkupTool> = {
  p: 'pen',
  a: 'arrow',
  r: 'rect',
  t: 'text',
  c: 'crop',
}

const COLOR_CLASS: Record<MarkupColor, string> = {
  red: 'bg-(--markup-red)',
  yellow: 'bg-(--markup-yellow)',
  green: 'bg-(--markup-green)',
  blue: 'bg-(--markup-blue)',
}

/** Room the dialog's toolbar, padding and the window's edges take around the picture. */
const ROOM_X = 96
const ROOM_Y = 200
const MOST_WIDTH = 1200
/** A small picture shows at most this much larger, so it stays crisp. */
const MOST_ZOOM = 2

type Loaded =
  { kind: 'loading' } | { kind: 'ready'; image: ImageBitmap } | { kind: 'error'; message: string }

/** What a drag draws until it ends: a mark, or the crop. */
type Draft =
  { kind: 'shape'; shape: MarkupShape } | { kind: 'crop'; from: MarkupPoint; to: MarkupPoint }

/** A label being written, where it goes in the picture's pixels. */
interface Writing {
  id: number
  x: number
  y: number
  text: string
}

function fitScale(image: ImageBitmap): number {
  const width = Math.min(MOST_WIDTH, window.innerWidth - ROOM_X)
  const height = window.innerHeight - ROOM_Y
  return Math.max(0.05, Math.min(width / image.width, height / image.height, MOST_ZOOM))
}

/**
 * Huli: marks a picture up before it is sent: a pen, arrows, boxes, labels and a crop, in four
 * colors, with undo. Done hands back the picture with its marks as a PNG, cut to the crop. Loaded
 * on first use, apart from the composer.
 */
export default function MarkupDialog({
  name,
  load,
  onDone,
  onClose,
}: {
  name: string
  /** Reads the picture's bytes. */
  load: () => Promise<Blob>
  onDone: (image: Blob) => Promise<void>
  onClose: () => void
}) {
  const { t } = useTranslation(['composer', 'common'])
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' })
  const [tool, setTool] = useState<MarkupTool>('pen')
  const [color, setColor] = useState<MarkupColor>('red')
  const [ops, setOps] = useState<MarkupOp[]>([])
  const [writing, setShownWriting] = useState<Writing | null>(null)
  // The label being written, read by its input's blur, which may come after another one started.
  const writingNow = useRef<Writing | null>(null)
  const labels = useRef(1)
  const pressedAt = useRef<MarkupPoint | null>(null)
  const setWriting = (next: Writing | null) => {
    writingNow.current = next
    setShownWriting(next)
  }
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [scale, setScale] = useState(1)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const paint = useRef<MarkupPaint | null>(null)
  const draft = useRef<Draft | null>(null)
  const frame = useRef(0)

  useEffect(() => {
    let live = true
    let bitmap: ImageBitmap | null = null
    load()
      .then((blob) => createImageBitmap(blob))
      .then((image) => {
        bitmap = image
        if (!live) return image.close()
        setScale(fitScale(image))
        setLoaded({ kind: 'ready', image })
      })
      .catch((error: unknown) => {
        if (live) setLoaded({ kind: 'error', message: errorMessage(error) })
      })
    return () => {
      live = false
      bitmap?.close()
    }
  }, [load])

  const image = loaded.kind === 'ready' ? loaded.image : null
  useEffect(() => {
    if (!image) return
    const resized = () => setScale(fitScale(image))
    window.addEventListener('resize', resized)
    return () => window.removeEventListener('resize', resized)
  }, [image])

  const sizes = image ? markupSizes(image.width, image.height) : { stroke: 4, text: 24 }

  const draw = useCallback(() => {
    frame.current = 0
    const element = canvas.current
    const ctx = element?.getContext('2d')
    if (!element || !ctx || !image) return
    paint.current ??= readPaint(element)
    const ratio = window.devicePixelRatio || 1
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, element.width, element.height)
    ctx.setTransform(scale * ratio, 0, 0, scale * ratio, 0, 0)
    ctx.drawImage(image, 0, 0)
    for (const shape of markupShapes(ops)) drawShape(ctx, shape, paint.current)
    const now = draft.current
    if (now?.kind === 'shape') drawShape(ctx, now.shape, paint.current)
    const crop =
      now?.kind === 'crop' ? spanRect(now.from, now.to, image.width, image.height) : markupCrop(ops)
    if (crop) drawCropVeil(ctx, crop, image.width, image.height, paint.current, 1.5 / scale)
  }, [image, ops, scale])

  const redraw = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(draw)
  }, [draw])
  useLayoutEffect(() => {
    const element = canvas.current
    if (!element || !image) return
    const ratio = window.devicePixelRatio || 1
    element.width = Math.round(image.width * scale * ratio)
    element.height = Math.round(image.height * scale * ratio)
    draw()
  }, [image, scale, draw])
  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  const at = (event: PointerEvent<HTMLCanvasElement>): MarkupPoint => {
    const box = event.currentTarget.getBoundingClientRect()
    return { x: (event.clientX - box.left) / scale, y: (event.clientY - box.top) / scale }
  }

  /** Ends the label `id` with what it holds, unless another took its place already. */
  const commitWriting = (id: number) => {
    const current = writingNow.current
    if (!current || current.id !== id) return
    setWriting(null)
    const text = current.text.trim()
    if (!text) return
    const shape: MarkupShape = {
      kind: 'text',
      color,
      size: sizes.text,
      x: current.x,
      y: current.y,
      text,
    }
    setOps((list) => [...list, { kind: 'shape', shape }])
  }

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (!image || event.button !== 0 || saving) return
    const point = at(event)
    if (tool === 'text') {
      // The label starts once the click ends, so the press's own focus change cannot take its
      // input's focus away; a press elsewhere ends the label being written.
      if (writing) commitWriting(writing.id)
      pressedAt.current = point
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    const width = sizes.stroke
    const pressure = event.pointerType === 'mouse' ? 0.5 : event.pressure
    draft.current =
      tool === 'crop'
        ? { kind: 'crop', from: point, to: point }
        : tool === 'pen'
          ? {
              kind: 'shape',
              shape: { kind: 'pen', color, width, points: [point.x, point.y, pressure] },
            }
          : tool === 'arrow'
            ? { kind: 'shape', shape: { kind: 'arrow', color, width, from: point, to: point } }
            : {
                kind: 'shape',
                shape: { kind: 'rect', color, width, rect: { ...point, width: 0, height: 0 } },
              }
  }

  const start = useRef<MarkupPoint | null>(null)
  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const now = draft.current
    if (!now || !image) return
    const point = at(event)
    if (now.kind === 'crop') {
      now.to = point
    } else if (now.shape.kind === 'pen') {
      const pressure = event.pointerType === 'mouse' ? 0.5 : event.pressure
      now.shape.points.push(point.x, point.y, pressure)
    } else if (now.shape.kind === 'arrow') {
      now.shape.to = point
    } else if (now.shape.kind === 'rect') {
      start.current ??= { x: now.shape.rect.x, y: now.shape.rect.y }
      now.shape.rect = spanRect(start.current, point, image.width, image.height)
    }
    redraw()
  }

  const onPointerUp = (event: PointerEvent<HTMLCanvasElement>) => {
    const pressed = pressedAt.current
    pressedAt.current = null
    if (pressed && tool === 'text' && event.type === 'pointerup') {
      setWriting({ id: labels.current++, x: pressed.x, y: pressed.y - sizes.text / 2, text: '' })
      return
    }
    const now = draft.current
    draft.current = null
    start.current = null
    if (!now || !image) return
    if (now.kind === 'crop') {
      const rect = spanRect(now.from, now.to, image.width, image.height)
      if (rect.width >= MARKUP_MIN_SPAN && rect.height >= MARKUP_MIN_SPAN) {
        setOps((list) => [...list, { kind: 'crop', rect }])
      } else redraw()
      return
    }
    const shape = now.shape
    const big =
      shape.kind === 'pen'
        ? shape.points.length >= 3
        : shape.kind === 'arrow'
          ? Math.hypot(shape.to.x - shape.from.x, shape.to.y - shape.from.y) >= MARKUP_MIN_SPAN
          : shape.kind === 'rect'
            ? shape.rect.width >= MARKUP_MIN_SPAN && shape.rect.height >= MARKUP_MIN_SPAN
            : true
    if (big) setOps((list) => [...list, { kind: 'shape', shape }])
    else redraw()
  }

  const undo = () => {
    if (writing) setWriting(null)
    else setOps((list) => list.slice(0, -1))
  }

  const done = async () => {
    if (!image || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      const shapes = markupShapes(ops)
      const blob = await exportMarkup(image, shapes, markupCrop(ops), paint.current!)
      await onDone(blob)
    } catch (error) {
      setSaveError(errorMessage(error))
      setSaving(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement || event.nativeEvent.isComposing) return
    const mod = isMac ? event.metaKey : event.ctrlKey
    if (mod && event.key.toLowerCase() === 'z' && !event.shiftKey) {
      event.preventDefault()
      undo()
      return
    }
    if (mod || event.altKey) return
    const picked = TOOL_KEYS[event.key.toLowerCase()]
    if (picked) setTool(picked)
  }

  const cursor = tool === 'text' ? 'cursor-text' : 'cursor-crosshair'
  const hasCrop = markupCrop(ops) !== null

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="w-max max-w-[calc(100vw-2rem)] gap-3 p-3 sm:max-w-[calc(100vw-2rem)]"
        onKeyDown={onKeyDown}
      >
        <div className="flex items-center gap-3 pr-1 pl-1.5">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-ui">{t('markup.title')}</DialogTitle>
            <DialogDescription className="truncate text-hint">{name}</DialogDescription>
          </div>
          <div role="toolbar" aria-label={t('markup.tools')} className="flex items-center gap-0.5">
            {MARKUP_TOOLS.map((each) => (
              <Tooltip key={each}>
                <TooltipTrigger
                  render={
                    <Button
                      variant="quiet"
                      size="icon-sm"
                      aria-pressed={tool === each}
                      aria-label={t(`markup.tool.${each}`)}
                      onClick={() => setTool(each)}
                    />
                  }
                >
                  <Glyph icon={TOOL_ICONS[each]} />
                </TooltipTrigger>
                <TooltipContent>
                  {t(`markup.tool.${each}`)} · {each[0]!.toUpperCase()}
                </TooltipContent>
              </Tooltip>
            ))}
            <span aria-hidden className="mx-1.5 h-4 w-px bg-border" />
            <div
              role="radiogroup"
              aria-label={t('markup.color')}
              className="flex items-center gap-1"
            >
              {MARKUP_COLORS.map((each) => (
                <button
                  key={each}
                  type="button"
                  role="radio"
                  aria-checked={color === each}
                  aria-label={t(`markup.colors.${each}`)}
                  title={t(`markup.colors.${each}`)}
                  onClick={() => setColor(each)}
                  className={cn(
                    'size-5 rounded-full shadow-[inset_0_0_0_var(--hairline)_var(--border-strong)] transition-transform duration-(--duration-fast) focus-ring',
                    COLOR_CLASS[each],
                    color === each
                      ? 'scale-100 ring-2 ring-(--shell-ink) ring-offset-2 ring-offset-(--shell-card)'
                      : 'scale-90 hover:scale-100',
                  )}
                />
              ))}
            </div>
            <span aria-hidden className="mx-1.5 h-4 w-px bg-border" />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="quiet"
                    size="icon-sm"
                    aria-label={t('markup.undo')}
                    disabled={ops.length === 0 && !writing}
                    onClick={undo}
                  />
                }
              >
                <Glyph icon={Undo02Icon} />
              </TooltipTrigger>
              <TooltipContent>
                {t('markup.undo')} · {isMac ? '⌘Z' : 'Ctrl+Z'}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div className="relative grid min-h-40 min-w-80 place-items-center overflow-hidden rounded-xl bg-subtle">
          {loaded.kind === 'loading' && <Skeleton className="h-72 w-120 rounded-xl" />}
          {loaded.kind === 'error' && (
            <p role="alert" className="px-6 py-10 text-ui text-danger">
              {t('markup.loadFailed', { error: loaded.message })}
            </p>
          )}
          {image && (
            <div
              className="relative"
              style={{ width: image.width * scale, height: image.height * scale }}
            >
              <canvas
                ref={canvas}
                aria-label={t('markup.canvas', { name })}
                className={cn('block size-full touch-none', cursor)}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
              />
              {writing && (
                <input
                  key={writing.id}
                  autoFocus
                  value={writing.text}
                  aria-label={t('markup.label')}
                  placeholder={t('markup.labelPlaceholder')}
                  onChange={(event) => setWriting({ ...writing, text: event.target.value })}
                  onBlur={() => commitWriting(writing.id)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing || event.keyCode === 229) return
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      commitWriting(writing.id)
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      event.stopPropagation()
                      setWriting(null)
                    }
                  }}
                  className="absolute min-w-24 border-0 bg-transparent p-0 font-semibold outline-1 outline-(--markup-halo) outline-dashed"
                  style={{
                    left: writing.x * scale,
                    top: writing.y * scale,
                    font: labelFont(sizes.text * scale),
                    color: `var(--markup-${color})`,
                    width: `${Math.max(6, writing.text.length + 2)}ch`,
                  }}
                />
              )}
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 pl-1.5">
          <p
            className={cn(
              'min-w-0 flex-1 truncate text-hint',
              saveError ? 'text-danger' : 'text-tertiary',
            )}
            role={saveError ? 'alert' : undefined}
          >
            {saveError
              ? t('markup.saveFailed', { error: saveError })
              : hasCrop
                ? t('markup.cropNote')
                : t('markup.hint')}
          </p>
          <Button variant="ghost" size="sm" disabled={saving} onClick={onClose}>
            {t('common:actions.cancel')}
          </Button>
          <Button size="sm" disabled={!image || saving} onClick={() => void done()}>
            {saving && <Spinner className="size-3.5" />}
            {t('markup.done')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
