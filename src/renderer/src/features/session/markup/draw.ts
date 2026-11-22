import { strokePath } from '@shared/canvas-stroke'
import {
  arrowGeometry,
  MARKUP_COLORS,
  type MarkupColor,
  type MarkupRect,
  type MarkupShape,
} from '@shared/markup'

/** The marks' colors as the theme's tokens set them, with the label halo and the crop veil. */
export interface MarkupPaint {
  colors: Record<MarkupColor, string>
  halo: string
  veil: string
}

export function readPaint(element: Element): MarkupPaint {
  const style = getComputedStyle(element)
  const read = (name: string) => style.getPropertyValue(name).trim()
  return {
    colors: Object.fromEntries(
      MARKUP_COLORS.map((color) => [color, read(`--markup-${color}`)]),
    ) as Record<MarkupColor, string>,
    halo: read('--markup-halo'),
    veil: read('--markup-veil'),
  }
}

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export const labelFont = (size: number) =>
  `600 ${size}px 'Inter Variable', Inter, system-ui, sans-serif`

/** Draws one mark in the picture's pixels; the context's transform places them. */
export function drawShape(ctx: Context, shape: MarkupShape, paint: MarkupPaint) {
  const color = paint.colors[shape.color]
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.strokeStyle = color
  ctx.fillStyle = color
  switch (shape.kind) {
    case 'pen': {
      const path = strokePath(shape.points, shape.width, false)
      if (path) ctx.fill(new Path2D(path))
      break
    }
    case 'arrow': {
      const { shaftEnd, head } = arrowGeometry(shape.from, shape.to, shape.width)
      ctx.lineWidth = shape.width
      ctx.beginPath()
      ctx.moveTo(shape.from.x, shape.from.y)
      ctx.lineTo(shaftEnd.x, shaftEnd.y)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(head[0].x, head[0].y)
      ctx.lineTo(head[1].x, head[1].y)
      ctx.lineTo(head[2].x, head[2].y)
      ctx.closePath()
      ctx.fill()
      ctx.lineWidth = shape.width / 2
      ctx.stroke()
      break
    }
    case 'rect': {
      const { x, y, width, height } = shape.rect
      ctx.lineWidth = shape.width
      ctx.beginPath()
      ctx.roundRect(x, y, width, height, shape.width)
      ctx.stroke()
      break
    }
    case 'text': {
      ctx.font = labelFont(shape.size)
      ctx.textBaseline = 'top'
      ctx.lineWidth = Math.max(3, shape.size / 4)
      ctx.strokeStyle = paint.halo
      shape.text.split('\n').forEach((line, index) => {
        const y = shape.y + index * shape.size * 1.25
        ctx.strokeText(line, shape.x, y)
        ctx.fillText(line, shape.x, y)
      })
      break
    }
  }
  ctx.restore()
}

/** Darkens what the crop leaves out, and outlines what it keeps. */
export function drawCropVeil(
  ctx: Context,
  crop: MarkupRect,
  width: number,
  height: number,
  paint: MarkupPaint,
  lineWidth: number,
) {
  ctx.save()
  ctx.fillStyle = paint.veil
  ctx.beginPath()
  ctx.rect(0, 0, width, height)
  ctx.rect(crop.x, crop.y, crop.width, crop.height)
  ctx.fill('evenodd')
  ctx.strokeStyle = paint.halo
  ctx.lineWidth = lineWidth
  ctx.setLineDash([lineWidth * 4, lineWidth * 3])
  ctx.strokeRect(crop.x, crop.y, crop.width, crop.height)
  ctx.restore()
}

/** The picture with its marks, cut to the crop, as a PNG. */
export async function exportMarkup(
  image: ImageBitmap,
  shapes: readonly MarkupShape[],
  crop: MarkupRect | null,
  paint: MarkupPaint,
): Promise<Blob> {
  const area = crop ?? { x: 0, y: 0, width: image.width, height: image.height }
  const width = Math.max(1, Math.round(area.width))
  const height = Math.max(1, Math.round(area.height))
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('No 2D canvas')
  ctx.translate(-Math.round(area.x), -Math.round(area.y))
  ctx.drawImage(image, 0, 0)
  for (const shape of shapes) drawShape(ctx, shape, paint)
  return canvas.convertToBlob({ type: 'image/png' })
}
