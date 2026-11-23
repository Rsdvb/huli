/**
 * Huli: marks the sidebar's list with `data-pointer` while the pointer is over the sidebar, which
 * shows the list's scrollbar (affect.css). A `:hover` rule on the sidebar did this, but made each
 * entry and exit of the pointer restyle every row. A ref for an element inside the list.
 */
export function sidePointer(inside: HTMLElement | null): (() => void) | undefined {
  const list = inside?.closest('.ui-as-side__nav')
  const side = list?.closest('.ui-as-side')
  if (!list || !side) return
  const enter = (): void => list.toggleAttribute('data-pointer', true)
  const leave = (): void => list.toggleAttribute('data-pointer', false)
  side.addEventListener('pointerenter', enter)
  side.addEventListener('pointerleave', leave)
  if (side.matches(':hover')) enter()
  return () => {
    side.removeEventListener('pointerenter', enter)
    side.removeEventListener('pointerleave', leave)
    leave()
  }
}
