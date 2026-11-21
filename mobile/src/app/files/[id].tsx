// The files of the folder a session works in, read-only: one folder at a time, its folders first,
// with a search over the whole project; a file opens in a plain viewer, or a document in the
// system's viewer, and a long press hands one to another app.

import { useDeferredValue, useMemo, useState, type ReactElement } from 'react'
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { Stack, router, useLocalSearchParams } from 'expo-router'
import { matchFiles, useProjectFiles } from '../../files'
import { opensInViewer } from '../../preview/kinds'
import { previewFile } from '../../preview/preview'
import { SHARE_LABEL } from '../../preview/PreviewSheet'
import { ContextMenu } from '../../ui/ContextMenu'
import type { MenuNode } from '../../ui/menu'
import { openFile } from '../../ui/session/fileRefs'
import { sessionFolder } from '../../git'
import { useLink, useSession } from '../../host'
import { baseName } from '../../ui/session/format'
import { GlassHeader } from '../../ui/session/GlassHeader'
import { FileMark, G, Icon, TOOL_ICONS } from '../../ui/session/icons'
import { useSessionTokens } from '../../ui/session/palette'
import { StateView } from '../../ui/session/StateView'
import { useNextChange, usePullRefresh } from '../../ui/PullRefresh'

interface Item {
  path: string
  folder: boolean
  /** For a search's match: the folder it is in. */
  where?: string
}

/** What lies directly in `dir`: its folders, then its files, each by name. */
function listing(paths: readonly string[], folders: readonly string[], dir: string): Item[] {
  const prefix = dir ? `${dir}/` : ''
  const subfolders = new Set<string>()
  const files: Item[] = []
  for (const path of [...paths, ...folders.map((f) => `${f}/`)]) {
    if (!path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    const slash = rest.indexOf('/')
    if (slash >= 0) subfolders.add(`${prefix}${rest.slice(0, slash)}`)
    else if (rest) files.push({ path, folder: false })
  }
  const byName = (a: Item, b: Item) =>
    baseName(a.path).localeCompare(baseName(b.path), undefined, { sensitivity: 'base' })
  return [
    ...[...subfolders].map((path) => ({ path, folder: true })).sort(byName),
    ...files.sort(byName),
  ]
}

export default function FilesScreen() {
  const { id, dir = '' } = useLocalSearchParams<{ id: string; dir?: string }>()
  const { c, s } = useSessionTokens()
  const link = useLink()
  const summary = useSession(id)
  // A session started with no project has a folder of its own, where its files are.
  const folder = summary ? sessionFolder(summary) : null
  const files = useProjectFiles(link, folder, true)
  const [query, setQuery] = useState('')
  const read = useNextChange(files.list ?? files.error)
  const pull = usePullRefresh(() => {
    files.reload()
    return read()
  })

  // A project's paths are lowered once, and the search follows the typing a beat behind, so a long
  // project does not scan every path in lower case on each keystroke before the field updates.
  const lowered = useMemo(() => files.list?.paths.map((p) => p.toLowerCase()) ?? [], [files.list])
  const searched = useDeferredValue(query)
  const items = useMemo((): Item[] => {
    if (!files.list) return []
    if (searched.trim()) {
      return matchFiles(files.list.paths, searched, 200, lowered).map((path) => ({
        path,
        folder: false,
        where: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '',
      }))
    }
    return listing(files.list.paths, files.list.folders, dir)
  }, [files.list, lowered, searched, dir])

  const open = (item: Item) => {
    if (item.folder) router.push({ pathname: '/files/[id]', params: { id, dir: item.path } })
    else openFile(id, item.path)
  }
  const fileMenu = (path: string): MenuNode[] => [
    ...(opensInViewer(path)
      ? []
      : [
          {
            key: 'preview',
            label: '用系统预览打开',
            icon: 'eye' as const,
            onPress: () => previewFile({ sessionId: id, path }),
          },
        ]),
    {
      key: 'share',
      label: SHARE_LABEL,
      icon: 'square.and.arrow.up',
      onPress: () => previewFile({ sessionId: id, path }, 'share'),
    },
  ]

  let body: ReactElement
  if (!summary) {
    body = <StateView loading />
  } else if (!folder) {
    body = <StateView text="这个会话没有项目，没有可看的文件。" icon={G.folder} />
  } else if (!files.list) {
    body = files.error ? (
      <StateView text={files.error} tone="danger" retry={files.reload} />
    ) : (
      <StateView loading />
    )
  } else {
    body = (
      <FlatList
        data={items}
        keyExtractor={(item) => item.path}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        refreshControl={pull}
        ListHeaderComponent={
          <View style={[styles.search, { backgroundColor: c.fill }]}>
            <Icon icon={TOOL_ICONS.search} size={15} color={c.textTertiary} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="搜索整个项目的文件"
              placeholderTextColor={c.textTertiary}
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              accessibilityLabel="搜索文件"
              style={[styles.input, { color: c.text }]}
            />
          </View>
        }
        renderItem={({ item, index }) => (
          <ContextMenu items={item.folder ? [] : fileMenu(item.path)} title={baseName(item.path)}>
            {(longPress) => (
              <Pressable
                onPress={() => open(item)}
                {...(longPress ? { onLongPress: longPress, delayLongPress: 350 } : {})}
                accessibilityRole="button"
                accessibilityLabel={`${item.folder ? '文件夹' : '文件'} ${baseName(item.path)}`}
                style={({ pressed }) => [
                  styles.row,
                  {
                    backgroundColor: pressed ? c.fill : s.dockCard,
                    borderTopLeftRadius: index === 0 ? 16 : 0,
                    borderTopRightRadius: index === 0 ? 16 : 0,
                    borderBottomLeftRadius: index === items.length - 1 ? 16 : 0,
                    borderBottomRightRadius: index === items.length - 1 ? 16 : 0,
                  },
                ]}
              >
                {item.folder ? (
                  <View style={{ width: 21, alignItems: 'center' }}>
                    <Icon icon={G.folder} size={17} color={c.tint} />
                  </View>
                ) : (
                  <FileMark path={item.path} size={17} />
                )}
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[styles.name, { color: c.text }]} numberOfLines={1}>
                    {baseName(item.path)}
                  </Text>
                  {item.where ? (
                    <Text
                      style={[styles.where, { color: c.textTertiary }]}
                      numberOfLines={1}
                      ellipsizeMode="head"
                    >
                      {item.where}
                    </Text>
                  ) : null}
                </View>
                <Icon icon={G.right} size={12} color={c.textTertiary} weight="semibold" />
              </Pressable>
            )}
          </ContextMenu>
        )}
        ItemSeparatorComponent={() => (
          <View style={{ backgroundColor: s.dockCard }}>
            <View style={[styles.separator, { backgroundColor: c.border }]} />
          </View>
        )}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: c.textSecondary }]}>
            {query.trim() ? '没有匹配的文件' : '这个文件夹是空的'}
          </Text>
        }
        ListFooterComponent={
          files.list.truncated ? (
            <Text style={[styles.empty, { color: c.textTertiary }]}>
              项目文件太多，只列出了前五万个。
            </Text>
          ) : undefined
        }
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
      />
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ headerShown: false }} />
      <GlassHeader
        title={dir ? baseName(dir) : '文件'}
        subtitle={folder ? (dir ? `${baseName(folder)}/${dir}` : baseName(folder)) : null}
        subtitlePath
      />
      {body}
    </View>
  )
}

const styles = StyleSheet.create({
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 40,
    marginTop: 4,
    marginBottom: 14,
  },
  input: { flex: 1, fontSize: 16, paddingVertical: 0 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingHorizontal: 14,
    minHeight: 52,
  },
  name: { fontSize: 15, lineHeight: 20, fontWeight: '500' },
  where: { fontSize: 12, lineHeight: 16, marginTop: 1 },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 46 },
  empty: { fontSize: 14, textAlign: 'center', paddingVertical: 32 },
})
