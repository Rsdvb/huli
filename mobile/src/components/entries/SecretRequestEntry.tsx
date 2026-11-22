// An agent's request for secrets, as the desktop's card asks it: labelled fields, each hidden
// until the user shows it, the values going straight to the computer and from there where the
// card says. The thread keeps the variable names alone, never a value.

import { useState } from 'react'
import { Linking, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { Eye, EyeOff } from 'lucide-react-native'
import {
  dotenvLine,
  MAX_SECRET_VALUE,
  secretValueProblem,
  type SecretField,
} from '@shared/secret-request'
import type { ThreadEntry } from '@shared/thread'
import { call } from '../../git'
import { useLink } from '../../host'
import { haptic } from '../../ui/session/feedback'
import { Icon, type IconSpec } from '../../ui/session/icons'
import { MONO, useSessionTokens } from '../../ui/session/palette'
import { useAgentName, type Place } from './AccessEntries'
import { AskCard, E, kit, QuietLine, useSender, WaitingLine } from './kit'

type Entry = Extract<ThreadEntry, { kind: 'secret_request' }>

const EYE: IconSpec = { sf: 'eye', lucide: Eye }
const EYE_OFF: IconSpec = { sf: 'eye.slash', lucide: EyeOff }

/** Whether the card still waits: unanswered and not past the time it counts as declined. */
export function secretWaits(entry: Entry, now = Date.now()): boolean {
  return entry.outcome === null && now < entry.expiresAt
}

function fieldError(field: SecretField, value: string, saved: boolean, toFile: boolean) {
  if (value.trim() === '') return saved || field.optional ? null : '必填'
  const problem = secretValueProblem(value)
  if (problem === 'long') return `最多 ${MAX_SECRET_VALUE} 个字符`
  if (problem === 'line') return '只能是一行'
  if (toFile && dotenvLine(field.name, value.trim()) === null)
    return '这个值含有 .env 文件存不下的字符'
  return null
}

function outcomeText(entry: Entry): { text: string; detail: string | null; done: boolean } {
  const outcome = entry.outcome!
  const device = entry.device ? `在 ${entry.device.name} 上回答` : null
  if (outcome.kind === 'provided') {
    const names = outcome.names.join('、')
    const text =
      entry.target.kind === 'file'
        ? `已把 ${names} 写入 ${entry.target.path}`
        : `已把 ${names} 交给本会话的命令`
    return {
      text,
      detail: [outcome.saved ? '已加密保存' : null, device].filter(Boolean).join(' · ') || null,
      done: true,
    }
  }
  const why =
    outcome.kind === 'expired'
      ? '10 分钟没有回答'
      : outcome.kind === 'ended'
        ? '回合先结束了'
        : outcome.kind === 'failed'
          ? outcome.message
          : null
  return {
    text: `没有提供 ${entry.title}`,
    detail: [why, device].filter(Boolean).join(' · ') || null,
    done: false,
  }
}

export function SecretRequestEntry(props: { entry: Entry; sessionId: string; place: Place }) {
  const { entry } = props
  if (entry.outcome !== null) {
    const { text, detail, done } = outcomeText(entry)
    return <QuietLine icon={E.key} tone={done ? 'done' : 'other'} text={text} detail={detail} />
  }
  if (props.place === 'thread')
    return <WaitingLine icon={E.key} text={`需要你提供 ${entry.title}`} />
  return <SecretCard entry={entry} sessionId={props.sessionId} />
}

function SecretCard(props: { entry: Entry; sessionId: string }) {
  const { entry, sessionId } = props
  const { c } = useSessionTokens()
  const link = useLink()
  const agent = useAgentName(sessionId)
  const sender = useSender(entry.id)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set())
  const [save, setSave] = useState(entry.saved.length > 0)
  const [tried, setTried] = useState(false)
  const saved = new Set(entry.saved)
  const toFile = entry.target.kind === 'file'
  const errors = entry.fields.map((field) =>
    fieldError(field, draft[field.name] ?? '', saved.has(field.name), toFile),
  )

  const provide = async () => {
    setTried(true)
    if (errors.some((e) => e !== null)) return false
    const values: Record<string, string> = {}
    const useSaved: string[] = []
    for (const field of entry.fields) {
      const value = (draft[field.name] ?? '').trim()
      if (value !== '') values[field.name] = value
      else if (saved.has(field.name)) useSaved.push(field.name)
    }
    await call(link, 'secrets.answer', {
      sessionId,
      entryId: entry.id,
      decision: 'provide',
      values,
      ...(useSaved.length > 0 ? { useSaved } : {}),
      ...(save ? { save: true } : {}),
    })
    setDraft({})
    return true
  }

  const target =
    entry.target.kind === 'file'
      ? `写入项目里的 ${entry.target.path}`
      : '作为环境变量交给本会话之后运行的命令'

  return (
    <AskCard
      icon={E.key}
      title={entry.title}
      body={`${agent} 通过私密卡片向你要这些值`}
      sender={sender}
      footnote="这个值不会进对话记录，Agent 只拿到变量名"
      actions={[
        {
          key: 'decline',
          label: '拒绝',
          run: () =>
            call(link, 'secrets.answer', { sessionId, entryId: entry.id, decision: 'decline' }),
        },
        { key: 'provide', label: '提供', tone: 'primary', run: provide },
      ]}
    >
      <Text selectable style={[styles.message, { color: c.text }]}>
        {entry.reason}
      </Text>
      {entry.url ? (
        <Pressable
          onPress={() => void Linking.openURL(entry.url!).catch(() => {})}
          accessibilityRole="link"
          style={[styles.open, { borderColor: c.border }]}
        >
          <Text style={[styles.openText, { color: c.accent }]}>去获取</Text>
        </Pressable>
      ) : null}
      {entry.fields.map((field, i) => {
        const visible = field.plain === true || shown.has(field.name)
        const problem = tried ? errors[i] : null
        const value = draft[field.name] ?? ''
        return (
          <View key={field.name} style={kit.section}>
            <Text style={[kit.label, { color: c.textSecondary }]}>
              {field.label}
              <Text style={{ color: c.textTertiary, fontWeight: '400', fontFamily: MONO }}>
                {'  '}
                {field.name}
              </Text>
              {field.optional ? (
                <Text style={{ color: c.textTertiary, fontWeight: '400' }}> 可选</Text>
              ) : null}
            </Text>
            <View style={styles.row}>
              <TextInput
                value={value}
                onChangeText={(text) => setDraft((d) => ({ ...d, [field.name]: text }))}
                secureTextEntry={!visible}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                textContentType="none"
                importantForAutofill="no"
                {...(saved.has(field.name) ? { placeholder: '已保存' } : {})}
                placeholderTextColor={c.textTertiary}
                selectionColor={c.accent}
                accessibilityLabel={field.label}
                style={[
                  kit.field,
                  styles.input,
                  {
                    color: c.text,
                    borderColor: problem ? c.danger : c.border,
                    backgroundColor: c.fill,
                  },
                ]}
              />
              {field.plain !== true ? (
                <Pressable
                  onPress={() => {
                    haptic.pick()
                    setShown((s) => {
                      const next = new Set(s)
                      if (next.has(field.name)) next.delete(field.name)
                      else next.add(field.name)
                      return next
                    })
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`${visible ? '隐藏' : '显示'} ${field.label}`}
                  hitSlop={8}
                  style={styles.eye}
                >
                  <Icon icon={visible ? EYE_OFF : EYE} size={18} color={c.textSecondary} />
                </Pressable>
              ) : null}
            </View>
            {saved.has(field.name) && value === '' ? (
              <Text style={[kit.hint, { color: c.textTertiary }]}>
                使用已保存的值，输入新值可替换
              </Text>
            ) : null}
            {field.hint ? (
              <Text style={[kit.hint, { color: c.textTertiary }]}>{field.hint}</Text>
            ) : null}
            {problem ? <Text style={[kit.hint, { color: c.danger }]}>{problem}</Text> : null}
          </View>
        )
      })}
      <Text style={[kit.hint, styles.target, { color: c.textSecondary }]}>{target}</Text>
      <View style={styles.save}>
        <Switch
          value={save}
          onValueChange={setSave}
          trackColor={{ true: c.accent, false: c.fillStrong }}
          accessibilityLabel="加密保存，在这个项目里复用"
        />
        <Text style={[styles.saveText, { color: c.text }]}>
          加密保存，在这个项目里复用
          {entry.saved.length > 0 && !save ? (
            <Text style={{ color: c.textTertiary }}> · 取消会忘掉已保存的值</Text>
          ) : null}
        </Text>
      </View>
    </AskCard>
  )
}

const styles = StyleSheet.create({
  message: { fontSize: 14, lineHeight: 20, marginTop: 10 },
  open: {
    alignSelf: 'flex-start',
    marginTop: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  openText: { fontSize: 14, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center' },
  input: { flex: 1, paddingRight: 40, fontFamily: MONO },
  eye: { position: 'absolute', right: 8, padding: 4 },
  target: { marginTop: 12 },
  save: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10 },
  saveText: { flex: 1, fontSize: 14 },
})
