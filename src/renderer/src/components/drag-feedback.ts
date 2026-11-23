import type { ComponentProps } from 'react'
import {
  useDragDropMonitor,
  type BeforeDragStartEvent,
  type DragDropManager,
  type DragDropProvider,
} from '@dnd-kit/react'

type Plugins = NonNullable<ComponentProps<typeof DragDropProvider>['plugins']>

/**
 * dnd-kit's default plugins without Cursor and PreventSelection. Each puts a `* { ... }` rule on
 * the page while a drag runs, and adding the rule and taking it away restyles every element: a
 * long frame as the drag starts and another as it ends (about 100 ms each beside a sidebar of 300
 * rows). `@dnd-kit/react` does not export them, so they are told apart by their code. A provider
 * that takes these renders `DragFeedback`, which does their work.
 */
export const lightPlugins: Plugins = (defaults) =>
  defaults.filter((plugin) => !/\b(grabbing|selectionchange)\b/.test(String(plugin)))

const clearSelection = (): void => getSelection()?.removeAllRanges()

// The element a pointer drag holds the pointer capture on, and its own cursor before the drag.
let held: { element: HTMLElement; cursor: string } | null = null

/**
 * The pointer sensor gives the body the pointer capture, which takes the hover off everything the
 * pointer is over: the sidebar and the rows restyle as the drag starts, and again as it ends
 * (about 80 ms each beside 300 rows). The dragged element holds it instead, right after, so the
 * hover stays where it was; the capture's cursor is the one that shows.
 */
function holdPointer(element: HTMLElement, pointerId: number): void {
  try {
    element.setPointerCapture(pointerId)
  } catch {
    return
  }
  held = { element, cursor: element.style.cursor }
  element.style.cursor = 'grabbing'
}

function dragStarting(event: BeforeDragStartEvent, manager: DragDropManager): void {
  const pointer = event.operation.activatorEvent
  const element = event.operation.source?.element
  // After the sensor's own capture, which it takes once this event returns, and only for a drag
  // that did start.
  queueMicrotask(() => {
    if (manager.dragOperation.status.idle) return
    clearSelection()
    document.addEventListener('selectionchange', clearSelection, { capture: true })
    if (pointer instanceof PointerEvent && element instanceof HTMLElement) {
      holdPointer(element, pointer.pointerId)
    }
  })
}

function dragEnded(): void {
  document.removeEventListener('selectionchange', clearSelection, { capture: true })
  if (!held) return
  const { element, cursor } = held
  held = null
  element.style.cursor = cursor
  // The click that follows the release lands on the dragged element, which the sensor only
  // expects of the body; it is no click on that element.
  const swallow = (click: MouseEvent) => {
    if (click.detail > 0 && click.target instanceof Node && element.contains(click.target)) {
      click.preventDefault()
      click.stopImmediatePropagation()
    }
  }
  window.addEventListener('click', swallow, true)
  setTimeout(() => window.removeEventListener('click', swallow, true), 0)
}

const handlers = { onBeforeDragStart: dragStarting, onDragEnd: dragEnded }

/** No selected text, and the hover left alone, while a drag of the enclosing provider runs. */
export function DragFeedback(): null {
  useDragDropMonitor(handlers)
  return null
}
