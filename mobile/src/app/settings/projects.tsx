// Settings › 项目: the computer's projects, each opening its page, and adding one by typing its
// folder on the computer, which the computer completes as it is typed.

import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { router } from 'expo-router'
import type { PathCompletion } from '@shared/remote/host-admin'
import { useHost } from '../../host'
import {
  call,
  errorText,
  Field,
  FieldNote,
  FormSheet,
  homeShort,
  ManagePage,
  Tag,
  useConnected,
} from '../../manage/kit'
import { EmptyState } from '../../ui/EmptyState'
import { haptic } from '../../ui/haptics'
import { Icon } from '../../ui/Icon'
import { ListGroup, ListRow } from '../../ui/ListRow'
import { Press } from '../../ui/Press'
import { SkeletonRows } from '../../ui/Skeleton'
import { radius, space, type as typeScale, useTokens } from '../../ui/tokens'

/** The most entries the list under the field shows; typing more of the name narrows it. */
const MAX_ENTRIES = 60

export default function ProjectsSettings() {
  const host = useHost()
  const connected = useConnected()
  const [adding, setAdding] = useState(false)
  const counts = new Map<string, number>()
  for (const session of host.sessions.values()) {
    if (session.archivedAt !== null) continue
    counts.set(session.projectPath, (counts.get(session.projectPath) ?? 0) + 1)
  }
  const projects = [...host.projects].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)

  return (
    <ManagePage
      title="项目"
      intro="电脑上 Huli 里的项目。移除项目不会动它的文件夹。"
      onRefresh={() => host.refresh()}
      overlay={<AddProjectSheet visible={adding} onClose={() => setAdding(false)} />}
    >
      {!host.loaded ? (
        connected ? (
          <SkeletonRows count={4} avatar={false} />
        ) : (
          <EmptyState icon="folder" title="连上电脑后才能看项目" />
        )
      ) : projects.length === 0 ? (
        <EmptyState
          icon="folder"
          title="还没有项目"
          message="添加电脑上的一个文件夹，就能在里面开始会话。"
          action={connected ? { label: '添加项目', onPress: () => setAdding(true) } : undefined}
        />
      ) : (
        <ListGroup>
          {projects.map((project) => (
            <ListRow
              key={project.path}
              title={project.name}
              subtitle={homeShort(project.path)}
              icon="folder"
              plainIcon
              value={
                !project.missing && counts.get(project.path)
                  ? `${counts.get(project.path)} 个会话`
                  : undefined
              }
              trailing={project.missing ? <Tag label="未找到" tone="warning" /> : undefined}
              chevron
              onPress={() =>
                router.push({ pathname: '/settings/project', params: { path: project.path } })
              }
            />
          ))}
        </ListGroup>
      )}
      {host.loaded ? (
        <ListGroup>
          <ListRow
            title="添加项目"
            icon="folderPlus"
            plainIcon
            action
            disabled={!connected}
            onPress={() => setAdding(true)}
          />
        </ListGroup>
      ) : null}
    </ManagePage>
  )
}

function isCompletable(typed: string, windows: boolean): boolean {
  if (typed.startsWith('~')) return true
  if (!windows) return typed.startsWith('/')
  return /^[A-Za-z]:[\\/]/.test(typed) || typed.startsWith('\\\\')
}

function lastPart(typed: string, windows: boolean): string {
  for (let i = typed.length - 1; i >= 0; i--) {
    const ch = typed[i]
    if (ch === '/' || (windows && ch === '\\')) return typed.slice(i + 1)
  }
  return typed
}

function joinPath(folder: string, name: string, sep: string): string {
  const end = folder.at(-1)
  return end === '/' || end === '\\' ? `${folder}${name}` : `${folder}${sep}${name}`
}

/**
 * Adding a project: a folder's path on the computer, typed from the home folder's `~`, with the
 * folders the computer finds for what is typed listed under the field to go on with.
 */
function AddProjectSheet(props: { visible: boolean; onClose(): void }) {
  const { c } = useTokens()
  const host = useHost()
  const windows = host.host?.platform === 'win32'
  const sep = windows ? '\\' : '/'
  const [text, setText] = useState(`~${sep}`)
  const [completion, setCompletion] = useState<PathCompletion | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const asked = useRef(0)

  useEffect(() => {
    if (props.visible) {
      setText(`~${sep}`)
      setCompletion(null)
      setError(null)
    }
  }, [props.visible, sep])

  useEffect(() => {
    if (!props.visible || !host.link) return
    if (!isCompletable(text, windows)) {
      setCompletion(null)
      return
    }
    const mine = ++asked.current
    setLoading(true)
    const timer = setTimeout(() => {
      call(host.link!, 'paths.complete', { path: text }).then(
        (found) => {
          if (mine !== asked.current) return
          setCompletion(found)
          setError(null)
          setLoading(false)
        },
        (failure: unknown) => {
          if (mine !== asked.current) return
          setError(errorText(failure))
          setLoading(false)
        },
      )
    }, 180)
    return () => clearTimeout(timer)
  }, [text, props.visible, host.link, windows])

  const dotted = lastPart(text, windows).startsWith('.')
  const entries = (completion?.entries ?? [])
    .filter((e) => e.kind === 'folder' && (dotted || !e.name.startsWith('.')))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, MAX_ENTRIES)
  const last = lastPart(text, windows)
  const chosen = completion
    ? last === ''
      ? completion.folder
      : joinPath(completion.folder, last, sep)
    : null
  const ready = completion?.exact?.kind === 'folder'

  return (
    <FormSheet
      visible={props.visible}
      title="添加项目"
      message="输入电脑上一个文件夹的路径，从主目录 ~ 开始，或写完整路径。"
      onClose={props.onClose}
      submitLabel="添加"
      canSubmit={ready && chosen !== null}
      maxHeight={680}
      onSubmit={async () => {
        if (!host.link || !chosen) throw new Error('电脑没有连上。')
        const project = await call(host.link, 'projects.add', { path: chosen })
        void host.refresh().catch(() => {})
        router.push({ pathname: '/settings/project', params: { path: project.path } })
      }}
    >
      <Field
        value={text}
        onChangeText={setText}
        mono
        autoFocus
        returnKeyType="done"
        accessibilityLabel="文件夹路径"
        placeholder={`~${sep}code${sep}my-app`}
      />
      {error ? (
        <FieldNote error>{error}</FieldNote>
      ) : !isCompletable(text, windows) ? (
        <FieldNote error>
          {windows ? '路径要以 ~、盘符或 \\\\ 开头。' : '路径要以 ~ 或 / 开头。'}
        </FieldNote>
      ) : chosen ? (
        <FieldNote>
          {ready ? `会添加 ${chosen}` : completion?.exact ? '这不是文件夹。' : '还没有这个文件夹。'}
        </FieldNote>
      ) : null}
      <View style={[styles.entries, { backgroundColor: c.fill }]}>
        {loading && entries.length === 0 ? (
          <View style={styles.entry}>
            <ActivityIndicator size="small" color={c.textSecondary} />
          </View>
        ) : entries.length === 0 ? (
          <Text style={[typeScale.footnote, styles.entry, { color: c.textTertiary }]}>
            这里没有文件夹。
          </Text>
        ) : (
          entries.map((entry, i) => (
            <View key={entry.name}>
              {i > 0 ? <View style={[styles.line, { backgroundColor: c.border }]} /> : null}
              <Press
                scale={false}
                highlight={c.fill}
                accessibilityRole="button"
                accessibilityLabel={entry.name}
                onPress={() => {
                  haptic.select()
                  if (completion) setText(`${joinPath(completion.folder, entry.name, sep)}${sep}`)
                }}
                style={styles.entry}
              >
                <Icon name="folder" size={18} color={c.tint} />
                <Text style={[typeScale.body, styles.flex, { color: c.text }]} numberOfLines={1}>
                  {entry.name}
                </Text>
                {entry.repo ? <Tag label="Git" /> : null}
                <Icon name="chevronRight" size={12} color={c.textTertiary} weight="semibold" />
              </Press>
            </View>
          ))
        )}
      </View>
    </FormSheet>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  entries: { borderRadius: radius.lg, overflow: 'hidden' },
  entry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 46,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  line: { height: StyleSheet.hairlineWidth, marginLeft: space.lg },
})
