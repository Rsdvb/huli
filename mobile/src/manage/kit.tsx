// What the management pages of Settings share: reading from the computer and reading again when it
// says something changed, the page's frame with pull to refresh, its loading, offline and error
// states, buttons that show they are busy, notices, confirmations and the sheet a form goes in.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ActivityIndicator,
  Alert,
  Animated,
  Platform,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { DeviceResult, HostMethod, HostParams } from '@shared/agent-host'
import type { HostAdminEvent, HostSettingsPart } from '@shared/remote/host-admin'
import type { HostLink } from '@shared/remote/link'
import type { SettingsPatch } from '@shared/settings'
import { admin } from '../admin'
import { useConnected, useHostActions, useMaybeLink, withinRefreshLimit } from '../host'
import { ListSyncNote } from '../components/SyncNote'
import { errorText } from '../sessions'
import { BottomSheet } from '../ui/BottomSheet'
import { EmptyState } from '../ui/EmptyState'
import { haptic } from '../ui/haptics'
import { Icon, type IconName } from '../ui/Icon'
import { ListRow } from '../ui/ListRow'
import { NavBar } from '../ui/NavBar'
import { Press } from '../ui/Press'
import { Screen } from '../ui/Screen'
import { useCollapsingHeader } from '../ui/ScrollHeader'
import { usePullRefresh } from '../ui/PullRefresh'
import { Skeleton } from '../ui/Skeleton'
import { radius, space, type as typeScale, useTokens } from '../ui/tokens'

export { errorText }

/** A host request with its device result typed. */
export function call<M extends HostMethod>(
  link: HostLink,
  method: M,
  params: HostParams<M>,
): Promise<DeviceResult<M>> {
  return link.request(method, params) as Promise<DeviceResult<M>>
}

export const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' })

/** A read from the computer: null until it came, then kept while it is read again. */
export interface Read<T> {
  value: T | null
  error: string | null
  /** Reads again; resolves when the answer came, whatever it was. */
  reload(): Promise<void>
  /** Changes what was read, as after an action whose result the page already knows. */
  set(change: (value: T) => T): void
}

/**
 * Reads `read` while the computer is connected, and again whenever it sends one of `events` (host
 * events or the host's own, such as `settings.changed`). `key` names what is read; a new key starts
 * from nothing rather than show what the last one read.
 */
export function useRead<T>(
  key: string | null,
  read: (link: HostLink, signal: AbortSignal) => Promise<T>,
  events: readonly string[] = [],
): Read<T> {
  const link = useMaybeLink()
  const connected = useConnected()
  const [state, setState] = useState<{ key: string | null; value: T | null; error: string | null }>(
    { key: null, value: null, error: null },
  )
  const reader = useRef(read)
  reader.current = read
  const current = useRef(key)
  current.current = key
  const eventList = events.join('\n')

  const reload = useCallback(async () => {
    const asked = current.current
    if (!link || asked === null) return
    try {
      // A read waits for a dropped link to come back; the limit makes it fail instead.
      const value = await withinRefreshLimit((signal) => reader.current(link, signal))
      if (current.current === asked) setState({ key: asked, value, error: null })
    } catch (failure) {
      if (current.current !== asked) return
      setState((s) => ({
        key: asked,
        value: s.key === asked ? s.value : null,
        error: errorText(failure),
      }))
    }
  }, [link])

  useEffect(() => {
    if (connected && key !== null) void reload()
  }, [connected, key, reload])

  useEffect(() => {
    if (!link || key === null || eventList === '') return
    const wanted = new Set(eventList.split('\n'))
    let timer: ReturnType<typeof setTimeout> | null = null
    const hear = (event: { type?: unknown } | null) => {
      if (typeof event?.type !== 'string' || !wanted.has(event.type)) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void reload(), 250)
    }
    const offHost = link.onHostEvent((event) => hear(event as { type?: unknown }))
    const offAdmin = link.onAdminEvent((event: HostAdminEvent) => hear(event))
    return () => {
      if (timer) clearTimeout(timer)
      offHost()
      offAdmin()
    }
  }, [link, key, eventList, reload])

  // The same function while the key holds, so an effect that takes it does not run again.
  const set = useCallback(
    (change: (value: T) => T) =>
      setState((s) => (s.key === key && s.value !== null ? { ...s, value: change(s.value) } : s)),
    [key],
  )
  const mine = key !== null && state.key === key
  return {
    value: mine ? state.value : null,
    error: mine ? state.error : null,
    reload,
    set,
  }
}

/** The host's part of the settings, kept current, and a way to change it. */
export function useHostSettings(): Read<HostSettingsPart> & {
  update(patch: SettingsPatch): Promise<void>
} {
  const link = useMaybeLink()
  const read = useRead('host-settings', (link) => admin(link, 'settings.get'), [])
  const { set } = read
  useEffect(() => {
    if (!link) return
    return link.onAdminEvent((event) => {
      if (event.type === 'settings.changed') set(() => event.settings)
    })
  }, [link, set])
  return {
    ...read,
    update: async (patch) => {
      if (!link) throw new Error('电脑没有连上。')
      const next = await admin(link, 'settings.update', { patch })
      set(() => next)
    },
  }
}

/** Whether the computer is connected now. */
export { useConnected }

/**
 * Runs actions by key, marking each busy while it runs: a failure warns and shows why under
 * `failTitle`; a success gives the success haptic. Resolves true when it succeeded.
 */
export function useActions(): {
  busy: (key: string) => boolean
  run: (key: string, action: () => Promise<unknown>, failTitle: string) => Promise<boolean>
} {
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const running = useRef(new Set<string>())
  const run = useCallback(
    async (key: string, action: () => Promise<unknown>, failTitle: string): Promise<boolean> => {
      if (running.current.has(key)) return false
      running.current.add(key)
      setBusy(new Set(running.current))
      try {
        await action()
        haptic.success()
        return true
      } catch (failure) {
        fail(failTitle, failure)
        return false
      } finally {
        running.current.delete(key)
        setBusy(new Set(running.current))
      }
    },
    [],
  )
  return { busy: (key) => busy.has(key), run }
}

/** Says an action failed, and why. */
export function fail(title: string, failure: unknown): void {
  haptic.warning()
  Alert.alert(title, errorText(failure))
}

/** Asks before something that cannot be taken back; resolves whether the user went ahead. */
export function confirm(input: {
  title: string
  message?: string
  confirm: string
  destructive?: boolean
}): Promise<boolean> {
  if (input.destructive !== false) haptic.warning()
  return new Promise((resolve) => {
    Alert.alert(
      input.title,
      input.message,
      [
        { text: '取消', style: 'cancel', onPress: () => resolve(false) },
        {
          text: input.confirm,
          style: input.destructive === false ? 'default' : 'destructive',
          onPress: () => resolve(true),
        },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    )
  })
}

/**
 * A management page: the floating bar with its title, a scrolling column of groups that pulls to
 * refresh, and an optional line above the groups.
 */
export function ManagePage(props: {
  title: string
  /** Under the title in the bar. */
  subtitle?: string
  intro?: string
  children?: ReactNode
  onRefresh?: () => Promise<unknown>
  right?: ReactNode
  /** Over the page, such as the sheets it opens. */
  overlay?: ReactNode
}) {
  const { c } = useTokens()
  const header = useCollapsingHeader()
  const insets = useSafeAreaInsets()
  const { onRefresh } = props
  const connected = useConnected()
  const { retry } = useHostActions()
  // A pull that failed, timed out or ran while the computer was away, as home says it.
  const [failure, setFailure] = useState<string | null>(null)
  const live = useRef(connected)
  live.current = connected
  useEffect(() => {
    if (connected) setFailure(null)
  }, [connected])
  const pull = async () => {
    if (!onRefresh) return
    if (!live.current) retry()
    try {
      await withinRefreshLimit(() => onRefresh())
      setFailure(live.current ? null : '电脑没有连上。')
    } catch (error) {
      setFailure(errorText(error))
      throw error
    }
  }
  const refreshControl = usePullRefresh(onRefresh ? pull : undefined, header)
  return (
    <Screen readable>
      <Animated.ScrollView
        {...header.scrollProps}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingTop: header.contentTop + space.md,
          paddingHorizontal: space.lg,
          paddingBottom: insets.bottom + space.xxxl,
          gap: space.xxl,
        }}
        refreshControl={refreshControl}
      >
        <ListSyncNote error={failure} syncedAt={null} onRetry={pull} />
        {props.intro ? (
          <Text style={[typeScale.footnote, styles.intro, { color: c.textSecondary }]}>
            {props.intro}
          </Text>
        ) : null}
        {props.children}
      </Animated.ScrollView>
      <NavBar
        header={header}
        title={props.title}
        subtitle={props.subtitle}
        titleAlways
        right={props.right}
      />
      {props.overlay}
    </Screen>
  )
}

/** Rows that breathe in a rounded group while a list is read. */
export function SkeletonGroup(props: { rows?: number; header?: boolean }) {
  const { c } = useTokens()
  const widths = ['62%', '48%', '70%', '40%', '56%', '66%'] as const
  return (
    <View style={styles.groupWrap} accessibilityLabel="正在加载">
      {props.header !== false ? <Skeleton width={90} height={14} /> : null}
      <View style={[styles.group, { backgroundColor: c.surface, borderColor: c.border }]}>
        {Array.from({ length: props.rows ?? 4 }, (_, i) => (
          <View key={i} style={styles.skeletonRow}>
            <Skeleton width={30} height={30} radius={radius.sm} />
            <View style={styles.flexGap}>
              <Skeleton width={widths[i % widths.length]} height={15} />
              <Skeleton width="34%" height={11} />
            </View>
          </View>
        ))}
      </View>
    </View>
  )
}

/**
 * What a page shows until its read came: skeleton rows while it is read, why it could not be read
 * with Retry, or that the computer is not connected. Null once there is something to show.
 */
export function ReadState<T>(props: {
  read: Read<T>
  /** What is read, in a phrase: 「Agent」「记忆」. */
  what: string
  icon: IconName
  rows?: number
}): ReactNode {
  const connected = useConnected()
  if (props.read.value !== null) return null
  if (props.read.error !== null) {
    return (
      <EmptyState
        tone="error"
        icon="warning"
        title={`没能读取${props.what}`}
        message={props.read.error}
        action={{ label: '重试', onPress: () => void props.read.reload() }}
      />
    )
  }
  if (!connected) {
    return (
      <EmptyState
        icon={props.icon}
        title={`连上电脑后才能看${props.what}`}
        message="电脑开着、纸鸢在运行，并且和这台手机在同一网络或 Tailscale 上时就能连上。"
      />
    )
  }
  return (
    <View style={styles.stack}>
      <SkeletonGroup rows={props.rows ?? 4} />
    </View>
  )
}

export type ButtonTone = 'primary' | 'secondary' | 'danger' | 'plain'

/** A button that shows it is busy: a spinner in place of its label. */
export function Button(props: {
  label: string
  onPress(): void
  tone?: ButtonTone
  busy?: boolean
  disabled?: boolean
  icon?: IconName
  /** Takes the row's width. */
  wide?: boolean
  accessibilityLabel?: string
}) {
  const { c } = useTokens()
  const tone = props.tone ?? 'secondary'
  const background = tone === 'primary' ? c.accent : tone === 'plain' ? 'transparent' : c.fillStrong
  const ink =
    tone === 'primary'
      ? c.onAccent
      : tone === 'danger'
        ? c.danger
        : tone === 'plain'
          ? c.tint
          : c.text
  return (
    <Press
      onPress={() => {
        haptic.tap()
        props.onPress()
      }}
      disabled={props.disabled || props.busy}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityState={{ busy: !!props.busy, disabled: !!props.disabled }}
      containerStyle={props.wide ? styles.wide : undefined}
      style={[styles.button, { backgroundColor: background }]}
    >
      {props.busy ? (
        <ActivityIndicator size="small" color={ink} />
      ) : (
        <>
          {props.icon ? <Icon name={props.icon} size={15} color={ink} weight="semibold" /> : null}
          <Text style={[typeScale.subhead, { color: ink, fontWeight: '600' }]} numberOfLines={1}>
            {props.label}
          </Text>
        </>
      )}
    </Press>
  )
}

/** Buttons side by side, wrapping when they do not fit. */
export function Buttons(props: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return <View style={[styles.buttons, props.style]}>{props.children}</View>
}

export type NoticeTone = 'info' | 'warning' | 'error' | 'success'

/** A card that says something about the page's subject, with what to do about it. */
export function Notice(props: {
  tone?: NoticeTone
  title: string
  children?: ReactNode
  actions?: ReactNode
  busy?: boolean
}) {
  const { c } = useTokens()
  const tone = props.tone ?? 'info'
  const color =
    tone === 'error'
      ? c.danger
      : tone === 'warning'
        ? c.warning
        : tone === 'success'
          ? c.success
          : c.tint
  const icon: IconName =
    tone === 'error'
      ? 'failed'
      : tone === 'warning'
        ? 'warning'
        : tone === 'success'
          ? 'succeeded'
          : 'info'
  return (
    <View
      style={[styles.notice, { backgroundColor: c.surface, borderColor: c.border }]}
      accessibilityRole={tone === 'error' ? 'alert' : undefined}
    >
      <View style={styles.noticeHead}>
        {props.busy ? (
          <ActivityIndicator size="small" color={color} />
        ) : (
          <Icon name={icon} size={18} color={color} weight="semibold" />
        )}
        <Text style={[typeScale.headline, styles.flex, { color: c.text }]}>{props.title}</Text>
      </View>
      {typeof props.children === 'string' ? (
        <Text style={[typeScale.footnote, { color: c.textSecondary }]} selectable>
          {props.children}
        </Text>
      ) : (
        props.children
      )}
      {props.actions ? <Buttons>{props.actions}</Buttons> : null}
    </View>
  )
}

/** A task's output, newest line last: in the text color, or the danger one once it failed. */
export function LogLines(props: { lines: readonly string[]; failed?: boolean; max?: number }) {
  const { c } = useTokens()
  const lines = props.lines.slice(-(props.max ?? 8))
  if (lines.length === 0) return null
  return (
    <View style={[styles.log, { backgroundColor: c.fill }]}>
      {lines.map((line, i) => {
        const last = i === lines.length - 1
        return (
          <Text
            key={i}
            selectable
            numberOfLines={2}
            style={[
              styles.logLine,
              { color: last ? (props.failed ? c.danger : c.text) : c.textSecondary },
            ]}
          >
            {line}
          </Text>
        )
      })}
    </View>
  )
}

/** A command or a path, as it is typed, that can be selected and copied. */
export function Code(props: { children: string }) {
  const { c } = useTokens()
  return (
    <Text selectable style={[styles.code, { color: c.textSecondary, backgroundColor: c.fill }]}>
      {props.children}
    </Text>
  )
}

/** A row with a switch at its end. */
export function SwitchRow(props: {
  title: string
  subtitle?: string
  icon?: IconName
  value: boolean
  onChange(on: boolean): void
  disabled?: boolean
  busy?: boolean
  leading?: ReactNode
}) {
  const { c } = useTokens()
  return (
    <ListRow
      title={props.title}
      subtitle={props.subtitle}
      icon={props.icon}
      leading={props.leading}
      plainIcon
      trailing={
        props.busy ? (
          <ActivityIndicator size="small" color={c.textSecondary} />
        ) : (
          <Switch
            value={props.value}
            disabled={props.disabled}
            onValueChange={(on) => {
              haptic.select()
              props.onChange(on)
            }}
            trackColor={{ true: c.success }}
            accessibilityLabel={props.title}
          />
        )
      }
    />
  )
}

/** A form field's label. */
export function FieldLabel(props: { children: string }) {
  const { c } = useTokens()
  return (
    <Text style={[typeScale.footnote, styles.label, { color: c.textSecondary }]}>
      {props.children}
    </Text>
  )
}

/** A text field in a form; `mono` for paths, commands and keys. */
export function Field(props: TextInputProps & { mono?: boolean }) {
  const { c } = useTokens()
  const { mono, style, ...rest } = props
  return (
    <TextInput
      placeholderTextColor={c.textTertiary}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      {...rest}
      style={[
        typeScale.body,
        styles.field,
        mono && { fontFamily: MONO, fontSize: 14 },
        props.multiline && styles.fieldMulti,
        { color: c.text, backgroundColor: c.fill },
        style,
      ]}
    />
  )
}

/** A hint under a field, or why it is refused in the danger color. */
export function FieldNote(props: { children: string; error?: boolean }) {
  const { c } = useTokens()
  return (
    <Text
      style={[typeScale.footnote, styles.label, { color: props.error ? c.danger : c.textTertiary }]}
    >
      {props.children}
    </Text>
  )
}

/**
 * A form in a sheet: its fields, why the last try failed, and its one action, busy while it runs.
 * It closes once `onSubmit` resolves, and stays with the reason when it rejects.
 */
export function FormSheet(props: {
  visible: boolean
  title: string
  message?: string
  onClose(): void
  submitLabel: string
  onSubmit(): Promise<void>
  canSubmit?: boolean
  destructive?: boolean
  children?: ReactNode
  maxHeight?: number
}) {
  const { c } = useTokens()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (props.visible) {
      setBusy(false)
      setError(null)
    }
  }, [props.visible])
  const submit = async () => {
    if (busy || props.canSubmit === false) return
    setBusy(true)
    setError(null)
    try {
      await props.onSubmit()
      haptic.success()
      props.onClose()
    } catch (failure) {
      haptic.warning()
      setError(errorText(failure))
    } finally {
      setBusy(false)
    }
  }
  return (
    <BottomSheet
      visible={props.visible}
      onClose={props.onClose}
      title={props.title}
      message={props.message}
      maxHeight={props.maxHeight ?? 640}
    >
      {props.children}
      {error ? (
        <Text style={[typeScale.footnote, { color: c.danger }]} selectable>
          {error}
        </Text>
      ) : null}
      <Press
        onPress={() => void submit()}
        disabled={busy || props.canSubmit === false}
        accessibilityRole="button"
        style={[styles.submit, { backgroundColor: props.destructive ? c.danger : c.accent }]}
      >
        {busy ? (
          <ActivityIndicator color={c.onAccent} />
        ) : (
          <Text style={[typeScale.headline, { color: c.onAccent }]}>{props.submitLabel}</Text>
        )}
      </Press>
    </BottomSheet>
  )
}

/** A small capsule tag: 「默认」「已停用」「需要登录」. */
export function Tag(props: {
  label: string
  tone?: 'neutral' | 'tint' | 'warning' | 'danger' | 'success'
}) {
  const { c } = useTokens()
  const tone = props.tone ?? 'neutral'
  const color =
    tone === 'tint'
      ? c.tint
      : tone === 'warning'
        ? c.warning
        : tone === 'danger'
          ? c.danger
          : tone === 'success'
            ? c.success
            : c.textSecondary
  return (
    <View style={[styles.tag, { backgroundColor: c.fill }]}>
      <Text style={[typeScale.caption, { color }]} numberOfLines={1}>
        {props.label}
      </Text>
    </View>
  )
}

/** A line of text inside a group, in place of rows: an empty list's or a section's note. */
export function GroupNote(props: { children: string; tone?: 'muted' | 'error' }) {
  const { c } = useTokens()
  return (
    <View style={[styles.groupNote, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Text
        style={[typeScale.footnote, { color: props.tone === 'error' ? c.danger : c.textSecondary }]}
        selectable
      >
        {props.children}
      </Text>
    </View>
  )
}

/** The last part of a path, on either platform's separator. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** A home folder's path shortened to `~`, as the desktop shows it. */
export function homeShort(path: string): string {
  return path
    .replace(/^\/Users\/[^/]+/, '~')
    .replace(/^\/home\/[^/]+/, '~')
    .replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~')
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  flexGap: { flex: 1, gap: space.sm },
  stack: { gap: space.xxl },
  intro: { marginHorizontal: space.lg },
  groupWrap: { gap: space.sm },
  group: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  skeletonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 60,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  wide: { flex: 1 },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs + 2,
    minHeight: 36,
    minWidth: 64,
    paddingHorizontal: space.md + 2,
    borderRadius: radius.pill,
  },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, alignItems: 'center' },
  notice: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.lg,
    gap: space.sm + 2,
  },
  noticeHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm + 2 },
  log: { borderRadius: radius.sm, padding: space.md, gap: 2 },
  logLine: { fontFamily: MONO, fontSize: 12, lineHeight: 17 },
  code: {
    fontFamily: MONO,
    fontSize: 13,
    lineHeight: 19,
    borderRadius: radius.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    overflow: 'hidden',
  },
  label: { marginLeft: space.xs },
  field: {
    borderRadius: radius.md,
    paddingHorizontal: space.md + 2,
    paddingVertical: space.md,
    minHeight: 46,
  },
  fieldMulti: { minHeight: 88, maxHeight: 180, textAlignVertical: 'top' },
  submit: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    borderRadius: radius.pill,
    marginTop: space.xs,
  },
  tag: {
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
    alignSelf: 'center',
  },
  groupNote: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: space.lg,
    paddingVertical: space.md + 2,
  },
})
