import {
  createContext,
  useContext,
  useEffect,
  useEffectEvent,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { DragDropProvider, useDragDropManager, type DragEndEvent } from '@dnd-kit/react'
import { isSortable, useSortable } from '@dnd-kit/react/sortable'
import { tabSensors } from '@renderer/components/tab-sensors'
import { InSessionDrag } from '@renderer/features/split/session-drag-model'
import { cn } from '@renderer/lib/utils'

// How far a pointer may travel during a held press that still counts as a click on the heading.
const PRESS_TRAVEL = 10

// The list a group belongs to: its groups' type, so they collide only with one another.
const ListType = createContext('')

/**
 * Groups the user can drag into another order, each a `SortableGroup` inside, such as the
 * sidebar's folders. A group dropped outside the list goes back to its place.
 *
 * Huli: inside the session drag's scope (the sidebar), the list joins that drag's manager rather
 * than opening one of its own, whose scope took the session rows inside the groups away from the
 * split's and the folders' drops. Each list's groups take a type of their own, so a session or
 * another list's group never lands among them.
 */
export function SortableList({
  onMove,
  onPress,
  className,
  children,
}: {
  className?: string
  onMove: (from: number, to: number) => void
  /** A press held long enough to pick a group up and let go where it began, as a click. */
  onPress?: (id: string) => void
  children: ReactNode
}) {
  const type = useId()
  const shared = useContext(InSessionDrag)
  const list = useRef<HTMLDivElement>(null)
  const [drawn, setDrawn] = useState(0)
  const dragEnded = (event: DragEndEvent) => {
    const source = event.operation.source ?? null
    if (event.canceled || !isSortable(source) || source.type !== type) return
    const { initial, current } = event.operation.position
    if (source.index === source.initialIndex) {
      const travel = Math.hypot(current.x - initial.x, current.y - initial.y)
      if (event.nativeEvent?.type.startsWith('pointer') && travel < PRESS_TRAVEL) {
        onPress?.(String(source.id))
      }
      return
    }
    const box = list.current?.getBoundingClientRect()
    if (
      !box ||
      current.x < box.left ||
      current.x > box.right ||
      current.y < box.top ||
      current.y > box.bottom
    ) {
      // The groups' elements were moved while dragging; drawn afresh, they are back in place.
      setDrawn((count) => count + 1)
      return
    }
    onMove(source.initialIndex, source.index)
  }
  const body = (
    <ListType.Provider value={type}>
      <div ref={list} key={drawn} className={cn('flex shrink-0 flex-col', className)}>
        {children}
      </div>
    </ListType.Provider>
  )
  return shared ? (
    <>
      <ListEnd onDragEnd={dragEnded} />
      {body}
    </>
  ) : (
    <DragDropProvider sensors={tabSensors} onDragEnd={dragEnded}>
      {body}
    </DragDropProvider>
  )
}

/** Hears the end of every drag of the enclosing manager, with the latest handler. */
function ListEnd({ onDragEnd }: { onDragEnd: (event: DragEndEvent) => void }) {
  const manager = useDragDropManager()
  const ended = useEffectEvent(onDragEnd)
  useEffect(() => manager?.monitor.addEventListener('dragend', (event) => ended(event)), [manager])
  return null
}

/** One group of a `SortableList`, picked up by the element `children` gives `handleRef`. */
export function SortableGroup({
  id,
  index,
  disabled,
  as: Tag = 'div',
  label,
  chip = label,
  className,
  children,
}: {
  id: string
  index: number
  disabled: boolean
  as?: 'div' | 'section'
  label?: string
  /** Huli: the name the drag's chip shows under the pointer, where one shows; `label` else. */
  chip?: string
  className?: string
  children: (handleRef: (element: Element | null) => void) => ReactNode
}) {
  const type = useContext(ListType)
  const data = useMemo(() => ({ chip }), [chip])
  const { ref, handleRef, isDragging } = useSortable({
    id,
    index,
    disabled,
    data,
    type,
    accept: type,
    group: type,
    sensors: tabSensors,
  })
  return (
    <Tag
      ref={ref}
      aria-label={label}
      className={className ?? 'kettu-side-sortable'}
      data-dragging={isDragging || undefined}
    >
      {children(handleRef)}
    </Tag>
  )
}
