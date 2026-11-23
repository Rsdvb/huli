// Huli: the recycle bin (回收站) on the phone: a delete's notice with 撤销, which restores what went
// in by the keys the phone knows from what it deleted, on that computer. A computer whose Kite is
// older than the bin deletes for good, so it gets the old words and no notice.

import { useEffect, useState } from 'react'
import { Alert } from 'react-native'
import { binKey, binSupported, MAX_BIN_KEYS, type BinKind } from '@shared/recycle-bin'
import type { HostLink } from '@shared/remote/link'
import { admin } from './admin'
import { call } from './git'
import { errorText } from './sessions'
import { showNotice } from './ui/NoticeBar'

/** How long 撤销 is offered, as archive's is. */
const UNDO_MS = 5000

/** The computers known to have the bin; one that has not said so is asked again, as it may update. */
const withBin = new WeakSet<HostLink>()

/** Whether the computer behind `link` has the recycle bin, as its `host.info` says. */
export async function linkHasBin(link: HostLink | null): Promise<boolean> {
  if (!link) return false
  if (withBin.has(link)) return true
  const has = await admin(link, 'host.info').then(
    (info) => binSupported(info) === true,
    () => false,
  )
  if (has) withBin.add(link)
  return has
}

/** `linkHasBin` for a screen: null until the computer has said. */
export function useLinkHasBin(link: HostLink | null): boolean | null {
  const [has, setHas] = useState<{ link: HostLink | null; on: boolean } | null>(null)
  useEffect(() => {
    let live = true
    void linkHasBin(link).then((on) => live && setHas({ link, on }))
    return () => {
      live = false
    }
  }, [link])
  return has && has.link === link ? has.on : null
}

/** Puts these back from the bin of `link`'s computer, as many requests as it takes. */
export async function restoreFromBin(link: HostLink, keys: readonly string[]): Promise<number> {
  let held = 0
  for (let at = 0; at < keys.length; at += MAX_BIN_KEYS) {
    const result = await call(link, 'bin.restore', { keys: keys.slice(at, at + MAX_BIN_KEYS) })
    held += result.held.length
  }
  return held
}

/**
 * 「已移到回收站」 with 撤销 for five seconds, once the computer says it has the bin; `fallback`
 * otherwise, the words a delete for good had, or nothing.
 */
export function binnedNotice(
  text: string,
  link: HostLink | null,
  keys: readonly string[],
  fallback?: string,
): void {
  void linkHasBin(link).then((has) => {
    if (has && link && keys.length > 0) undoNotice(text, link, keys)
    else if (fallback) showNotice({ text: fallback })
  })
}

function undoNotice(text: string, link: HostLink, keys: readonly string[]): void {
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
