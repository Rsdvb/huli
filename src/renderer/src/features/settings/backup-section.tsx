// Huli: Settings › Backup, this computer's: the daily backup of Kettu's data folder, when it runs,
// how many are kept, where they go, and restoring one; its controls are in backup-rows.tsx. See
// tools/huli/README.md.

import { DatabaseRestoreIcon } from '@hugeicons/core-free-icons'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import type { BackupStatus } from '@shared/backup'
import { backTime, mediumAgo, storageBytes } from '@renderer/lib/format'
import { useBackupStore, useFollowBackup } from '@renderer/stores/backup'
import {
  BackupNotices,
  EnabledSwitch,
  FolderRow,
  KeepSelect,
  RestoreControl,
  StatusControl,
  TimeField,
} from './backup-rows'
import type { GroupDef, RowDef, SectionDef } from './model'
import { GroupNote } from './rows'

function group(id: string, label: string, extra?: Omit<GroupDef, 'id' | 'label'>): GroupDef {
  return { id, label, ...extra }
}

/** The last backup and the next, in a line. */
function statusLine(status: BackupStatus | null, t: TFunction<'settings'>): string {
  if (!status) return ''
  const parts = [
    status.last
      ? t('backup.status.done', {
          when: mediumAgo(status.last.at),
          size: storageBytes(status.last.bytes),
          count: status.last.files,
        })
      : t('backup.status.never'),
    status.next !== null
      ? t('backup.status.next', { when: backTime(status.next) })
      : t('backup.status.off'),
  ]
  return parts.join(' · ')
}

export function useBackupSection(): SectionDef {
  const { t } = useTranslation('settings')
  useFollowBackup()
  const status = useBackupStore((s) => s.status)
  const stored = status?.stored
  const schedule = group('schedule', t('backup.groups.schedule'), { note: <BackupNotices /> })
  const where = group('folder', t('backup.groups.folder'), {
    note: <GroupNote>{t('backup.note')}</GroupNote>,
  })
  const restore = group('restore', t('backup.groups.restore'))
  const rows: RowDef[] = [
    {
      id: 'enabled',
      setting: 'backup.enabled',
      group: schedule,
      render: () => <EnabledSwitch label={t('backup.enabled.name')} />,
    },
    {
      id: 'time',
      setting: 'backup.time',
      group: schedule,
      render: () => <TimeField label={t('backup.time.name')} />,
    },
    {
      id: 'keep',
      setting: 'backup.keep',
      group: schedule,
      render: () => <KeepSelect label={t('backup.keep.name')} />,
    },
    {
      id: 'status',
      setting: 'backup.status',
      description: statusLine(status, t),
      group: schedule,
      render: () => <StatusControl />,
    },
    {
      id: 'folder',
      setting: 'backup.folder',
      description: stored
        ? t('backup.folder.stored', { count: stored.count, size: storageBytes(stored.bytes) })
        : t('backup.folder.description'),
      group: where,
      layout: 'block',
      render: (text) => <FolderRow text={text} />,
    },
    {
      id: 'restore',
      setting: 'backup.restore',
      group: restore,
      render: () => <RestoreControl />,
    },
  ]
  return {
    id: 'backup',
    title: t('sections.backup'),
    description: t('pages.backup'),
    icon: DatabaseRestoreIcon,
    rows,
  }
}
