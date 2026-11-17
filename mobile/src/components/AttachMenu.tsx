// The composer's add menu: a photo, the camera or a file; a file of the project to mention, as the
// desktop's `@` does (its name in the text, the file attached); and the agent's slash commands,
// one of which goes at the start of the message.

import { useState, type RefObject } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import type { HostLink } from '@shared/remote/link'
import type { SlashCommand } from '@shared/thread'
import { matchFiles, useProjectFiles } from '../files'
import { FileMark, G, Icon, TOOL_ICONS } from '../ui/session/icons'
import { useSessionTokens } from '../ui/session/palette'
import type { MenuEntry, MenuPage } from '../ui/session/Popover'
import type { ComposerHandle } from './Composer'

export interface AttachPages {
  attach: MenuPage
  mention: MenuPage
  slash: MenuPage
}

export function useAttachPages(props: {
  link: HostLink
  /** The folder the session works in; null without a project, where nothing can be mentioned. */
  folder: string | null
  /** Whether the menu is open on its mention page, which reads the project's files. */
  mentioning: boolean
  composer: RefObject<ComposerHandle | null>
  commands: readonly SlashCommand[]
  /** Files of the folder the session's tools read or edited, newest first. */
  touched: readonly string[]
}): AttachPages {
  const { c } = useSessionTokens()
  const [query, setQuery] = useState('')
  const files = useProjectFiles(props.link, props.folder, props.mentioning)
  const commandNames = props.commands.map((command) => command.name)

  const attach: MenuPage = {
    entries: [
      {
        key: 'photos',
        label: '照片',
        icon: G.photo,
        onPress: () => props.composer.current?.pickPhotos(),
      },
      {
        key: 'camera',
        label: '拍照',
        icon: G.camera,
        onPress: () => props.composer.current?.takePhoto(),
      },
      {
        key: 'files',
        label: '选择文件',
        icon: G.folderOpen,
        onPress: () => props.composer.current?.pickFiles(),
      },
      { kind: 'divider', key: 'rule' },
      {
        key: 'mention',
        label: '提及文件',
        icon: G.mention,
        disabled: !props.folder,
        ...(props.folder ? { page: 'mention' } : { subtitle: '这个会话没有项目' }),
      },
      {
        key: 'slash',
        label: '斜杠命令',
        icon: G.slash,
        disabled: props.commands.length === 0,
        ...(props.commands.length > 0
          ? { page: 'slash' }
          : { subtitle: '这个 Agent 没有报告命令' }),
      },
    ],
  }

  const paths = files.list?.paths ?? []
  const found = query.trim()
    ? matchFiles(paths, query)
    : props.touched.length > 0
      ? props.touched.slice(0, 12)
      : [...paths].sort((a, b) => a.split('/').length - b.split('/').length).slice(0, 30)
  const search: MenuEntry = {
    kind: 'custom',
    key: 'search',
    node: (
      <View style={[styles.search, { backgroundColor: c.fill }]}>
        <Icon icon={TOOL_ICONS.search} size={14} color={c.textTertiary} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="搜索文件"
          placeholderTextColor={c.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          accessibilityLabel="搜索项目里的文件"
          style={[styles.input, { color: c.text }]}
        />
      </View>
    ),
  }
  const mention: MenuPage = {
    title: '提及文件',
    loading: !files.list && !files.error,
    error: files.error,
    onRetry: files.reload,
    entries: files.list
      ? [
          search,
          ...found.map((path): MenuEntry => ({
            key: path,
            label: path.slice(path.lastIndexOf('/') + 1),
            subtitle: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : undefined,
            lead: <FileMark path={path} size={16} />,
            onPress: () => {
              if (props.folder) props.composer.current?.mention(props.folder, path)
              setQuery('')
            },
          })),
        ]
      : [],
    ...(files.list && found.length === 0
      ? { footer: query.trim() ? '没有匹配的文件' : '项目里没有文件' }
      : files.list?.truncated
        ? { footer: '项目文件太多，只搜索了前五万个' }
        : {}),
  }

  const slash: MenuPage = {
    title: '斜杠命令',
    entries: props.commands.map((command) => ({
      key: command.name,
      label: `/${command.name}`,
      ...(command.description || command.inputHint
        ? { subtitle: command.description || command.inputHint }
        : {}),
      onPress: () => props.composer.current?.command(command.name, commandNames),
    })),
    empty: '这个 Agent 没有报告命令',
  }

  return { attach, mention, slash }
}

const styles = StyleSheet.create({
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    paddingHorizontal: 10,
    marginHorizontal: 4,
    marginBottom: 4,
    height: 38,
  },
  input: { flex: 1, fontSize: 15, paddingVertical: 0 },
})
