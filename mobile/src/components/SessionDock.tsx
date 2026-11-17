// What sits around a session's composer: the messages queued behind the running turn, each to take
// back, steer in or send now; and the session's permission mode, model and effort as the agent
// reports them, each a button of the composer's own row that opens its menu.

import { useState, type RefObject } from 'react'
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import type { ConfigOption, QueuedPrompt, SessionView } from '@shared/thread'
import type { HarnessId } from '@shared/agents'
import { useHost } from '../host'
import { errorText } from '../sessions'
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
  const name = shownChoice(option)?.name ?? String(option.value)
  return {
    option,
    name: category === 'model' ? modelName(name) : name,
    locked: !!option.idleOnly && running,
  }
}

export function useSessionConfig(
  sessionId: string,
  session: SessionView | undefined,
): SessionConfig {
  const { link, agents, state } = useHost()
  const [setting, setSetting] = useState<string | null>(null)
  const connected = state.kind === 'connected'
  const running = session?.status === 'running' || session?.status === 'awaiting_permission'
  const config = session?.config ?? []
  const mode = slotOf(config, 'mode', running)

  const set = (option: ConfigOption, value: string | boolean) => {
    if (value === option.value || !link) return
    setSetting(option.id)
    link
      .request('sessions.setConfigOption', { sessionId, optionId: option.id, value })
      .catch((error: unknown) => Alert.alert(`没能更改${option.name}`, errorText(error)))
      .finally(() => setSetting(null))
  }

  return {
    control: { config, running, set },
    mode: mode ? { ...mode, look: modeLook(String(mode.option.value)) } : null,
    model: slotOf(config, 'model', running),
    effort: slotOf(config, 'thought_level', running),
    harness: session ? agents.get(session.agentId)?.harnessId : undefined,
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
  const { c, s } = useSessionTokens()
  const { mode } = props
  if (!mode) return null
  const full = mode.look === 'full'
  const color = full ? c.danger : c.textSecondary
  const icon = props.busy ? (
    <ActivityIndicator size="small" color={c.textSecondary} />
  ) : (
    <Icon icon={MODE_ICON[mode.look]} size={18} color={color} />
  )
  return (
    <View ref={props.anchor} collapsable={false}>
      {props.labelled ? (
        <PressScale
          scale={0.96}
          onPress={props.onPress}
          disabled={props.disabled}
          accessibilityRole="button"
          accessibilityLabel={`权限模式：${mode.name}`}
          style={[
            styles.modePill,
            {
              backgroundColor: full ? s.dangerSoft : c.fill,
              opacity: props.disabled ? 0.38 : mode.locked ? 0.5 : 1,
            },
          ]}
        >
          {icon}
          <Text style={[styles.modeText, { color: full ? c.danger : c.text }]} numberOfLines={1}>
            {mode.name}
          </Text>
        </PressScale>
      ) : (
        <RoundButton
          tone={full ? 'warning' : 'fill'}
          onPress={props.onPress}
          disabled={props.disabled}
          accessibilityLabel={`权限模式：${mode.name}`}
          style={[
            full ? { backgroundColor: s.dangerSoft } : null,
            mode.locked ? { opacity: 0.5 } : null,
          ]}
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
              {label ? ' ' : ''}
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

/** The messages queued behind the running turn, newest last. */
export function QueueStack(props: { sessionId: string; session: SessionView | undefined }) {
  const { c, s } = useSessionTokens()
  const { link, agents, state } = useHost()
  const [busyItem, setBusyItem] = useState<string | null>(null)
  const session = props.session
  if (!session || !link || session.queue.length === 0) return null
  const sessionId = props.sessionId
  const connected = state.kind === 'connected'
  const running = session.status === 'running' || session.status === 'awaiting_permission'
  const steering = !!agents.get(session.agentId)?.capabilities.steering

  const queueAction = (
    item: QueuedPrompt,
    method: 'sessions.unqueue' | 'sessions.steer' | 'sessions.sendNow',
    failed: string,
  ) => {
    haptic.tap()
    setBusyItem(item.id)
    link
      .request(method, { sessionId, itemId: item.id })
      .catch((error: unknown) => Alert.alert(failed, errorText(error)))
      .finally(() => setBusyItem(null))
  }

  const resume = () => {
    link
      .request('sessions.resumeQueue', { sessionId })
      .catch((error: unknown) => Alert.alert('没能继续发送', errorText(error)))
  }

  return (
    <View style={styles.queue}>
      <View style={styles.queueHead}>
        <Text style={[styles.queueTitle, { color: c.textSecondary }]}>
          排队中 {session.queue.length} 条
          <Text style={{ color: c.textTertiary, fontWeight: '400' }}>
            {session.queuePaused ? ' · 已暂停' : running ? ' · 本轮结束后发送' : ''}
          </Text>
        </Text>
        {session.queuePaused && (
          <Pressable onPress={resume} hitSlop={8} disabled={!connected}>
            <Text style={[styles.action, { color: c.accent }]}>继续发送</Text>
          </Pressable>
        )}
      </View>
      {session.queue.map((item) => {
        const text = promptText(item)
        const attachments = attachmentCount(item)
        const disabled = !connected || busyItem !== null
        const action = (label: string, onPress: () => void, strong = false) => (
          <PressScale
            onPress={onPress}
            disabled={disabled}
            hitSlop={6}
            style={[
              styles.actionPill,
              { backgroundColor: strong ? s.accentSoft : c.fill, opacity: disabled ? 0.5 : 1 },
            ]}
          >
            <Text style={[styles.action, { color: strong ? c.accent : c.text }]}>{label}</Text>
          </PressScale>
        )
        return (
          <View
            key={item.id}
            style={[styles.queued, { backgroundColor: s.dockCard, borderColor: c.border }]}
          >
            <Text style={[styles.queuedText, { color: c.text }]} numberOfLines={2}>
              {text || (attachments > 0 ? '' : '（空消息）')}
              {attachments > 0 && (
                <Text style={{ color: c.textSecondary }}>
                  {text ? ' · ' : ''}
                  {attachments} 个附件
                </Text>
              )}
            </Text>
            <View style={styles.queuedFoot}>
              <Text style={[styles.from, { color: c.textTertiary }]} numberOfLines={1}>
                {item.device
                  ? `来自 ${item.device.name}`
                  : item.from
                    ? `来自「${item.from.title}」`
                    : ''}
              </Text>
              {busyItem === item.id ? (
                <ActivityIndicator size="small" color={c.textSecondary} />
              ) : (
                <>
                  {action('撤回', () => queueAction(item, 'sessions.unqueue', '没能撤回'))}
                  {running &&
                    steering &&
                    action('插话', () => queueAction(item, 'sessions.steer', '没能插话'))}
                  {(running || session.queuePaused) &&
                    action(
                      '立即发送',
                      () => queueAction(item, 'sessions.sendNow', '没能立即发送'),
                      true,
                    )}
                </>
              )}
            </View>
          </View>
        )
      })}
    </View>
  )
}

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
  modePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    height: 40,
    borderRadius: 20,
    paddingHorizontal: 13,
    maxWidth: 200,
  },
  modeText: { fontSize: 15, fontWeight: '500', flexShrink: 1 },
  chipText: { fontSize: 15, fontWeight: '600', flexShrink: 1 },
  queue: { gap: 8 },
  queueHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  queueTitle: { flex: 1, fontSize: 13, fontWeight: '600' },
  queued: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, padding: 12, gap: 10 },
  queuedText: { fontSize: 15, lineHeight: 21 },
  queuedFoot: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  from: { flex: 1, fontSize: 12 },
  actionPill: { borderRadius: 999, paddingHorizontal: 12, height: 30, justifyContent: 'center' },
  action: { fontSize: 13, fontWeight: '600' },
})
