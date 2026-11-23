// Huli: whether an optional feature's entry points show, as Settings > Features has them on this
// computer. See src/shared/features.ts.

import { entryOn, featureOn, type FeatureEntry, type FeatureId } from '@shared/features'
import type { SidebarPage } from '@shared/settings'
import { useSettingsStore } from '@renderer/stores/settings'

/** Whether the entry point shows; it renders again only when its feature is switched. */
export function useEntry(entry: FeatureEntry): boolean {
  return useSettingsStore((s) => entryOn(s.settings.features, entry))
}

/** Whether the feature is on. */
export function useFeature(id: FeatureId): boolean {
  return useSettingsStore((s) => featureOn(s.settings.features, id))
}

/** The same outside React, as in a store's action or a menu's model. */
export function entryShown(entry: FeatureEntry): boolean {
  return entryOn(useSettingsStore.getState().settings.features, entry)
}

/**
 * Runs `start` now while the entry point shows, else once it first does, as when its feature is
 * turned on, so a feature that is off reads nothing at launch.
 */
export function whenEntryOn(entry: FeatureEntry, start: () => unknown): void {
  if (entryShown(entry)) {
    start()
    return
  }
  const stop = useSettingsStore.subscribe((state) => {
    if (!entryOn(state.settings.features, entry)) return
    stop()
    start()
  })
}

/**
 * Huli: the entry point a sidebar page belongs to, for a page of an optional feature. A page
 * whose feature is off never shows in the sidebar; hiding one in Settings › Appearance only takes
 * it out of the sidebar, and its feature keeps running.
 */
export const PAGE_ENTRY: Partial<Record<SidebarPage, FeatureEntry>> = {
  routines: 'sidebar.routines',
}

/** Huli: whether the page's feature is on; pages of Kite's core always are. */
export function pageFeatureOn(
  features: Partial<Record<string, boolean>> | null | undefined,
  page: SidebarPage,
): boolean {
  const entry = PAGE_ENTRY[page]
  return entry === undefined || entryOn(features, entry)
}

/** Huli: the same in React; it renders again only when the page's feature is switched. */
export function usePageFeatureOn(page: SidebarPage): boolean {
  return useSettingsStore((s) => pageFeatureOn(s.settings.features, page))
}
