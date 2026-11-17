// What sits above a session's composer: the messages queued behind the running turn, each to take
// back, steer in or send now, and the session's model, permission mode and effort as the agent
// reports them, each to change.

import { useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import type { ConfigOption, QueuedPrompt, SessionView } from '@shared/thread'
import { isFullAccessMode } from '@shared/agents'
import { useHost } from '../host'
import { errorText } from '../sessions'
import { useTheme, type Theme } from '../theme'
import { Sheet, type SheetItem } from './Sheet'

type Choice = NonNullable<ConfigOption['choices']>[number]
type Picked = 'model' | 'mode' | 'thought_level'

const PICKED: Picked[] = ['model', 'mode', 'thought_level']
const HEADINGS: Record<Picked, string> = {
  model: '模型',
  mode: '权限模式',
  thought_level: '思考强度',
}

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

export function SessionDock(props: { sessionId: string; session: SessionView | undefined }) {
  const theme = useTheme()
  const { link, agents, state } = useHost()
  const [picking, setPicking] = useState<Picked | null>(null)
  const [setting, setSetting] = useState<string | null>(null)
  const [busyItem, setBusyItem] = useState<string | null>(null)
  const session = props.session
  if (!session || !link) return null

  const sessionId = props.sessionId
  const connected = state.kind === 'connected'
  const running = session.status === 'running' || session.status === 'awaiting_permission'
  const steering = !!agents.get(session.agentId)?.capabilities.steering
  const options = PICKED.flatMap((category) => {
    const option = selectOf(session.config, category)
    return option ? [{ category, option }] : []
  })
  if (options.length === 0 && session.queue.length === 0) return null

  const setOption = (option: ConfigOption, value: string) => {
    if (value === option.value) return
    setSetting(option.id)
    link
      .request('sessions.setConfigOption', { sessionId, optionId: option.id, value })
      .catch((error: unknown) => Alert.alert(`没能更改${option.name}`, errorText(error)))
      .finally(() => setSetting(null))
  }

  const queueAction = (
    item: QueuedPrompt,
    method: 'sessions.unqueue' | 'sessions.steer' | 'sessions.sendNow',
    failed: string,
  ) => {
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

  const picked = picking ? options.find((o) => o.category === picking)?.option : undefined
  const sheetItems = (option: ConfigOption): SheetItem[] => {
    const shown = shownChoice(option)?.value
    const listed = (option.choices ?? []).filter((c) => !c.shownAs)
    const ordered = [...listed.filter((c) => !c.older), ...listed.filter((c) => c.older)]
    return ordered.map((c, index) => ({
      key: c.value,
      label: c.name,
      ...(c.description ? { detail: c.description } : {}),
      checked: c.value === shown,
      destructive: option.category === 'mode' && isFullAccessMode(c.value),
      ...(c.older && !ordered[index - 1]?.older ? { section: '更早的版本' } : {}),
      onPress: () => setOption(option, c.value),
    }))
  }

  return (
    <View style={[styles.dock, { borderTopColor: theme.line }]}>
      {session.queue.length > 0 && (
        <ScrollView style={{ maxHeight: 200 }} contentContainerStyle={{ gap: 6 }}>
          <View style={styles.queueHead}>
            <Text style={{ color: theme.muted, fontSize: 12, flex: 1 }}>
              排队中 {session.queue.length} 条
              {session.queuePaused ? ' · 已暂停' : running ? ' · 本轮结束后发送' : ''}
            </Text>
            {session.queuePaused && (
              <Pressable onPress={resume} hitSlop={8} disabled={!connected}>
                <Text style={{ color: theme.accent, fontSize: 12, fontWeight: '600' }}>
                  继续发送
                </Text>
              </Pressable>
            )}
          </View>
          {session.queue.map((item) => (
            <QueuedRow
              key={item.id}
              item={item}
              theme={theme}
              busy={busyItem === item.id}
              disabled={!connected || busyItem !== null}
              canSteer={running && steering}
              canSendNow={running || session.queuePaused}
              onUnqueue={() => queueAction(item, 'sessions.unqueue', '没能撤回')}
              onSteer={() => queueAction(item, 'sessions.steer', '没能插话')}
              onSendNow={() => queueAction(item, 'sessions.sendNow', '没能立即发送')}
            />
          ))}
        </ScrollView>
      )}

      {options.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
          keyboardShouldPersistTaps="handled"
        >
          {options.map(({ category, option }) => {
            const locked = !!option.idleOnly && running
            const choice = shownChoice(option)
            const full = category === 'mode' && isFullAccessMode(String(option.value))
            return (
              <Pressable
                key={option.id}
                disabled={!connected || setting !== null}
                onPress={() =>
                  locked
                    ? Alert.alert(`${HEADINGS[category]}要等这一轮结束才能改`)
                    : setPicking(category)
                }
                style={({ pressed }) => [
                  styles.chip,
                  {
                    borderColor: full ? theme.danger : theme.line,
                    opacity: !connected || locked ? 0.5 : pressed ? 0.7 : 1,
                  },
                ]}
              >
                {setting === option.id ? (
                  <ActivityIndicator size="small" color={theme.accent} />
                ) : (
                  <Text
                    style={{ color: full ? theme.danger : theme.text, fontSize: 12 }}
                    numberOfLines={1}
                  >
                    {category === 'thought_level' ? '思考 · ' : ''}
                    {choice?.name ?? String(option.value)} ▾
                  </Text>
                )}
              </Pressable>
            )
          })}
        </ScrollView>
      )}

      <Sheet
        visible={picked !== undefined}
        title={picking ? HEADINGS[picking] : undefined}
        {...(picked?.description ? { message: picked.description } : {})}
        items={picked ? sheetItems(picked) : []}
        onClose={() => setPicking(null)}
      />
    </View>
  )
}

function QueuedRow(props: {
  item: QueuedPrompt
  theme: Theme
  busy: boolean
  disabled: boolean
  canSteer: boolean
  canSendNow: boolean
  onUnqueue(): void
  onSteer(): void
  onSendNow(): void
}) {
  const { item, theme } = props
  const text = promptText(item)
  const attachments = attachmentCount(item)
  const action = (label: string, onPress: () => void, strong = false) => (
    <Pressable onPress={onPress} disabled={props.disabled} hitSlop={6}>
      <Text
        style={{
          color: strong ? theme.accent : theme.muted,
          fontSize: 13,
          fontWeight: strong ? '600' : '400',
          opacity: props.disabled ? 0.5 : 1,
        }}
      >
        {label}
      </Text>
    </Pressable>
  )
  return (
    <View style={[styles.queued, { backgroundColor: theme.card, borderColor: theme.line }]}>
      <Text style={{ color: theme.text, fontSize: 14 }} numberOfLines={2}>
        {text || (attachments > 0 ? '' : '（空消息）')}
        {attachments > 0 && (
          <Text style={{ color: theme.muted }}>
            {text ? ' · ' : ''}
            {attachments} 个附件
          </Text>
        )}
      </Text>
      <View style={styles.queuedFoot}>
        <Text style={{ color: theme.muted, fontSize: 11, flex: 1 }} numberOfLines={1}>
          {item.device ? `来自 ${item.device.name}` : item.from ? `来自「${item.from.title}」` : ''}
        </Text>
        {props.busy ? (
          <ActivityIndicator size="small" color={theme.accent} />
        ) : (
          <>
            {action('撤回', props.onUnqueue)}
            {props.canSteer && action('插话', props.onSteer)}
            {props.canSendNow && action('立即发送', props.onSendNow, true)}
          </>
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  dock: { paddingHorizontal: 12, paddingTop: 8, gap: 8, borderTopWidth: StyleSheet.hairlineWidth },
  queueHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  queued: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 10, gap: 6 },
  queuedFoot: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  chips: { gap: 6, paddingBottom: 2 },
  chip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    minHeight: 26,
    justifyContent: 'center',
  },
})
