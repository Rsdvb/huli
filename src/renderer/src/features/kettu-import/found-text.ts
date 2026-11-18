// Huli: what was found in Kettu, in words. Huli's own; see tools/huli/README.md.

import { useTranslation } from 'react-i18next'
import type { KettuImportScan } from '@shared/kettu-import'

/**
 * What was counted, as "43 sessions · 2 projects · 31 memory entries · 3 artifacts", memory and
 * artifacts only when Kettu has some.
 */
export function useFoundText(scan: KettuImportScan | null): { found: string } {
  const { t } = useTranslation('kettuImport')
  const projects = scan ? scan.projects.filter((p) => p.sessions > 0).length : 0
  const parts = [
    t('sessions', { count: scan?.counts.sessions ?? 0 }),
    t('projects', { count: projects }),
  ]
  if (scan && scan.memory.found > 0) parts.push(t('memory', { count: scan.memory.found }))
  if (scan && scan.artifacts.found > 0) parts.push(t('artifacts', { count: scan.artifacts.found }))
  return { found: parts.join(' · ') }
}

/** What can still come over beside the sessions, as "31 memory entries, 3 artifacts"; empty when nothing. */
export function useNewExtrasText(scan: KettuImportScan | null): string {
  const { t } = useTranslation('kettuImport')
  if (!scan) return ''
  const parts: string[] = []
  if (scan.memory.importable > 0) parts.push(t('memory', { count: scan.memory.importable }))
  if (scan.artifacts.importable > 0) {
    parts.push(t('artifacts', { count: scan.artifacts.importable }))
  }
  return parts.join(t('separator'))
}
