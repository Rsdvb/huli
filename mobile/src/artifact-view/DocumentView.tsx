// A document artifact, natively: its Markdown as the phone shows replies, at a reading width, with
// the pictures under `images/` from the version's own files. The desktop's viewer
// (src/renderer/src/viewers/document) shows the same text; editing stays on the computer.

import { useMemo } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { CONTENT_ENTRIES } from '@shared/artifact-types'
import { Markdown } from '../components/Markdown'
import { useSessionTokens } from '../ui/session/palette'
import { dataUrl, textOf } from './bytes'
import type { LoadedVersion } from './content'
import { confirmLink } from './external'

/** The artifact path a picture names, as `imagePathOf` in @shared/artifact-document reads it. */
function imagePathOf(target: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/') || target.startsWith('#')) {
    return null
  }
  let path = target.split(/[?#]/, 1)[0]!
  try {
    path = decodeURIComponent(path)
  } catch {
    return null
  }
  while (path.startsWith('./')) path = path.slice(2)
  return path === '' || path.split('/').some((segment) => segment === '..') ? null : path
}

export function DocumentView(props: { version: LoadedVersion; top: number; bottom: number }) {
  const { c } = useSessionTokens()
  const { version } = props
  const text = useMemo(() => {
    const file = version.files.get(CONTENT_ENTRIES.document)
    return file ? textOf(file.bytes) : null
  }, [version])

  const image = useMemo(() => {
    const made = new Map<string, string>()
    return (href: string): string | null => {
      const path = imagePathOf(href)
      const file = path ? version.files.get(path) : undefined
      if (!file || !file.type.startsWith('image/')) return null
      let url = made.get(file.path)
      if (url === undefined) {
        url = dataUrl(file.type, file.bytes)
        made.set(file.path, url)
      }
      return url
    }
  }, [version])

  if (text === null) {
    return (
      <View style={[styles.center, { paddingTop: props.top }]}>
        <Text style={[styles.note, { color: c.textSecondary }]}>这份文档没有内容。</Text>
      </View>
    )
  }
  return (
    <ScrollView
      contentContainerStyle={{ paddingTop: props.top + 12, paddingBottom: props.bottom + 32 }}
      contentInsetAdjustmentBehavior="never"
      scrollIndicatorInsets={{ top: props.top }}
    >
      <View style={styles.article}>
        <Markdown markdown={text} image={image} onLink={confirmLink} />
      </View>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  article: { paddingHorizontal: 20, maxWidth: 720, width: '100%', alignSelf: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  note: { fontSize: 15 },
})
