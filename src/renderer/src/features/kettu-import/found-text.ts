// Huli: what was found in Kettu, in words. Huli's own; see tools/huli/README.md.

import { useTranslation } from 'react-i18next'
import type { KettuImportScan } from '@shared/kettu-import'

/** The sessions and projects counted, as "43 sessions" and "2 projects". */
export function useFoundText(scan: KettuImportScan | null): {
  sessions: string
  projects: string
} {
  const { t } = useTranslation('kettuImport')
  const projects = scan ? scan.projects.filter((p) => p.sessions > 0).length : 0
  return {
    sessions: t('sessions', { count: scan?.counts.sessions ?? 0 }),
    projects: t('projects', { count: projects }),
  }
}
