// Huli: Settings > Chat apps (聊天软件), this computer's: each chat platform's bot, its credentials, its
// connection and the accounts bound to it; the controls are in chat-bridge-rows.tsx. See
// tools/huli/README.md (Chat apps).

import { BubbleChatIcon } from '@hugeicons/core-free-icons'
import { useTranslation } from 'react-i18next'
import { CHAT_PLATFORMS } from '@shared/chat-bridge'
import type { SettingId } from '@shared/settings-catalog'
import { useChatBridgeStore, useFollowChatBridge } from '@renderer/stores/chat-bridge'
import { AccountsControl, PlatformRow } from './chat-bridge-rows'
import type { GroupDef, RowDef, SectionDef } from './model'
import { GroupNote } from './rows'

export function useChatBridgeSection(): SectionDef {
  const { t } = useTranslation('settings')
  useFollowChatBridge()
  const loaded = useChatBridgeStore((s) => s.view !== null)
  const unavailable = useChatBridgeStore((s) => s.view?.unavailable ?? null)
  const failed = useChatBridgeStore((s) => s.error)
  const rows: RowDef[] = CHAT_PLATFORMS.flatMap((platform, i): RowDef[] => {
    const name = t(`chatBridge.platforms.${platform}`)
    const group: GroupDef = {
      id: platform,
      label: name,
      note: (
        <>
          {i === 0 && unavailable && <GroupNote>{unavailable}</GroupNote>}
          {i === 0 && failed && <GroupNote>{failed}</GroupNote>}
          <GroupNote>{t(`chatBridge.notes.${platform}`)}</GroupNote>
        </>
      ),
    }
    if (!loaded) return []
    return [
      {
        id: platform,
        setting: `chat-bridge.${platform}` as SettingId,
        group,
        layout: 'custom',
        render: () => <PlatformRow platform={platform} name={t('chatBridge.connection.name')} />,
      },
      {
        id: `${platform}-accounts`,
        setting: `chat-bridge.${platform}-accounts` as SettingId,
        group,
        layout: 'custom',
        render: () => <AccountsControl platform={platform} />,
      },
    ]
  })
  return {
    id: 'chat-bridge',
    title: t('sections.chat-bridge'),
    description: t('pages.chat-bridge'),
    icon: BubbleChatIcon,
    rows,
  }
}
