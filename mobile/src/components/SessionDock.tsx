// What sits around a session's composer: the messages queued behind the running turn, each to send
// now, edit in the composer or remove; and the session's permission mode, model and effort as the
// agent reports them, each a button of the composer's own row that opens its menu.

import { useState, type RefObject } from 'react'
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import Reanimated, { Easing, FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated'
import { useKeyboardState } from 'react-native-keyboard-controller'
import type { ConfigOption, QueuedPrompt, SessionView, UserContent } from '@shared/thread'
import type { HarnessId } from '@shared/agents'
import { useAgent, useConnected, useMaybeLink } from '../host'
import { setPrefs, usePrefs } from '../prefs'
import { hostErrorText } from '../hostErrors'
import { haptic } from '../ui/session/feedback'
import { AgentGlyph, G, Icon } from '../ui/session/icons'
import { useSessionTokens } from '../ui/session/palette'
import type { ViewHandle } from '../ui/session/Popover'
import { PressScale, RoundButton } from '../ui/session/Press'
import {
  MODE_ICON,
  modeLook,
  modelName,
  optionOf,
  shownChoice,
  type ConfigControl,
  type ModeLook,
} from './ConfigMenus'
import { optionName, shortModelName } from '../ui/session/optionText'

function promptText(item: QueuedPrompt): string {
  return item.content
    .map((c) => (c.type === 'text' ? c.text : c.ref.kind === 'link' ? c.ref.uri : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function attachmentCount(item: QueuedPrompt): number {
  return item.content.filter((c) => c.type === 'ref' && c.ref.kind !== 'link').length
}

export interface ConfigSlot {
  option: ConfigOption
  name: string
  /** Changeable only between turns, and a turn runs. */
  locked: boolean
}

export interface SessionConfig {
  control: ConfigControl
  mode: (ConfigSlot & { look: ModeLook }) | null
  model: ConfigSlot | null
  effort: ConfigSlot | null
  harness: HarnessId | undefined
  /** The option being changed. */
  setting: string | null
  connected: boolean
}

/** A select option's slot in the composer's row, by what it shows. */
export function slotOf(
  config: readonly ConfigOption[],
  category: 'mode' | 'model' | 'thought_level',
  running: boolean,
): ConfigSlot | null {
  const option = optionOf(config, category)
  if (!option) return null
  const choice = shownChoice(option)
  const name = choice?.name ?? String(option.value)
  return {
    option,
    name:
      category === 'model' ? shortModelName(choice ?? { name: modelName(name) }) : optionName(name),
    locked: !!option.idleOnly && running,
  }
}

/** A mode's name short enough for the composer's pill. */
const MODE_SHORT: Record<ModeLook, string> = {
  asks: '询问',
  edits: '接受编辑',
  plan: '计划',
  auto: '自动',
  full: '完全访问',
}

export function useSessionConfig(
  sessionId: string,
  session: SessionView | undefined,
): SessionConfig {
  const link = useMaybeLink()
  const agent = useAgent(session?.agentId)
  const [setting, setSetting] = useState<string | null>(null)
  const connected = useConnected()
  const running = session?.status === 'running' || session?.status === 'awaiting_permission'
  const config = session?.config ?? []
  const mode = slotOf(config, 'mode', running)

  const set = (option: ConfigOption, value: string | boolean) => {
    if (value === option.value || !link) return
    setSetting(option.id)
    link
      .request('sessions.setConfigOption', { sessionId, optionId: option.id, value })
      .catch((error: unknown) => Alert.alert(`没能更改${option.name}`, hostErrorText(error)))
      .finally(() => setSetting(null))
  }

  return {
    control: { config, running, set },
    mode: mode ? { ...mode, look: modeLook(String(mode.option.value)) } : null,
    model: slotOf(config, 'model', running),
    effort: slotOf(config, 'thought_level', running),
    harness: session ? agent?.harnessId : undefined,
    setting,
    connected,
  }
}

/**
 * The permission mode as a round button with its icon, or as a pill with its name too, as New
 * session shows it; a mode with full access in red.
 */
export function ModeButton(props: {
  mode: (ConfigSlot & { look: ModeLook }) | null
  busy: boolean
  disabled: boolean
  onPress(): void
  anchor: RefObject<ViewHandle | null>
  labelled?: boolean
}) {
  const { c } = useSessionTokens()
  const { mode } = props
  if (!mode) return null
  const full = mode.look === 'full'
  // Full access is a choice, not a fault: a red shield on the usual fill, never an alarm.
  const color = full ? c.danger : c.textSecondary
  const icon = props.busy ? (
    <ActivityIndicator size="small" color={c.textSecondary} />
  ) : (
    <Icon
      icon={MODE_ICON[mode.look]}
      size={18}
      color={color}
      weight={full ? 'semibold' : undefined}
    />
  )
  return (
    <View ref={props.anchor} collapsable={false} style={props.labelled ? styles.modeOuter : null}>
      {props.labelled ? (
        <PressScale
          onPress={props.onPress}
          disabled={props.disabled}
          accessibilityRole="button"
          accessibilityLabel={`权限模式：${mode.name}`}
          style={[
            styles.modePill,
            {
              backgroundColor: c.fill,
              opacity: props.disabled ? 0.38 : mode.locked ? 0.5 : 1,
            },
          ]}
        >
          {icon}
          <Text style={[styles.modeText, { color: full ? c.danger : c.text }]} numberOfLines={1}>
            {MODE_SHORT[mode.look]}
          </Text>
        </PressScale>
      ) : (
        <RoundButton
          onPress={props.onPress}
          disabled={props.disabled}
          accessibilityLabel={`权限模式：${mode.name}`}
          style={mode.locked ? { opacity: 0.5 } : null}
        >
          {icon}
        </RoundButton>
      )}
    </View>
  )
}

/** The model chip: the agent's mark, its model and effort, opening the model menu. */
export function ModelChip(props: {
  agentId: string
  harness: HarnessId | undefined
  model: string | null
  effort: string | null
  /** The agent a switch hands the session to with the next message, named in place of the model. */
  pending?: string | null
  busy: boolean
  disabled: boolean
  onPress(): void
  anchor: RefObject<ViewHandle | null>
}) {
  const { c } = useSessionTokens()
  const label = props.pending ?? props.model ?? ''
  return (
    <View ref={props.anchor} collapsable={false} style={styles.chipOuter}>
      <PressScale
        scale={0.96}
        onPress={props.onPress}
        disabled={props.disabled}
        accessibilityRole="button"
        accessibilityLabel={
          props.pending
            ? `下一条消息交给 ${props.pending}`
            : `模型：${props.model ?? ''}${props.effort ? `，思考强度：${props.effort}` : ''}`
        }
        style={[styles.chip, { opacity: props.disabled ? 0.5 : 1 }]}
      >
        <AgentGlyph agentId={props.agentId} harness={props.harness} size={17} />
        <Text style={[styles.chipText, { color: c.text }]} numberOfLines={1}>
          {label}
          {props.pending ? (
            <Text style={{ color: c.textSecondary, fontWeight: '400' }}> · 下条消息起</Text>
          ) : props.effort ? (
            <Text style={{ color: c.textSecondary, fontWeight: '400' }}>
              {label ? ' · ' : ''}
              {props.effort}
            </Text>
          ) : null}
        </Text>
        {props.busy ? (
          <ActivityIndicator size="small" color={c.textSecondary} />
        ) : (
          <Icon icon={G.upDown} size={11} color={c.textTertiary} weight="semibold" />
        )}
      </PressScale>
    </View>
  )
}

/**
 * The messages queued behind the running turn, numbered in the order they go. Each can go now
 * while a turn runs (into the turn where the agent takes that, else stopping it first, which is
 * asked), come back to the box to edit, attachments and all, or be removed with its attachments.
 * Its heading folds the list to one line, so a long queue never fills the screen: open or folded
 * as last chosen, else open for a single message; always folded while the keyboard is up, unless
 * opened then.
 */
export function QueueStack(props: {
  sessionId: string
  session: SessionView | undefined
  /** Puts a taken-back message in the composer. */
  onEdit(content: UserContent[]): void
}) {
  const { c, s } = useSessionTokens()
  const link = useMaybeLink()
  const connected = useConnected()
  const agent = useAgent(props.session?.agentId)
  const [busyItem, setBusyItem] = useState<string | null>(null)
  const chosen = usePrefs().queueOpen
  const keyboardUp = useKeyboardState((state) => state.isVisible)
  // Opened or closed while the keyboard is up, for as long as it stays.
  const [typing, setTyping] = useState<{ open: boolean } | null>(null)
  const [wasUp, setWasUp] = useState(keyboardUp)
  if (wasUp !== keyboardUp) {
    setWasUp(keyboardUp)
    setTyping(null)
  }
  const session = props.session
  if (!session || !link || session.queue.length === 0) return null
  const sessionId = props.sessionId
  const running = session.status === 'running' || session.status === 'awaiting_permission'
  const steering = !!agent?.capabilities.steering
  const count = session.queue.length
  const open = keyboardUp ? (typing?.open ?? false) : (chosen ?? count === 1)
  const toggle = () => {
    if (keyboardUp) setTyping({ open: !open })
    else setPrefs({ queueOpen: !open })
  }
  const first = session.queue[0]!
  const firstText =
    promptText(first) || (attachmentCount(first) > 0 ? `${attachmentCount(first)} 个附件` : '')
  const note = session.queuePaused ? '已暂停' : open ? (running ? '本轮结束后发送' : '') : firstText

  const act = (item: QueuedPrompt, work: () => Promise<unknown>, failed: string) => {
    haptic.tap()
    setBusyItem(item.id)
    work()
      .catch((error: unknown) => Alert.alert(failed, hostErrorText(error)))
      .finally(() => setBusyItem(null))
  }

  // One tap sends, as the desktop's queue does: the button says what it does, and its hint that
  // the turn stops first, so a second confirmation only made it take two taps.
  const sendNow = (item: QueuedPrompt) =>
    act(
      item,
      () => link.request('sessions.sendNow', { sessionId, itemId: item.id }),
      '没能立即发送',
    )

  const edit = (item: QueuedPrompt) =>
    act(
      item,
      () =>
        link
          .request('sessions.unqueue', { sessionId, itemId: item.id })
          .then(() => props.onEdit(item.content)),
      '没能撤回',
    )

  const remove = (item: QueuedPrompt) =>
    act(
      item,
      () =>
        link
          .request('sessions.unqueue', { sessionId, itemId: item.id })
          .then(() =>
            Promise.all(
              item.content.flatMap((part) =>
                part.type === 'ref' && part.ref.kind === 'attachment'
                  ? [link.request('attachments.remove', { id: part.ref.attachment.id })]
                  : [],
              ),
            ),
          ),
      '没能移除',
    )

  const resume = () => {
    link
      .request('sessions.resumeQueue', { sessionId })
      .catch((error: unknown) => Alert.alert('没能继续发送', hostErrorText(error)))
  }

  return (
    <Reanimated.View
      layout={QUEUE_FOLD}
      style={styles.queue}
      accessibilityLabel={`排队中的消息：${count} 条`}
    >
      <View style={styles.queueHead}>
        <Pressable
          onPress={toggle}
          hitSlop={{ top: 8, bottom: 8 }}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={`${count} 条排队`}
          accessibilityHint={open ? '收起队列' : '展开队列'}
          style={({ pressed }) => [styles.queueToggle, { opacity: pressed ? 0.6 : 1 }]}
        >
          <View style={[styles.chevron, { transform: [{ rotate: open ? '90deg' : '0deg' }] }]}>
            <Icon icon={G.right} size={11} color={c.textTertiary} weight="semibold" />
          </View>
          <Text style={[styles.queueTitle, { color: c.textSecondary }]} numberOfLines={1}>
            {count} 条排队
            {note ? (
              <Text style={{ color: c.textTertiary, fontWeight: '400' }}> · {note}</Text>
            ) : null}
          </Text>
        </Pressable>
        {session.queuePaused && (
          <Pressable onPress={resume} hitSlop={8} disabled={!connected} accessibilityRole="button">
            <Text style={[styles.action, { color: c.accent }]}>继续</Text>
          </Pressable>
        )}
      </View>
      {(open ? session.queue : []).map((item, index) => {
        const text = promptText(item)
        const attachments = attachmentCount(item)
        const disabled = !connected || busyItem !== null
        const action = (
          label: string,
          onPress: () => void,
          options: { strong?: boolean; hint?: string; danger?: boolean } = {},
        ) => (
          <PressScale
            onPress={onPress}
            disabled={disabled}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel={label}
            {...(options.hint ? { accessibilityHint: options.hint } : {})}
            style={[
              styles.actionPill,
              {
                backgroundColor: options.strong ? s.accentSoft : c.fill,
                opacity: disabled ? 0.5 : 1,
              },
            ]}
          >
            <Text
              style={[
                styles.action,
                { color: options.strong ? c.accent : options.danger ? c.danger : c.text },
              ]}
            >
              {label}
            </Text>
          </PressScale>
        )
        const from = item.device
          ? `来自 ${item.device.name}`
          : item.from
            ? `来自「${item.from.title}」`
            : null
        return (
          <Reanimated.View
            entering={QUEUE_IN}
            exiting={QUEUE_OUT}
            layout={QUEUE_MOVE}
            key={item.id}
            style={[styles.queued, { backgroundColor: s.dockCard, borderColor: c.border }]}
          >
            <View style={styles.queuedHead}>
              <View
                style={[styles.number, { backgroundColor: c.fill }]}
                accessibilityLabel={`${index + 1} / ${count}`}
              >
                <Text style={[styles.numberText, { color: c.textSecondary }]}>{index + 1}</Text>
              </View>
              <Text style={[styles.queuedText, { color: c.text }]} numberOfLines={2}>
                {text || (attachments > 0 ? '' : '附件')}
                {attachments > 0 && (
                  <Text style={{ color: c.textSecondary }}>
                    {text ? ' · ' : ''}
                    {attachments} 个附件
                  </Text>
                )}
              </Text>
            </View>
            {from && (
              <Text style={[styles.from, { color: c.textTertiary }]} numberOfLines={1}>
                {from}
              </Text>
            )}
            <View style={styles.queuedFoot}>
              {busyItem === item.id ? (
                <ActivityIndicator size="small" color={c.textSecondary} />
              ) : (
                <>
                  {action('移除', () => remove(item), { danger: true })}
                  {action('在输入框中编辑', () => edit(item))}
                  {running &&
                    action('立即发送', () => sendNow(item), {
                      strong: true,
                      hint: steering ? '立即插入当前对话' : '停止本轮，接着发送这条消息',
                    })}
                </>
              )}
            </View>
          </Reanimated.View>
        )
      })}
    </Reanimated.View>
  )
}

// Queued messages come, go and close up on UIKit-like springs, on the UI thread.
const QUEUE_IN = FadeIn.duration(220)
const QUEUE_OUT = FadeOut.duration(160)
const QUEUE_MOVE = LinearTransition.springify().dampingRatio(0.84).duration(400)
// The list folding to its heading and back: a disclosure, so it is short and plain.
const QUEUE_FOLD = LinearTransition.duration(220).easing(Easing.out(Easing.cubic))

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 10,
    height: 40,
    maxWidth: '100%',
  },
  chipOuter: { flexShrink: 1, minWidth: 0 },
  modeOuter: { flexShrink: 1, minWidth: 40 },
  modePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 40,
    borderRadius: 20,
    paddingHorizontal: 12,
    maxWidth: 140,
    overflow: 'hidden',
  },
  modeText: { fontSize: 15, fontWeight: '500', flexShrink: 1 },
  chipText: { fontSize: 15, fontWeight: '600', flexShrink: 1 },
  queue: { gap: 8 },
  queueHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  queueToggle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 28 },
  chevron: { width: 12, alignItems: 'center' },
  queueTitle: { flex: 1, fontSize: 13, fontWeight: '600' },
  queued: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, padding: 12, gap: 8 },
  queuedHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  number: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -1,
  },
  numberText: { fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  queuedText: { flex: 1, fontSize: 15, lineHeight: 21 },
  queuedFoot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8 },
  from: { fontSize: 12, paddingLeft: 32 },
  actionPill: { borderRadius: 999, paddingHorizontal: 12, height: 30, justifyContent: 'center' },
  action: { fontSize: 13, fontWeight: '600' },
})
