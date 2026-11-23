// Huli: the global screenshot (截图发到会话). Its hotkey freezes the display under the pointer in a
// window of Kite's own over it, where the user drags out a region; main crops the capture to it
// and the main window attaches it to the session in focus, or to New session's message box. The
// overlay's page gets only what `src/preload/capture.ts` exposes, and main takes from it only the
// region or Cancel.

/** A region of the overlay, in its CSS pixels, which are the display's points. */
export interface CaptureRegion {
  x: number
  y: number
  width: number
  height: number
}

/** What main shows the overlay: the frozen display, as a picture's address. */
export interface CaptureImage {
  url: string
}

/** A screenshot for the main window to attach: a PNG and the name its tile shows. */
export interface CaptureShot {
  name: string
  data: Uint8Array
}

/** The smallest region worth attaching, in points, so a stray click takes nothing. */
export const MIN_CAPTURE_POINTS = 4

const MAX_POINTS = 100_000

/** A region the overlay sent, inside `bounds` (its size), or null when it is none. */
export function parseCaptureRegion(
  value: unknown,
  bounds: { width: number; height: number },
): CaptureRegion | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { x, y, width, height } = value as Record<string, unknown>
  const numbers = [x, y, width, height]
  if (!numbers.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  const [left, top, w, h] = numbers as number[]
  if (w! < MIN_CAPTURE_POINTS || h! < MIN_CAPTURE_POINTS || w! > MAX_POINTS || h! > MAX_POINTS) {
    return null
  }
  const x0 = Math.max(0, Math.round(left!))
  const y0 = Math.max(0, Math.round(top!))
  const x1 = Math.min(bounds.width, Math.round(left! + w!))
  const y1 = Math.min(bounds.height, Math.round(top! + h!))
  if (x1 - x0 < MIN_CAPTURE_POINTS || y1 - y0 < MIN_CAPTURE_POINTS) return null
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}

/** What the overlay's preload exposes as `window.kettuCapture`. */
export interface CaptureOverlayApi {
  onImage(listener: (image: CaptureImage) => void): () => void
  done(region: CaptureRegion): void
  cancel(): void
}
