// A folder's path on the computer, typed from the home folder's `~` and completed by the computer
// as it is typed: the folder of a project to add, or a further folder of one.

import { useEffect, useRef, useState } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import type { PathCompletion } from '@shared/remote/host-admin'
import { useHost } from '../host'
import { haptic } from '../ui/haptics'
import { Icon } from '../ui/Icon'
import { Press } from '../ui/Press'
import { radius, space, type as typeScale, useTokens } from '../ui/tokens'
import { call, errorText, Field, FieldNote, FormSheet, Tag } from './kit'

/** The most entries the list under the field shows; typing more of the name narrows it. */
const MAX_ENTRIES = 60

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
 * A folder's path on the computer, typed from the home folder's `~`, with the folders the computer
 * finds for what is typed listed under the field to go on with: a project's, or a further folder
 * of one.
 */
export function FolderPathSheet(props: {
  visible: boolean
  onClose(): void
  title: string
  message: string
  submitLabel: string
  onChosen(path: string): Promise<void>
}) {
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
      title={props.title}
      message={props.message}
      onClose={props.onClose}
      submitLabel={props.submitLabel}
      canSubmit={ready && chosen !== null}
      maxHeight={680}
      onSubmit={async () => {
        if (!host.link || !chosen) throw new Error('电脑没有连上。')
        await props.onChosen(chosen)
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
