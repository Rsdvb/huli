// What the cards of the host's own requests share: their icons, the card that asks with its
// buttons, busy state and error with a retry, the quiet line an answered one folds to, and the line
// a waiting one leaves in the conversation while its card sits above the composer.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import {
  AppWindow,
  Bug,
  Clock,
  Globe,
  KeyRound,
  Lightbulb,
  Monitor,
  MousePointer2,
  Plug,
  Reply,
  Smartphone,
  Store,
  Undo2,
  Wallet,
  Workflow,
} from 'lucide-react-native'
import { ALREADY_ANSWERED } from '@shared/agent-host'
import type { FromDevice } from '@shared/thread'
import { useActiveHost, useHostState } from '../../host'
import { haptic } from '../../ui/session/feedback'
import { clockTime } from '../../ui/session/format'
import { G, Icon, type IconSpec } from '../../ui/session/icons'
import { MONO, useSessionTokens } from '../../ui/session/palette'
import { PressScale } from '../../ui/session/Press'

export const E = {
  site: { sf: 'globe', lucide: Globe },
  app: { sf: 'macwindow', lucide: AppWindow },
  device: { sf: 'iphone', lucide: Smartphone },
  hooks: { sf: 'apple.terminal', lucide: G.terminal.lucide },
  mcp: { sf: 'powerplug', lucide: Plug },
  report: { sf: 'ant', lucide: Bug },
  memory: { sf: 'lightbulb', lucide: Lightbulb },
  key: { sf: 'key', lucide: KeyRound },
  store: { sf: 'storefront', lucide: Store },
  computer: { sf: 'desktopcomputer', lucide: Monitor },
  wallet: { sf: 'creditcard', lucide: Wallet },
  cursor: { sf: 'cursorarrow', lucide: MousePointer2 },
  workflow: { sf: 'point.3.connected.trianglepath.dotted', lucide: Workflow },
  message: { sf: 'arrowshape.turn.up.left', lucide: Reply },
  undo: { sf: 'arrow.uturn.backward', lucide: Undo2 },
  clock: { sf: 'clock', lucide: Clock },
} satisfies Record<string, IconSpec>

/** Where the request a late answer went to was answered first: that device, null for a window. */
export function answeredBy(error: unknown): FromDevice | null | undefined {
  const e = error as { code?: string; data?: { reason?: unknown; device?: unknown } } | null
  if (e?.code !== 'not_found' || e.data?.reason !== ALREADY_ANSWERED) return undefined
  const device = e.data.device as Partial<FromDevice> | null | undefined
  return typeof device?.id === 'string' && typeof device.name === 'string'
    ? { id: device.id, name: device.name }
    : null
}

export function messageOf(error: unknown, fallback = '没有发出去，请稍后再试。'): string {
  const message = (error as { message?: unknown } | null)?.message
  return typeof message === 'string' && message ? message : fallback
}

// When this phone saw a request answered, by entry id, for the answered line's time.
const answeredAt = new Map<string, number>()

/**
 * When the request was answered, as this phone knows it: from seeing it go from waiting to answered
 * while shown, or answering it here. Null for one answered before the phone looked.
 */
export function useAnsweredAt(id: string, waiting: boolean): number | null {
  const sawWaiting = useRef(waiting)
  if (waiting) sawWaiting.current = true
  else if (sawWaiting.current && !answeredAt.has(id)) answeredAt.set(id, Date.now())
  return answeredAt.get(id) ?? null
}

export function markAnswered(id: string): void {
  answeredAt.set(id, Date.now())
}

/** The words after an answered line's headline: when here, and where it was answered. */
export function answeredDetail(at: number | null, device: FromDevice | undefined): string {
  return [at !== null ? clockTime(at) : null, device ? `在 ${device.name} 上` : null]
    .filter(Boolean)
    .join(' · ')
}

/** A run of a card's action: false when it did not go and said why itself, as a form does. */
export type Run = () => Promise<unknown>

export interface Sender {
  /**
   * The action that is being sent, by its key; for a request's answer, also the one that went,
   * whose button keeps turning until the card goes, as nothing else may be sent for it.
   */
  busy: string | null
  error: string | null
  /** A note that is no failure, as an answer another device gave first. */
  note: string | null
  send(key: string, run: Run): Promise<boolean>
  retry(): void
}

/**
 * Sends a card's answer once at a time, with a haptic on success and the failure kept to retry.
 * A second tap before the first is answered sends nothing, nor does any tap once a request's
 * answer (`entryId`) went.
 */
export function useSender(entryId?: string): Sender {
  const state = useHostState()
  const host = useActiveHost()
  const computer = state.kind === 'connected' ? state.welcome.host.name : (host?.name ?? '电脑')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const last = useRef<{ key: string; run: Run } | null>(null)
  // Read at the tap, not from the render: two taps in one frame both saw no answer in flight.
  const flying = useRef(false)
  const answered = useRef(false)
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    [],
  )

  const send = useCallback(
    async (key: string, run: Run): Promise<boolean> => {
      if (flying.current || answered.current) return false
      flying.current = true
      last.current = { key, run }
      setBusy(key)
      setError(null)
      setNote(null)
      let went = false
      try {
        const result = await run()
        if (result === false) return false
        haptic.success()
        if (entryId) {
          markAnswered(entryId)
          answered.current = true
          went = true
        }
        return true
      } catch (caught) {
        if (!alive.current) return false
        const by = answeredBy(caught)
        if (by !== undefined) {
          answered.current = !!entryId
          setNote(`已在 ${by?.name ?? computer} 上回答过。`)
        } else {
          setError(messageOf(caught))
        }
        return false
      } finally {
        flying.current = false
        if (alive.current && !went) setBusy(null)
      }
    },
    [computer, entryId],
  )

  const retry = useCallback(() => {
    const again = last.current
    if (again) void send(again.key, again.run)
  }, [send])

  return { busy, error, note, send, retry }
}

export interface CardAction {
  key: string
  label: string
  tone?: 'primary' | 'danger' | 'plain'
  disabled?: boolean
  run: Run
}

/**
 * A request that waits for the user, as PermissionCard draws one: its icon and title, the line
 * that explains it, what it names, a list of what an allow starts, and its buttons.
 */
export function AskCard(props: {
  icon: IconSpec
  title: string
  /** What it is about, such as a site or an app; set in monospace for a command or path. */
  target?: string | null
  mono?: boolean
  body?: string | null
  list?: { title?: string; items: string[] } | null
  children?: ReactNode
  actions: CardAction[]
  sender: Sender
  /** A line under the buttons, such as why a step needs the computer. */
  footnote?: string | null
}) {
  const { c, s } = useSessionTokens()
  const { sender } = props
  const [listOpen, setListOpen] = useState(false)
  const items = props.list?.items ?? []
  const shown = listOpen ? items : items.slice(0, 4)
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: s.dockCard, borderColor: c.borderStrong, shadowColor: c.shadow },
      ]}
    >
      <View style={styles.head}>
        <View style={[styles.badge, { backgroundColor: s.warningSoft }]}>
          <Icon icon={props.icon} size={15} color={c.warning} />
        </View>
        <Text style={[styles.title, { color: c.text }]}>{props.title}</Text>
      </View>
      {props.target ? (
        <Text
          selectable
          style={[
            styles.target,
            { color: c.text },
            props.mono ? { fontFamily: MONO, fontSize: 13 } : null,
          ]}
          numberOfLines={3}
        >
          {props.target}
        </Text>
      ) : null}
      {props.body ? (
        <Text style={[styles.body, { color: c.textSecondary }]}>{props.body}</Text>
      ) : null}
      {items.length > 0 && (
        <View style={[styles.list, { backgroundColor: s.code, borderColor: s.codeBorder }]}>
          {props.list?.title ? (
            <Text style={[styles.listTitle, { color: c.textTertiary }]}>{props.list.title}</Text>
          ) : null}
          {shown.map((item, i) => (
            <Text
              key={i}
              selectable
              style={[styles.listItem, { color: c.text }]}
              numberOfLines={listOpen ? undefined : 2}
            >
              {item}
            </Text>
          ))}
          {items.length > 4 && (
            <Pressable onPress={() => setListOpen((v) => !v)} hitSlop={6}>
              <Text style={[styles.more, { color: c.tint }]}>
                {listOpen ? '收起' : `还有 ${items.length - 4} 项`}
              </Text>
            </Pressable>
          )}
        </View>
      )}
      {props.children}
      <View style={styles.row}>
        {props.actions.map((action) => (
          <CardButton
            key={action.key}
            label={action.label}
            tone={action.tone ?? 'plain'}
            busy={sender.busy === action.key}
            disabled={sender.busy !== null || !!action.disabled}
            onPress={() => void sender.send(action.key, action.run)}
          />
        ))}
      </View>
      {props.footnote ? (
        <Text style={[styles.foot, { color: c.textTertiary }]}>{props.footnote}</Text>
      ) : null}
      <SendState sender={sender} />
    </View>
  )
}

/** A failed answer with its retry, or a note such as an answer given elsewhere first. */
export function SendState(props: { sender: Sender }) {
  const { c, s } = useSessionTokens()
  const { error, note } = props.sender
  if (note) return <Text style={[styles.foot, { color: c.textSecondary }]}>{note}</Text>
  if (!error) return null
  return (
    <View
      style={[styles.error, { backgroundColor: s.dangerSoft }]}
      accessibilityLiveRegion="polite"
    >
      <Icon icon={G.error} size={14} color={c.danger} />
      <Text style={[styles.errorText, { color: c.danger }]}>{error}</Text>
      <Pressable
        onPress={props.sender.retry}
        hitSlop={8}
        accessibilityRole="button"
        style={({ pressed }) => ({ opacity: pressed ? 0.55 : 1 })}
      >
        <Text style={[styles.retry, { color: c.danger }]}>重试</Text>
      </Pressable>
    </View>
  )
}

export function CardButton(props: {
  label: string
  tone?: 'primary' | 'danger' | 'plain'
  busy?: boolean
  disabled?: boolean
  onPress(): void
}) {
  const { c, s } = useSessionTokens()
  const tone = props.tone ?? 'plain'
  const color = tone === 'primary' ? c.onAccent : tone === 'danger' ? c.danger : c.text
  return (
    <PressScale
      scale={0.96}
      disabled={props.disabled}
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!props.disabled, busy: !!props.busy }}
      style={[
        styles.button,
        {
          backgroundColor:
            tone === 'primary' ? c.accent : tone === 'danger' ? s.dangerSoft : c.fillStrong,
          opacity: props.disabled && !props.busy ? 0.5 : 1,
        },
      ]}
    >
      {props.busy ? <ActivityIndicator size="small" color={color} /> : null}
      <Text style={[styles.buttonText, { color }]}>{props.label}</Text>
    </PressScale>
  )
}

/**
 * A quiet line of the conversation: an answered request folded to its answer, or one of the host's
 * own notes. `tone` colors its icon: done in green, waiting in amber, failed in red.
 */
export function QuietLine(props: {
  icon: IconSpec
  text: string
  detail?: string | null
  tone?: 'done' | 'waiting' | 'failed' | 'busy' | 'other'
  onPress?: () => void
  /** A small action at the end of the line, such as Undo. */
  trail?: ReactNode
  numberOfLines?: number
}) {
  const { c } = useSessionTokens()
  const tone = props.tone ?? 'other'
  const color =
    tone === 'done'
      ? c.success
      : tone === 'waiting'
        ? c.warning
        : tone === 'failed'
          ? c.danger
          : c.textTertiary
  return (
    <View style={styles.quiet}>
      <Pressable
        onPress={props.onPress}
        disabled={!props.onPress}
        accessibilityRole={props.onPress ? 'button' : undefined}
        style={({ pressed }) => [styles.quietMain, { opacity: pressed ? 0.55 : 1 }]}
      >
        <View style={{ height: 19, justifyContent: 'center' }}>
          {tone === 'busy' ? (
            <ActivityIndicator size="small" color={c.textTertiary} style={styles.spinner} />
          ) : (
            <Icon icon={props.icon} size={14} color={color} />
          )}
        </View>
        <Text
          style={[styles.quietText, { color: c.textSecondary }]}
          numberOfLines={props.numberOfLines ?? 2}
        >
          {props.text}
          {props.detail ? (
            <Text style={{ color: c.textTertiary }}>
              {' · '}
              {props.detail}
            </Text>
          ) : null}
        </Text>
        {props.onPress && (
          <Icon icon={G.right} size={10} color={c.textTertiary} weight="semibold" />
        )}
      </Pressable>
      {props.trail}
    </View>
  )
}

/** What a waiting request leaves in the conversation while its card waits above the composer. */
export function WaitingLine(props: { icon: IconSpec; text: string }) {
  const { c, s } = useSessionTokens()
  return (
    <View style={styles.waitingLine}>
      <View style={[styles.lineBadge, { backgroundColor: s.warningSoft }]}>
        <Icon icon={props.icon} size={13} color={c.warning} />
      </View>
      <Text style={[styles.waitingText, { color: c.text }]} numberOfLines={1}>
        {props.text}
      </Text>
      <Text style={[styles.pill, { color: c.warning, backgroundColor: s.warningSoft }]}>
        等你 · 见下方
      </Text>
    </View>
  )
}

export const kit = StyleSheet.create({
  field: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  label: { fontSize: 13, fontWeight: '600' },
  hint: { fontSize: 12, lineHeight: 16 },
  section: { marginTop: 12, gap: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 12,
    minHeight: 34,
    justifyContent: 'center',
  },
  chipText: { fontSize: 14 },
  mono: { fontFamily: MONO, fontSize: 12, lineHeight: 17 },
  block: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, padding: 10 },
})

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 22,
    padding: 16,
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  badge: { width: 28, height: 28, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  title: { flex: 1, fontSize: 16, lineHeight: 22, fontWeight: '600' },
  target: { fontSize: 15, lineHeight: 21, fontWeight: '600', marginTop: 10 },
  body: { fontSize: 14, lineHeight: 20, marginTop: 6 },
  list: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    marginTop: 12,
    gap: 4,
  },
  listTitle: { fontSize: 12, fontWeight: '600', marginBottom: 2 },
  listItem: { fontFamily: MONO, fontSize: 12, lineHeight: 17 },
  more: { fontSize: 13, fontWeight: '500', marginTop: 4 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 18,
    minHeight: 40,
    justifyContent: 'center',
  },
  buttonText: { fontSize: 15, fontWeight: '600' },
  foot: { fontSize: 13, lineHeight: 18, marginTop: 10 },
  error: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
    marginTop: 10,
  },
  errorText: { flex: 1, fontSize: 13, lineHeight: 18 },
  retry: { fontSize: 14, fontWeight: '600' },
  quiet: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 28 },
  quietMain: { flexDirection: 'row', alignItems: 'flex-start', gap: 7, flexShrink: 1 },
  quietText: { fontSize: 14, lineHeight: 19, flexShrink: 1 },
  spinner: { transform: [{ scale: 0.7 }] },
  waitingLine: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 },
  lineBadge: {
    width: 24,
    height: 24,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  waitingText: { flex: 1, fontSize: 14, lineHeight: 19 },
  pill: {
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    overflow: 'hidden',
  },
})
