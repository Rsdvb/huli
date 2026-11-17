// Huli: Settings > General's row for an import from Kettu. Huli's own; see tools/huli/README.md.

import { useTranslation } from 'react-i18next'
import type { GroupDef, RowDef } from '@renderer/features/settings/model'
import { i18n } from '@renderer/lib/i18n'
import { KettuImportButton, KettuImportStatus } from './kettu-import-entry'

/** The row: what was found in Kettu, and the button to choose from it. */
export function useKettuImportRow(): RowDef {
  const { t } = useTranslation('kettuImport')
  const en = i18n.getFixedT('en', 'kettuImport')
  const group: GroupDef = { id: 'kettu-import', label: t('row.group') }
  return {
    id: 'kettu-import',
    name: t('row.name'),
    english: en('row.name'),
    description: t('row.description'),
    keywords: t('row.keywords'),
    rich: <KettuImportStatus />,
    group,
    render: () => <KettuImportButton />,
  }
}
