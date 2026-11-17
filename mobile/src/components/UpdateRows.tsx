// Settings › About on Android: the newest build, its download, and checking by hand. Returned as
// rows so the group draws its separators between them.

import { useState, type ReactElement } from 'react'
import { haptic } from '../ui/haptics'
import { ListRow } from '../ui/ListRow'
import { checkForUpdate, openUpdate, useUpdate } from '../update'

type Check = 'idle' | 'checking' | 'latest' | 'available' | 'failed'

const CHECK_TEXT: Record<Check, string> = {
  idle: '',
  checking: '正在检查…',
  latest: '已是最新',
  available: '有新版本',
  failed: '检查失败',
}

export function useUpdateRows(): ReactElement[] {
  const { latest } = useUpdate()
  const [check, setCheck] = useState<Check>('idle')

  const checkNow = () => {
    haptic.tap()
    setCheck('checking')
    checkForUpdate().then(
      (release) => setCheck(release ? 'available' : 'latest'),
      () => setCheck('failed'),
    )
  }

  return [
    ...(latest
      ? [
          <ListRow key="latest" title="最新版本" value={latest.version} />,
          <ListRow
            key="download"
            title="下载新版本"
            icon="download"
            action
            onPress={() => openUpdate(latest)}
          />,
        ]
      : []),
    <ListRow
      key="check"
      title="检查更新"
      icon="refresh"
      action
      value={CHECK_TEXT[check] || undefined}
      disabled={check === 'checking'}
      onPress={checkNow}
    />,
  ]
}
