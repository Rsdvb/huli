// Layout by window size, for iPad: the window's width decides, not the device, so Split View,
// Slide Over and Stage Manager's resizing get the phone layout when they leave it narrow.

import { useWindowDimensions } from 'react-native'

/** From this window width the 会话 tab shows the list and a session side by side. */
export const SPLIT_MIN_WIDTH = 768
/** The session list's column in the split. */
export const LIST_COLUMN = 360
/** The widest the other tabs' content grows; wider windows center it. */
export const READABLE_WIDTH = 720

export function useWide(): boolean {
  return useWindowDimensions().width >= SPLIT_MIN_WIDTH
}

/** The width a tab's content lays out in: the window's, or the readable column on a wide one. */
export function useContentWidth(): number {
  const { width } = useWindowDimensions()
  return width >= SPLIT_MIN_WIDTH ? Math.min(width, READABLE_WIDTH) : width
}
