// The composer's add menu: a photo, the camera, a file or the clipboard's picture, each off once
// the message holds as many attachments as it may; a file of the project to mention, as the
// desktop's `@` does (its name in the text, the file attached); and the agent's slash commands,
// one of which goes at the start of the message, listed only when the agent reports some.

import { useEffect, useState, type RefObject } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import type { HostLink } from '@shared/remote/link'
import type { SlashCommand } from '@shared/thread'
import { ATTACHMENT_LIMIT } from '../attachments'
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
  /** The attachments the box holds, against the limit of one message. */
  count: number
}): AttachPages {
  const { c } = useSessionTokens()
  const [query, setQuery] = useState('')
  const files = useProjectFiles(props.link, props.folder, props.mentioning)
  // A menu closed without a pick opens again on the whole list, not on the last search.
  useEffect(() => {
    if (!props.mentioning) setQuery('')
  }, [props.mentioning])
  const commandNames = props.commands.map((command) => command.name)
  const full = props.count >= ATTACHMENT_LIMIT
  const limit = full ? { subtitle: `最多 ${ATTACHMENT_LIMIT} 个附件`, disabled: true } : {}

  const attach: MenuPage = {
    entries: [
      {
        key: 'photos',
        label: '照片',
        icon: G.photo,
        ...limit,
        onPress: () => props.composer.current?.pickPhotos(),
      },
      {
        key: 'camera',
        label: '拍照',
        icon: G.camera,
        ...limit,
        onPress: () => props.composer.current?.takePhoto(),
      },
      {
        key: 'files',
        label: '选择文件',
        icon: G.folderOpen,
        ...limit,
        onPress: () => props.composer.current?.pickFiles(),
      },
      {
        key: 'paste',
        label: '粘贴图片',
        icon: G.paste,
        ...limit,
        onPress: () => props.composer.current?.pasteImage(),
      },
      { kind: 'divider', key: 'rule' },
      {
        key: 'mention',
        label: '提及文件',
        icon: G.mention,
        disabled: !props.folder || full,
        ...(full
          ? { subtitle: `最多 ${ATTACHMENT_LIMIT} 个附件` }
          : props.folder
            ? { page: 'mention' }
            : { subtitle: '选择一个项目后才能提及其中的文件' }),
      },
      // An agent that reports no commands gets no row for them.
      ...(props.commands.length > 0
        ? [{ key: 'slash', label: '命令', icon: G.slash, page: 'slash' }]
        : []),
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
    title: '命令',
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
