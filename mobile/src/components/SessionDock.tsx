// What sits around a session's composer: the messages queued behind the running turn, each to take
// back, steer in or send now; and the session's permission mode, model and effort as the agent
// reports them, each to change from the composer's own row.

import { useState, type ReactNode } from 'react'
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import type { ConfigOption, QueuedPrompt, SessionView } from '@shared/thread'
import { isFullAccessMode, type HarnessId } from '@shared/agents'
import { useHost } from '../host'
import { errorText } from '../sessions'
import { haptic } from '../ui/session/feedback'
import { AgentMark, G, Icon } from '../ui/session/icons'
import { useSessionTokens } from '../ui/session/palette'
import { PressScale, RoundButton } from '../ui/session/Press'
import { Sheet, type SheetItem } from './Sheet'

type Choice = NonNullable<ConfigOption['choices']>[number]
type Picked = 'model' | 'mode' | 'thought_level'

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

/** The choice that stands for the value: an alias shows as the choice it names. */
function shownChoice(option: ConfigOption): Choice | undefined {
  const choices = option.choices ?? []
  const own = choices.find((c) => c.value === option.value)
  return (own?.shownAs ? choices.find((c) => c.value === own.shownAs) : undefined) ?? own
}

function selectOf(config: ConfigOption[], category: Picked): ConfigOption | undefined {
  return config.find((o) => o.category === category && o.type === 'select' && !!o.choices?.length)
}

export interface ConfigSlot {
  option: ConfigOption
  name: string
  /** Changeable only between turns, and a turn runs. */
  locked: boolean
}

export interface SessionConfig {
  mode: (ConfigSlot & { full: boolean }) | null
  model: ConfigSlot | null
  effort: ConfigSlot | null
  harness: HarnessId | undefined
  /** The option being changed. */
  setting: string | null
  connected: boolean
  openMode(): void
  openModel(): void
  /** The pickers; put it anywhere in the screen. */
  element: ReactNode
}

export function useSessionConfig(
  sessionId: string,
  session: SessionView | undefined,
): SessionConfig {
  const { link, agents, state } = useHost()
  const [picking, setPicking] = useState<'mode' | 'model' | null>(null)
  const [setting, setSetting] = useState<string | null>(null)
  const connected = state.kind === 'connected'
  const running = session?.status === 'running' || session?.status === 'awaiting_permission'
  const slot = (category: Picked): ConfigSlot | null => {
    const option = session ? selectOf(session.config, category) : undefined
    if (!option) return null
    return {
      option,
      name: shownChoice(option)?.name ?? String(option.value),
      locked: !!option.idleOnly && running,
    }
  }
  const mode = slot('mode')
  const model = slot('model')
  const effort = slot('thought_level')

  const setOption = (option: ConfigOption, value: string) => {
    if (value === option.value || !link) return
    haptic.pick()
    setSetting(option.id)
    link
      .request('sessions.setConfigOption', { sessionId, optionId: option.id, value })
      .catch((error: unknown) => Alert.alert(`没能更改${option.name}`, errorText(error)))
      .finally(() => setSetting(null))
  }

  const itemsOf = (slotted: ConfigSlot, heading: string | null): SheetItem[] => {
    const { option } = slotted
    const shown = shownChoice(option)?.value
    const listed = (option.choices ?? []).filter((c) => !c.shownAs)
    const ordered = [...listed.filter((c) => !c.older), ...listed.filter((c) => c.older)]
    return ordered.map((c, index) => ({
      key: `${option.id}:${c.value}`,
      label: c.name,
      ...(c.description ? { detail: c.description } : {}),
      checked: c.value === shown,
      disabled: slotted.locked,
      destructive: option.category === 'mode' && isFullAccessMode(c.value),
      ...(index === 0 && heading
        ? { section: slotted.locked ? `${heading}（这一轮结束后才能改）` : heading }
        : c.older && !ordered[index - 1]?.older
          ? { section: '更早的版本' }
          : {}),
      onPress: () => setOption(option, c.value),
    }))
  }

  const open = (which: 'mode' | 'model') => {
    const target = which === 'mode' ? mode : (model ?? effort)
    if (!target) return
    if (which === 'mode' && target.locked) {
      Alert.alert('权限模式要等这一轮结束才能改')
      return
    }
    haptic.pick()
    setPicking(which)
  }

  const sheetItems: SheetItem[] =
    picking === 'mode' && mode
      ? itemsOf(mode, null)
      : picking === 'model'
        ? [
            ...(model ? itemsOf(model, effort ? '模型' : null) : []),
            ...(effort ? itemsOf(effort, '思考强度') : []),
          ]
        : []

  const element = (
    <Sheet
      visible={picking !== null && sheetItems.length > 0}
      title={picking === 'mode' ? '权限模式' : model ? '模型' : '思考强度'}
      {...(picking === 'mode' && mode?.option.description
        ? { message: mode.option.description }
        : {})}
      items={sheetItems}
      onClose={() => setPicking(null)}
    />
  )

  return {
    mode: mode ? { ...mode, full: isFullAccessMode(String(mode.option.value)) } : null,
    model,
    effort,
    harness: session ? agents.get(session.agentId)?.harnessId : undefined,
    setting,
    connected,
    openMode: () => open('mode'),
    openModel: () => open('model'),
    element,
  }
}

/** The permission mode as a round button: a shield, or a warning for a mode with full access. */
export function ModeButton(props: { config: SessionConfig }) {
  const { c } = useSessionTokens()
  const { mode, setting, connected } = props.config
  if (!mode) return null
  return (
    <RoundButton
      tone={mode.full ? 'warning' : 'fill'}
      onPress={props.config.openMode}
      disabled={!connected || setting !== null}
      accessibilityLabel={`权限模式：${mode.name}`}
      style={mode.locked ? { opacity: 0.5 } : null}
    >
      {setting === mode.option.id ? (
        <ActivityIndicator size="small" color={c.textSecondary} />
      ) : (
        <Icon
          icon={mode.full ? G.warning : G.shieldCheck}
          size={18}
          color={mode.full ? c.warning : c.textSecondary}
        />
      )}
    </RoundButton>
  )
}

/** The model chip: the agent's mark, its model and effort, opening the pickers. */
export function ModelChip(props: { config: SessionConfig }) {
  const { c } = useSessionTokens()
  const { model, effort, setting, connected, harness } = props.config
  if (!model && !effort) return null
  const busy = setting !== null && (setting === model?.option.id || setting === effort?.option.id)
  return (
    <PressScale
      scale={0.96}
      onPress={props.config.openModel}
      disabled={!connected || setting !== null}
      accessibilityRole="button"
      accessibilityLabel={`模型：${model?.name ?? ''}${effort ? `，思考强度：${effort.name}` : ''}`}
      outerStyle={styles.chipOuter}
      style={[styles.chip, { opacity: connected ? 1 : 0.5 }]}
    >
      <AgentMark harness={harness} size={17} />
      <Text style={[styles.chipText, { color: c.text }]} numberOfLines={1}>
        {model?.name ?? ''}
        {effort ? (
          <Text style={{ color: c.textSecondary, fontWeight: '400' }}>
            {model ? ' ' : ''}
            {effort.name}
          </Text>
        ) : null}
      </Text>
      {busy ? (
        <ActivityIndicator size="small" color={c.textSecondary} />
      ) : (
        <Icon icon={G.upDown} size={11} color={c.textTertiary} weight="semibold" />
      )}
    </PressScale>
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
