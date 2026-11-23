// A project's page: where it is, the further folders its sessions also work in, how its sessions'
// worktrees are named and prepared, and removing it from Huli, which leaves its folder where it is.

import { binnedOne, useLinkHasBin } from '../../recycleBin'
import { useEffect, useState } from 'react'
import { Alert, StyleSheet, Switch, Text, View } from 'react-native'
import { router, useLocalSearchParams, usePreventRemove } from 'expo-router'
import type { FolderSuggestion, Project } from '@shared/agent-host'
import { DEFAULT_BRANCH_TEMPLATE, type ProjectWorktreeSettings } from '@shared/git'
import { useHost } from '../../host'
import { FolderPathSheet } from '../../manage/FolderPathSheet'
import {
  Button,
  call,
  confirm,
  errorText,
  Field,
  FieldLabel,
  FieldNote,
  homeShort,
  ManagePage,
  Notice,
  ReadState,
  Tag,
  useActions,
  useConnected,
  useRead,
} from '../../manage/kit'
import { EmptyState } from '../../ui/EmptyState'
import { haptic } from '../../ui/haptics'
import { ListGroup, ListRow } from '../../ui/ListRow'
import { radius, space, type as typeScale, useTokens } from '../../ui/tokens'

type FieldName = 'branch' | 'copy' | 'setup'

/** Which field the host's `invalid_params` message is about, by the name it starts with. */
function fieldOf(message: string): FieldName | null {
  if (message.startsWith('copy')) return 'copy'
  if (message.startsWith('setup')) return 'setup'
  if (message.startsWith('branch') || /branch|ref/i.test(message)) return 'branch'
  return null
}

const FORBIDDEN = '只有这台主机的主人能在这里改这些设置，除非主人允许已配对的设备使用终端。'

export default function ProjectPage() {
  const { c } = useTokens()
  const host = useHost()
  // Huli: a computer whose Kite is older than the recycle bin deletes for good, as it says.
  const binOn = useLinkHasBin(host.link) === true
  const connected = useConnected()
  const { path = '' } = useLocalSearchParams<{ path?: string }>()
  const project = host.projects.find((p) => p.path === path) ?? null
  const read = useRead<ProjectWorktreeSettings>(project ? `worktree\n${path}` : null, (link) =>
    call(link, 'projects.worktreeSettings', { path }),
  )
  const actions = useActions()
  const [template, setTemplate] = useState('')
  const [copy, setCopy] = useState('')
  const [setup, setSetup] = useState('')
  const [wait, setWait] = useState(true)
  const [error, setError] = useState<{ field: FieldName | null; message: string } | null>(null)
  const [saved, setSaved] = useState(false)
  const [addingFolder, setAddingFolder] = useState(false)
  const loaded = read.value

  useEffect(() => {
    if (!loaded) return
    setTemplate(loaded.branchTemplate)
    setCopy(loaded.copy.join('\n'))
    setSetup(loaded.setup ?? '')
    setWait(loaded.waitForSetup)
  }, [loaded])

  const sessions = [...host.sessions.values()].filter((s) => s.projectPath === path)
  const running = sessions.filter(
    (s) => s.status === 'running' || s.status === 'awaiting_permission',
  ).length

  const draft = (): ProjectWorktreeSettings => ({
    branchTemplate: template.trim() || DEFAULT_BRANCH_TEMPLATE,
    copy: [
      ...new Set(
        copy
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
      ),
    ],
    setup: setup.trim() === '' ? null : setup.trim(),
    waitForSetup: wait,
  })
  const changed =
    loaded !== null &&
    (() => {
      const next = draft()
      return (
        next.branchTemplate !== loaded.branchTemplate ||
        next.setup !== loaded.setup ||
        next.waitForSetup !== loaded.waitForSetup ||
        next.copy.join('\n') !== loaded.copy.join('\n')
      )
    })()

  // Leaving with changes not saved asks first, as a swipe back would drop them unseen.
  const [leaving, setLeaving] = useState(false)
  const allowLeaving = usePreventRemove(changed && !leaving, ({ repeat }) => {
    haptic.warning()
    Alert.alert('放弃没有保存的更改？', '这个项目的工作树设置改了还没保存。', [
      { text: '继续编辑', style: 'cancel' },
      {
        text: '放弃更改',
        style: 'destructive',
        onPress: () => {
          setLeaving(true)
          repeat()
        },
      },
    ])
  })

  const save = async () => {
    if (!host.link || !loaded) return
    setError(null)
    setSaved(false)
    const settings = draft()
    await actions.run(
      'save',
      async () => {
        try {
          await call(host.link!, 'projects.setWorktreeSettings', { path, settings })
          read.set(() => settings)
          setSaved(true)
        } catch (failure) {
          const code = (failure as { code?: unknown } | null)?.code
          const message = errorText(failure)
          setError(
            code === 'forbidden'
              ? { field: null, message: FORBIDDEN }
              : code === 'invalid_params'
                ? { field: fieldOf(message), message }
                : { field: null, message },
          )
          throw failure
        }
      },
      '没能保存',
    )
  }

  const remove = async () => {
    if (!project || !host.link) return
    const parts = [
      binOn
        ? sessions.length > 0
          ? `它和它的 ${sessions.length} 个会话会移到回收站，可以在 设置 › 回收站 里恢复。`
          : '它会移到回收站，可以在 设置 › 回收站 里恢复。'
        : sessions.length > 0
          ? `它的 ${sessions.length} 个会话会从纸鸢里去掉。`
          : '它在纸鸢里没有会话。',
      running > 0 ? `正在运行的 ${running} 个会先停下。` : null,
      '文件夹和里面的文件会留在电脑上。',
    ]
    const ok = await confirm({
      title: `移除 ${project.name}？`,
      message: parts.filter(Boolean).join(''),
      confirm: '移除',
    })
    if (!ok) return
    const done = await actions.run(
      'remove',
      () => call(host.link!, 'projects.remove', { path }),
      '没能移除项目',
    )
    if (done) {
      // Huli: it waits in the recycle bin with its sessions; 撤销 puts them back.
      binnedOne(host.link, 'project', path, project.name)
      void host.refresh().catch(() => {})
      // The project is gone; its unsaved settings with it.
      setLeaving(true)
      allowLeaving()
      router.back()
    }
  }

  const fieldError = (field: FieldName) =>
    error?.field === field ? <FieldNote error>{error.message}</FieldNote> : null
  const disabled = !connected || loaded === null || actions.busy('save')

  if (!project) {
    return (
      <ManagePage title="项目" onRefresh={() => host.refresh()}>
        {host.loaded ? (
          <EmptyState icon="folder" title="找不到这个项目" message="它可能已经从纸鸢里移除。" />
        ) : (
          <EmptyState icon="folder" title="连上电脑后才能看项目" />
        )}
      </ManagePage>
    )
  }

  return (
    <ManagePage
      title={project.name}
      onRefresh={() => Promise.all([read.reload(), host.refresh()])}
      overlay={
        <FolderPathSheet
          visible={addingFolder}
          onClose={() => setAddingFolder(false)}
          title="添加文件夹"
          message="输入电脑上一个文件夹的路径。这个项目里的会话也会在其中读取和修改文件。"
          submitLabel="添加"
          onChosen={async (chosen) => {
            if (!host.link) throw new Error('电脑没有连上。')
            await call(host.link, 'projects.addFolder', { path: project.path, folder: chosen })
            void host.refresh().catch(() => {})
          }}
        />
      }
    >
      <ListGroup>
        <ListRow title="路径" icon="folder" plainIcon subtitle={project.path} />
        <ListRow
          title="会话"
          icon="message"
          plainIcon
          value={sessions.length > 0 ? `${sessions.length} 个` : '没有'}
        />
      </ListGroup>
      {project.missing ? (
        <Notice tone="warning" title="未找到">
          电脑上已经没有这个文件夹了。
        </Notice>
      ) : null}

      {project.folders !== undefined && !project.missing ? (
        <ProjectFolders project={project} onAdd={() => setAddingFolder(true)} />
      ) : null}

      <View style={styles.section}>
        <Text style={[typeScale.headline, styles.header, { color: c.textSecondary }]}>
          工作树设置
        </Text>
        <Text style={[typeScale.footnote, styles.header, { color: c.textTertiary }]}>
          纸鸢怎样为这个项目的新会话命名和准备工作树。
        </Text>
        {loaded === null ? (
          <ReadState read={read} what="工作树设置" icon="sliders" rows={3} />
        ) : (
          <View style={[styles.form, { backgroundColor: c.surface, borderColor: c.border }]}>
            <FieldLabel>分支名</FieldLabel>
            <Field
              value={template}
              onChangeText={setTemplate}
              mono
              editable={!disabled}
              placeholder={DEFAULT_BRANCH_TEMPLATE}
              accessibilityLabel="分支名"
            />
            <FieldNote>
              {`{slug} 取自第一条消息开头的几个词，{type} 是改动的类型，{issue} 是 issue 号。默认是 ${DEFAULT_BRANCH_TEMPLATE}。`}
            </FieldNote>
            {fieldError('branch')}

            <FieldLabel>要复制的文件</FieldLabel>
            <Field
              value={copy}
              onChangeText={setCopy}
              mono
              multiline
              editable={!disabled}
              placeholder=".env"
              accessibilityLabel="要复制的文件"
            />
            <FieldNote>
              相对项目的路径，一行一个，会复制到每个新工作树。项目里的 .worktreeinclude 也会读取。
            </FieldNote>
            {fieldError('copy')}

            <FieldLabel>初始化命令</FieldLabel>
            <Field
              value={setup}
              onChangeText={setSetup}
              mono
              multiline
              editable={!disabled}
              placeholder="pnpm install"
              accessibilityLabel="初始化命令"
            />
            <FieldNote>在每个新工作树里运行，比如安装依赖。留空表示不运行。</FieldNote>
            {fieldError('setup')}

            <View style={styles.waitRow}>
              <View style={styles.flex}>
                <Text style={[typeScale.body, { color: c.text }]}>第一条消息等准备完成</Text>
                <Text style={[typeScale.footnote, { color: c.textTertiary }]}>
                  复制完文件、跑完命令后，Agent 才开始工作。
                </Text>
              </View>
              <Switch
                value={wait}
                disabled={disabled}
                onValueChange={(on) => {
                  haptic.select()
                  setWait(on)
                }}
                trackColor={{ true: c.success }}
                accessibilityLabel="第一条消息等准备完成"
              />
            </View>
            {error !== null && error.field === null ? (
              <FieldNote error>{error.message}</FieldNote>
            ) : saved && !changed ? (
              <FieldNote>已保存</FieldNote>
            ) : null}
            <Button
              label="保存"
              tone="primary"
              busy={actions.busy('save')}
              disabled={disabled || !changed}
              onPress={() => void save()}
            />
          </View>
        )}
      </View>

      <ListGroup footer="文件夹和里面的文件会留在电脑上。">
        <ListRow
          title="移除项目…"
          icon="trash"
          plainIcon
          iconTint={c.danger}
          destructive
          disabled={!connected || actions.busy('remove')}
          onPress={() => void remove()}
        />
      </ListGroup>
    </ManagePage>
  )
}

/**
 * Huli: the further folders the project's sessions also work in, such as a backend beside a
 * frontend: each taken out on its own, one added by its path, and the repositories and workspace
 * folders the computer found in the project to add.
 */
function ProjectFolders({ project, onAdd }: { project: Project; onAdd(): void }) {
  const { c } = useTokens()
  const host = useHost()
  const connected = useConnected()
  const actions = useActions()
  const folders = project.folders ?? []
  const listed = folders.map((folder) => folder.path).join('\n')
  const found = useRead<FolderSuggestion[]>(`folders\n${project.path}\n${listed}`, (link) =>
    call(link, 'projects.suggestFolders', { path: project.path }),
  )

  const add = (folder: string) =>
    actions.run(
      `add\n${folder}`,
      async () => {
        if (!host.link) throw new Error('电脑没有连上。')
        await call(host.link, 'projects.addFolder', { path: project.path, folder })
        await host.refresh().catch(() => {})
      },
      '没能添加文件夹',
    )
  const remove = async (folder: { path: string; name: string }) => {
    const ok = await confirm({
      title: `把 ${folder.name} 移出项目？`,
      message: '文件夹和里面的文件会留在电脑上。已打开的会话在 Agent 下次启动时不再用它。',
      confirm: '移出',
    })
    if (!ok) return
    await actions.run(
      `remove\n${folder.path}`,
      async () => {
        if (!host.link) throw new Error('电脑没有连上。')
        await call(host.link, 'projects.removeFolder', { path: project.path, folder: folder.path })
        await host.refresh().catch(() => {})
      },
      '没能移出文件夹',
    )
  }
  const offered = found.value ?? []

  return (
    <>
      <ListGroup
        header="文件夹"
        footer={
          folders.length > 0
            ? '这个项目里的会话也能读取和修改这些文件夹。已打开的会话在 Agent 下次启动时生效。项目有多个文件夹时不能用工作树。'
            : '添加这个项目的会话也要用到的文件夹，比如前端旁边的后端仓库。'
        }
      >
        {folders.map((folder) => (
          <ListRow
            key={folder.path}
            title={folder.name}
            subtitle={homeShort(folder.path)}
            icon="folder"
            plainIcon
            trailing={folder.missing ? <Tag label="未找到" tone="warning" /> : undefined}
            disabled={!connected || actions.busy(`remove\n${folder.path}`)}
            onPress={() => void remove(folder)}
          />
        ))}
        <ListRow
          title="添加文件夹"
          icon="folderPlus"
          plainIcon
          action
          disabled={!connected}
          onPress={onAdd}
        />
      </ListGroup>
      {offered.length > 0 ? (
        <ListGroup
          header="在项目里找到"
          footer="项目文件夹里的 Git 仓库，以及 .code-workspace 文件列出的文件夹。轻点添加。"
        >
          {offered.map((item) => (
            <ListRow
              key={item.path}
              title={item.name}
              subtitle={homeShort(item.path)}
              icon="folderPlus"
              plainIcon
              iconTint={c.textSecondary}
              trailing={<Tag label={item.source === 'workspace' ? '工作区' : 'Git'} />}
              disabled={!connected || actions.busy(`add\n${item.path}`)}
              onPress={() => void add(item.path)}
            />
          ))}
        </ListGroup>
      ) : null}
    </>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  section: { gap: space.sm },
  header: { marginHorizontal: space.lg },
  form: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.lg,
    gap: space.sm,
  },
  waitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginTop: space.sm,
  },
})
