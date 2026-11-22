// Huli: marking up a picture before it is sent: what the desktop's and the phone's editors draw,
// in the picture's own pixels, so both draw it alike. Each client renders it its own way: the
// desktop on a canvas, the phone in SVG.

export const MARKUP_TOOLS = ['pen', 'arrow', 'rect', 'text', 'crop'] as const
export type MarkupTool = (typeof MARKUP_TOOLS)[number]

/** The colors a mark takes, which each client maps to its own fixed values. */
export const MARKUP_COLORS = ['red', 'yellow', 'green', 'blue'] as const
export type MarkupColor = (typeof MARKUP_COLORS)[number]

export interface MarkupPoint {
  x: number
  y: number
}

export interface MarkupRect {
  x: number
  y: number
  width: number
  height: number
}

export type MarkupShape =
  // `points`: x, y and pressure, three numbers a point; a phone's pressure is 0.5.
  | { kind: 'pen'; color: MarkupColor; width: number; points: number[] }
  | { kind: 'arrow'; color: MarkupColor; width: number; from: MarkupPoint; to: MarkupPoint }
  | { kind: 'rect'; color: MarkupColor; width: number; rect: MarkupRect }
  // `x` and `y`: the top left of its first line.
  | { kind: 'text'; color: MarkupColor; size: number; x: number; y: number; text: string }

/** One step the user took, which Undo takes back: a mark drawn, or the crop set or cleared. */
export type MarkupOp =
  { kind: 'shape'; shape: MarkupShape } | { kind: 'crop'; rect: MarkupRect | null }

export function markupShapes(ops: readonly MarkupOp[]): MarkupShape[] {
  return ops.flatMap((op) => (op.kind === 'shape' ? [op.shape] : []))
}

/** The crop the steps leave, or null for the whole picture. */
export function markupCrop(ops: readonly MarkupOp[]): MarkupRect | null {
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i]!
    if (op.kind === 'crop') return op.rect
  }
  return null
}

/** A stroke's width and a label's size for a picture, so marks read alike on any size of it. */
export function markupSizes(width: number, height: number): { stroke: number; text: number } {
  const side = Math.max(width, height)
  return {
    stroke: Math.max(2, Math.round(side / 280)),
    text: Math.max(14, Math.round(side / 36)),
  }
}

/** The rectangle two corners span, inside a picture of `width` by `height`. */
export function spanRect(
  a: MarkupPoint,
  b: MarkupPoint,
  width: number,
  height: number,
): MarkupRect {
  const clamp = (value: number, most: number) => Math.min(Math.max(value, 0), most)
  const x1 = clamp(Math.min(a.x, b.x), width)
  const y1 = clamp(Math.min(a.y, b.y), height)
  const x2 = clamp(Math.max(a.x, b.x), width)
  const y2 = clamp(Math.max(a.y, b.y), height)
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}

/** The smallest crop or box kept, in the picture's pixels; a smaller drag is taken as a slip. */
export const MARKUP_MIN_SPAN = 8

/** An arrow's shaft end, where the head starts, and the head's three corners. */
export function arrowGeometry(
  from: MarkupPoint,
  to: MarkupPoint,
  width: number,
): { shaftEnd: MarkupPoint; head: [MarkupPoint, MarkupPoint, MarkupPoint] } {
  const angle = Math.atan2(to.y - from.y, to.x - from.x)
  const length = Math.hypot(to.x - from.x, to.y - from.y)
  const head = Math.min(width * 4.5, length * 0.6)
  const spread = Math.PI / 7
  const back = (turn: number): MarkupPoint => ({
    x: to.x - head * Math.cos(angle + turn),
    y: to.y - head * Math.sin(angle + turn),
  })
  const inset = head * Math.cos(spread) * 0.8
  return {
    shaftEnd: { x: to.x - inset * Math.cos(angle), y: to.y - inset * Math.sin(angle) },
    head: [to, back(spread), back(-spread)],
  }
}
