// Huli: a new project on the computer, from Settings > Projects > Add project: a clone of a Git
// repository or an empty folder with Git. Where it goes is one of the folders the computer offers
// (its home and the folders its projects are in), never a path typed here; the computer checks
// the name and the folder again before it runs anything.

import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import type { HostEvent, Project } from '@shared/agent-host'
import {
  cloneFolderName,
  cloneUrlProblem,
  GITIGNORE_PRESETS,
  projectNameProblem,
  type CloneProgress,
  type CloneUrlProblem,
  type GitignorePreset,
  type ProjectNameProblem,
  type ProjectPlace,
  type ProjectPlaces,
} from '@shared/project-create'
import { hostErrorText } from '../hostErrors'
import { useHost } from '../host'
import { BottomSheet } from '../ui/BottomSheet'
import { haptic } from '../ui/haptics'
import { Icon } from '../ui/Icon'
import { Press } from '../ui/Press'
import { radius, space, type as typeScale, useTokens } from '../ui/tokens'
import { call, Field, FieldLabel, FieldNote, MONO, SwitchRow, Tag } from './kit'

export type NewProjectKind = 'clone' | 'empty'

const URL_PROBLEMS: Record<CloneUrlProblem, string> = {
  empty: '填写仓库地址。',
  tooLong: '地址太长了。',
  malformed: '这不像是一个仓库地址。',
  option: '地址不能以 - 开头。',
  local: '这里只能克隆远程仓库，不能用文件夹或 file:// 地址。',
  scheme: '请用 https://、ssh:// 或 git@主机:路径 形式的地址。',
  password: '地址里别写密码，会用电脑上 Git 自己的登录。',
}

const NAME_PROBLEMS: Record<ProjectNameProblem, string> = {
  empty: '填写文件夹名。',
  tooLong: '文件夹名太长了。',
  chars: '文件夹名不能包含 / \\ : * ? " < > | 或控制字符。',
  dots: '文件夹名不能是 . 或 ..。',
  edge: '文件夹名开头结尾不能是空格，结尾不能是句点。',
  reserved: '这个名字被 Windows 留给设备用了，换一个吧。',
}

const PHASES: Record<CloneProgress['phase'], string> = {
  connecting: '正在连接…',
  counting: '正在统计对象…',
  compressing: '远程正在压缩…',
  receiving: '正在接收对象…',
  resolving: '正在处理差异…',
  checkout: '正在检出文件…',
}

const GITIGNORE_LABELS: Record<GitignorePreset, string> = {
  general: '通用',
  node: 'Node.js',
  python: 'Python',
  go: 'Go',
  rust: 'Rust',
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** What a failed request says here, in Chinese, from the fields the computer sends with it. */
function failureText(error: unknown): string | null {
  const record = (error ?? {}) as { code?: unknown; data?: unknown }
  const data = (record.data ?? {}) as { field?: unknown; problem?: unknown; reason?: unknown }
  if (data.reason === 'cancelled') return null
  if (data.field === 'url' && typeof data.problem === 'string' && data.problem in URL_PROBLEMS) {
    return URL_PROBLEMS[data.problem as CloneUrlProblem]
  }
  if (data.field === 'name') {
    if (typeof data.problem === 'string' && data.problem in NAME_PROBLEMS) {
      return NAME_PROBLEMS[data.problem as ProjectNameProblem]
    }
    if (record.code === 'conflict') return '那里已经有这个名字的文件或文件夹，换一个名字。'
  }
  if (data.field === 'parent') {
    return record.code === 'forbidden' ? '只能选电脑列出的位置。' : '这个位置在电脑上已经不在了。'
  }
  if (record.code === 'git_error') return hostErrorText(error, '', '没能完成。')
  return hostErrorText(error)
}

function separatorOf(path: string): string {
  return /^[A-Za-z]:\\|^\\\\/.test(path) ? '\\' : '/'
}

function joinPath(folder: string, name: string): string {
  const sep = separatorOf(folder)
  return folder.endsWith(sep) ? `${folder}${name}` : `${folder}${sep}${name}`
}

/** The path from the home folder's `~`, as the computer writes it. */
function shortPath(path: string, home: string | null): string {
  if (home === null) return path
  const sep = separatorOf(home)
  const windows = sep === '\\'
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b)
  if (same(path, home)) return '~'
  const prefix = home.endsWith(sep) ? home : `${home}${sep}`
  if (path.length > prefix.length && same(path.slice(0, prefix.length), prefix)) {
    return `~${sep}${path.slice(prefix.length)}`
  }
  return path
}

export function NewProjectSheet(props: {
  kind: NewProjectKind
  visible: boolean
  onClose(): void
  onDone(project: Project): void
}) {
  const { c } = useTokens()
  const host = useHost()
  const link = host.link
  const [places, setPlaces] = useState<ProjectPlaces | null>(null)
  const [placesError, setPlacesError] = useState<string | null>(null)
  const [parent, setParent] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [typedName, setTypedName] = useState<string | null>(null)
  const [readme, setReadme] = useState(true)
  const [gitignore, setGitignore] = useState<GitignorePreset | null>(null)
  const [cloneId, setCloneId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [progress, setProgress] = useState<CloneProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const live = useRef(true)
  const busy = cloneId !== null || creating

  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])

  useEffect(() => {
    if (!props.visible) return
    setUrl('')
    setTypedName(null)
    setReadme(true)
    setGitignore(null)
    setError(null)
    setProgress(null)
    setPlaces(null)
    setPlacesError(null)
    if (!link) return
    let current = true
    call(link, 'projects.places', undefined).then(
      (found) => {
        if (!current) return
        setPlaces(found)
        setParent(found.last ?? found.places[0]?.path ?? null)
      },
      (failure: unknown) => current && setPlacesError(hostErrorText(failure)),
    )
    return () => {
      current = false
    }
  }, [props.visible, link])

  useEffect(() => {
    if (!link || cloneId === null) return
    return link.onHostEvent((raw) => {
      const event = raw as HostEvent
      if (event.type === 'projects.cloneProgress' && event.progress.cloneId === cloneId) {
        setProgress(event.progress)
      }
    })
  }, [link, cloneId])

  const trimmed = url.trim()
  const urlProblem = props.kind === 'clone' ? cloneUrlProblem(trimmed) : null
  const name =
    typedName ?? (props.kind === 'clone' && urlProblem === null ? cloneFolderName(trimmed) : '')
  const nameProblem = projectNameProblem(name)
  const home = places?.places.find((place) => place.kind === 'home')?.path ?? null
  const ready =
    !busy && link !== null && parent !== null && urlProblem === null && nameProblem === null

  const submit = async (): Promise<void> => {
    if (!ready || !link || parent === null) return
    setError(null)
    try {
      let project: Project
      if (props.kind === 'clone') {
        const id = randomId()
        setProgress(null)
        setCloneId(id)
        project = await call(link, 'projects.clone', { cloneId: id, url: trimmed, parent, name })
      } else {
        setCreating(true)
        project = await call(link, 'projects.create', { parent, name, readme, gitignore })
      }
      haptic.success()
      props.onDone(project)
    } catch (failure) {
      const text = failureText(failure)
      if (text !== null && live.current) {
        haptic.warning()
        setError(text)
      }
    } finally {
      if (live.current) {
        setCloneId(null)
        setCreating(false)
      }
    }
  }

  const cancelClone = (): void => {
    if (cloneId !== null && link) {
      void call(link, 'projects.cancelClone', { cloneId }).catch(() => {})
    }
  }

  // The system's sheet is gone once dragged away, so a clone that runs ends with it.
  const close = (): void => {
    cancelClone()
    props.onClose()
  }

  return (
    <BottomSheet
      visible={props.visible}
      onClose={close}
      title={props.kind === 'clone' ? '从 Git 克隆' : '新建空项目'}
      message={
        props.kind === 'clone'
          ? '克隆到电脑上并添加为项目。私有仓库会用电脑上 Git 已有的登录。'
          : '在电脑上新建文件夹，运行 git init，并添加为项目。'
      }
      maxHeight={720}
      solid
    >
      {props.kind === 'clone' ? (
        <View style={styles.block}>
          <FieldLabel>仓库地址</FieldLabel>
          <Field
            value={url}
            onChangeText={(text) => {
              setUrl(text)
              setError(null)
            }}
            mono
            editable={!busy}
            keyboardType="url"
            returnKeyType="done"
            accessibilityLabel="仓库地址"
            testID="new-project-url"
            placeholder="https://github.com/owner/repo.git"
          />
          {trimmed !== '' && urlProblem !== null ? (
            <FieldNote error>{URL_PROBLEMS[urlProblem]}</FieldNote>
          ) : null}
        </View>
      ) : null}
      <View style={styles.block}>
        <FieldLabel>位置</FieldLabel>
        {placesError !== null ? (
          <FieldNote error>{placesError}</FieldNote>
        ) : places === null ? (
          <View style={[styles.places, styles.loading, { backgroundColor: c.fill }]}>
            <ActivityIndicator size="small" color={c.textSecondary} />
          </View>
        ) : places.places.length === 0 ? (
          <FieldNote error>电脑没有列出可以放新项目的位置。</FieldNote>
        ) : (
          <View style={[styles.places, { backgroundColor: c.fill }]}>
            {places.places.map((place, i) => (
              <PlaceRow
                key={place.path}
                place={place}
                home={home}
                first={i === 0}
                chosen={place.path === parent}
                disabled={busy}
                onPress={() => {
                  haptic.select()
                  setParent(place.path)
                  setError(null)
                }}
              />
            ))}
          </View>
        )}
      </View>
      <View style={styles.block}>
        <FieldLabel>文件夹名</FieldLabel>
        <Field
          value={name}
          onChangeText={(text) => {
            setTypedName(text)
            setError(null)
          }}
          editable={!busy}
          returnKeyType="done"
          accessibilityLabel="文件夹名"
          testID="new-project-name"
          autoFocus={props.kind === 'empty'}
        />
        {name !== '' && nameProblem !== null ? (
          <FieldNote error>{NAME_PROBLEMS[nameProblem]}</FieldNote>
        ) : parent !== null && name !== '' ? (
          <FieldNote>{`将创建 ${shortPath(joinPath(parent, name), home)}`}</FieldNote>
        ) : null}
      </View>
      {props.kind === 'empty' ? (
        <>
          <View style={[styles.places, { backgroundColor: c.fill }]}>
            <SwitchRow title="添加 README.md" value={readme} disabled={busy} onChange={setReadme} />
          </View>
          <View style={styles.block}>
            <FieldLabel>.gitignore</FieldLabel>
            <View style={styles.chips}>
              {[null, ...GITIGNORE_PRESETS].map((preset) => (
                <Chip
                  key={preset ?? 'none'}
                  label={preset === null ? '不添加' : GITIGNORE_LABELS[preset]}
                  chosen={gitignore === preset}
                  disabled={busy}
                  onPress={() => {
                    haptic.select()
                    setGitignore(preset)
                  }}
                />
              ))}
            </View>
          </View>
        </>
      ) : null}
      {cloneId !== null ? (
        <View style={styles.progress} accessibilityLiveRegion="polite">
          <View style={styles.progressHead}>
            {progress?.percent == null ? (
              <ActivityIndicator size="small" color={c.textSecondary} />
            ) : null}
            <Text style={[typeScale.footnote, styles.flex, { color: c.textSecondary }]}>
              {PHASES[progress?.phase ?? 'connecting']}
            </Text>
            {progress?.percent != null ? (
              <Text style={[typeScale.footnote, { color: c.textTertiary }]}>
                {`${progress.percent}%`}
              </Text>
            ) : null}
          </View>
          <View style={[styles.track, { backgroundColor: c.fill }]}>
            <View
              style={[
                styles.bar,
                { backgroundColor: c.accent, width: `${progress?.percent ?? 0}%` },
              ]}
            />
          </View>
        </View>
      ) : null}
      {error !== null ? (
        <Text style={[typeScale.footnote, { color: c.danger }]} selectable>
          {error}
        </Text>
      ) : null}
      {cloneId !== null ? (
        <Press
          onPress={cancelClone}
          accessibilityRole="button"
          style={[styles.submit, { backgroundColor: c.fill }]}
        >
          <Text style={[typeScale.headline, { color: c.danger }]}>取消克隆</Text>
        </Press>
      ) : (
        <Press
          onPress={() => void submit()}
          disabled={!ready}
          accessibilityRole="button"
          style={[styles.submit, { backgroundColor: c.accent, opacity: ready ? 1 : 0.5 }]}
        >
          {creating ? (
            <ActivityIndicator color={c.onAccent} />
          ) : (
            <Text style={[typeScale.headline, { color: c.onAccent }]}>
              {props.kind === 'clone' ? '克隆' : '创建'}
            </Text>
          )}
        </Press>
      )}
    </BottomSheet>
  )
}

function PlaceRow(props: {
  place: ProjectPlace
  home: string | null
  first: boolean
  chosen: boolean
  disabled: boolean
  onPress(): void
}) {
  const { c } = useTokens()
  const label = shortPath(props.place.path, props.home)
  return (
    <View>
      {!props.first ? <View style={[styles.line, { backgroundColor: c.border }]} /> : null}
      <Press
        scale={false}
        highlight={c.fill}
        disabled={props.disabled}
        accessibilityRole="radio"
        accessibilityState={{ selected: props.chosen }}
        accessibilityLabel={label}
        onPress={props.onPress}
        style={styles.place}
      >
        <Icon name="folder" size={18} color={c.tint} />
        <Text
          style={[typeScale.callout, styles.flex, styles.mono, { color: c.text }]}
          numberOfLines={1}
          ellipsizeMode="head"
        >
          {label}
        </Text>
        {props.place.kind !== 'project' ? (
          <Tag label={props.place.kind === 'last' ? '上次用过' : '主目录'} />
        ) : null}
        <Icon
          name={props.chosen ? 'checkCircle' : 'circle'}
          size={20}
          color={props.chosen ? c.accent : c.textTertiary}
        />
      </Press>
    </View>
  )
}

function Chip(props: { label: string; chosen: boolean; disabled: boolean; onPress(): void }) {
  const { c } = useTokens()
  return (
    <Press
      onPress={props.onPress}
      disabled={props.disabled}
      accessibilityRole="radio"
      accessibilityState={{ selected: props.chosen }}
      style={[styles.chip, { backgroundColor: props.chosen ? c.accent : c.fill }]}
    >
      <Text style={[typeScale.subhead, { color: props.chosen ? c.onAccent : c.text }]}>
        {props.label}
      </Text>
    </Press>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  mono: { fontFamily: MONO },
  block: { gap: space.xs + 2 },
  places: { borderRadius: radius.lg, overflow: 'hidden' },
  loading: { minHeight: 46, alignItems: 'center', justifyContent: 'center' },
  place: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 46,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
  },
  line: { height: StyleSheet.hairlineWidth, marginLeft: space.lg },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    minHeight: 34,
    paddingHorizontal: space.md + 2,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  progress: { gap: space.sm },
  progressHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  track: { height: 5, borderRadius: radius.pill, overflow: 'hidden' },
  bar: { height: 5, borderRadius: radius.pill },
  submit: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    borderRadius: radius.pill,
    marginTop: space.xs,
  },
})
