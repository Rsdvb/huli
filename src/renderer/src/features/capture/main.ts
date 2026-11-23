// Huli: the screenshot overlay's page: the frozen display under a scrim, and the region the user
// drags out of it, which goes to main on release; Esc or a right click cancels. Plain DOM, so the
// page that opens on the hotkey's press loads in a moment. See src/main/screen-capture.ts.

import '@renderer/styles/tokens.css'
import './capture.css'
import { MIN_CAPTURE_POINTS, type CaptureOverlayApi } from '@shared/capture'

const api = (window as unknown as { kettuCapture: CaptureOverlayApi }).kettuCapture

const picture = document.createElement('img')
picture.className = 'kc-picture'
picture.alt = ''
picture.draggable = false
const scrim = document.createElement('div')
scrim.className = 'kc-scrim'
const box = document.createElement('div')
box.className = 'kc-box'
box.hidden = true
const size = document.createElement('span')
size.className = 'kc-size'
box.append(size)
document.body.append(picture, scrim, box)

api.onImage(({ url }) => {
  picture.src = url
})

let start: { x: number; y: number } | null = null
let region = { x: 0, y: 0, width: 0, height: 0 }

function draw(x: number, y: number): void {
  if (!start) return
  region = {
    x: Math.min(start.x, x),
    y: Math.min(start.y, y),
    width: Math.abs(x - start.x),
    height: Math.abs(y - start.y),
  }
  box.hidden = false
  box.style.transform = `translate(${region.x}px, ${region.y}px)`
  box.style.width = `${region.width}px`
  box.style.height = `${region.height}px`
  size.textContent = `${Math.round(region.width)} × ${Math.round(region.height)}`
  // The scrim leaves the region clear, so it reads as the picture itself.
  const { x: left, y: top, width, height } = region
  scrim.style.clipPath = `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${left}px ${top}px, ${left + width}px ${top}px, ${left + width}px ${top + height}px, ${left}px ${top + height}px, ${left}px ${top}px)`
}

window.addEventListener('pointerdown', (event) => {
  if (event.button === 2) {
    api.cancel()
    return
  }
  if (event.button !== 0) return
  start = { x: event.clientX, y: event.clientY }
  ;(event.target as Element).setPointerCapture?.(event.pointerId)
  draw(event.clientX, event.clientY)
})
window.addEventListener('pointermove', (event) => draw(event.clientX, event.clientY))
window.addEventListener('pointerup', (event) => {
  if (!start || event.button !== 0) return
  draw(event.clientX, event.clientY)
  start = null
  if (region.width < MIN_CAPTURE_POINTS || region.height < MIN_CAPTURE_POINTS) {
    box.hidden = true
    scrim.style.clipPath = ''
    return
  }
  api.done(region)
})
window.addEventListener('contextmenu', (event) => event.preventDefault())
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') api.cancel()
})
