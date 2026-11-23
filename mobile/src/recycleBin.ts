// Huli: the recycle bin (回收站) on the phone: a delete's notice with 撤销, which restores what went
// in by the keys the phone knows from what it deleted, on that computer.

import { Alert } from 'react-native'
import { binKey, MAX_BIN_KEYS, type BinKind } from '@shared/recycle-bin'
import type { HostLink } from '@shared/remote/link'
import { call } from './git'
import { errorText } from './sessions'
import { showNotice } from './ui/NoticeBar'

/** How long 撤销 is offered, as archive's is. */
const UNDO_MS = 5000

/** Puts these back from the bin of `link`'s computer, as many requests as it takes. */
export async function restoreFromBin(link: HostLink, keys: readonly string[]): Promise<number> {
  let held = 0
  for (let at = 0; at < keys.length; at += MAX_BIN_KEYS) {
    const result = await call(link, 'bin.restore', { keys: keys.slice(at, at + MAX_BIN_KEYS) })
    held += result.held.length
  }
  return held
}

/** 「已移到回收站」 with 撤销 for five seconds. */
export function binnedNotice(text: string, link: HostLink | null, keys: readonly string[]): void {
  if (!link || keys.length === 0) {
    showNotice({ text })
    return
  }
  showNotice({
    text,
    ms: UNDO_MS,
    action: {
      label: '撤销',
      onPress: () =>
        void restoreFromBin(link, keys).then(
          (held) => {
            if (held > 0)
              Alert.alert('没能直接恢复', '它的项目已不在了，请到 设置 › 回收站 里恢复。')
          },
          (error: unknown) => Alert.alert('没能恢复', errorText(error)),
        ),
    },
  })
}

/** The notice for one thing of `kind` named `title`. */
export function binnedOne(link: HostLink | null, kind: BinKind, id: string, title: string): void {
  binnedNotice(`“${title}”已移到回收站`, link, [binKey(kind, id)])
}
