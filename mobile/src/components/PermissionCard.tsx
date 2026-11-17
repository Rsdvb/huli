// What waits for the user's answer: a tool to allow, an ask's questions, a plan to approve. An
// MCP server's form or page is left to the computer.

import { useState } from 'react'
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import type { HostLink } from '@shared/remote/link'
import type { PermissionOption, QuestionAnswer, ToolEntry } from '@shared/thread'
import type { Theme } from '../theme'
import { Markdown } from './Markdown'

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' })

function plain(name: string): string {
  return name.replace(/`/g, '')
}

function failure(error: unknown): string {
  const e = error as { code?: string; message?: string }
  if (e.code === 'not_found') return '这个请求已经在别处回答过了，或者已经结束。'
  return e.message ?? '没能发送回答。'
}

export function PermissionCard(props: { entry: ToolEntry; sessionId: string; link: HostLink; theme: Theme }) {
  const { entry, theme, link, sessionId } = props
  const permission = entry.permission!
  const [sending, setSending] = useState(false)
  const [noteFor, setNoteFor] = useState<PermissionOption | null>(null)
  const [note, setNote] = useState('')
  const questions = permission.questions ?? []
  const [choices, setChoices] = useState<number[][]>(questions.map(() => []))
  const [texts, setTexts] = useState<string[]>(questions.map(() => ''))

  const respond = async (params: Record<string, unknown>) => {
    setSending(true)
    try {
      await link.request('permissions.respond', { sessionId, requestId: permission.requestId, ...params })
    } catch (error) {
      Alert.alert('没有发出去', failure(error))
    } finally {
      setSending(false)
    }
  }

  const choose = (option: PermissionOption) => {
    if (option.note) {
      setNoteFor(option)
      return
    }
    void respond({ optionId: option.id })
  }

  const title = permission.plan
    ? '批准这个计划？'
    : questions.length > 0
      ? (entry.question ?? '智能体在问你')
      : entry.question ?? entry.title

  return (
    <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.warn }]}>
      <Text style={[styles.title, { color: theme.text }]}>{title}</Text>
      {entry.description && <Text style={{ color: theme.muted, fontSize: 14, marginTop: 4 }}>{entry.description}</Text>}
      {entry.rawInput && !permission.plan && questions.length === 0 && (
        <ScrollView style={[styles.input, { backgroundColor: theme.line }]} nestedScrollEnabled>
          <Text selectable style={{ fontFamily: MONO, fontSize: 13, color: theme.text }}>
            {entry.rawInput}
          </Text>
        </ScrollView>
      )}
      {permission.plan && (
        <ScrollView style={[styles.plan, { borderColor: theme.line }]} nestedScrollEnabled>
          <Markdown markdown={permission.plan.markdown} theme={theme} />
        </ScrollView>
      )}

      {permission.elicitation ? (
        <Text style={{ color: theme.muted, marginTop: 10, fontSize: 14 }}>
          这是 {permission.elicitation.server} 的{permission.elicitation.kind === 'form' ? '表单' : '网页'}请求，请在电脑上处理。
        </Text>
      ) : questions.length > 0 ? (
        <View style={{ marginTop: 8, gap: 14 }}>
          {questions.map((q, qi) => (
            <View key={qi}>
              {q.header ? <Text style={{ color: theme.muted, fontSize: 12, marginBottom: 2 }}>{q.header}</Text> : null}
              <Text style={{ color: theme.text, fontSize: 15, fontWeight: '600' }}>{q.question}</Text>
              <View style={{ marginTop: 6, gap: 6 }}>
                {q.options.map((option, oi) => {
                  const on = choices[qi]!.includes(oi)
                  return (
                    <Pressable
                      key={oi}
                      onPress={() =>
                        setChoices((all) =>
                          all.map((picked, i) =>
                            i !== qi ? picked : q.multiSelect ? (on ? picked.filter((x) => x !== oi) : [...picked, oi]) : [oi],
                          ),
                        )
                      }
                      style={[
                        styles.choice,
                        { borderColor: on ? theme.accent : theme.line, backgroundColor: on ? theme.bg : 'transparent' },
                      ]}
                    >
                      <Text style={{ color: theme.text, fontSize: 15 }}>
                        {q.multiSelect ? (on ? '☑ ' : '☐ ') : on ? '◉ ' : '○ '}
                        {option.label}
                      </Text>
                      {option.description ? (
                        <Text style={{ color: theme.muted, fontSize: 13, marginTop: 2 }}>{option.description}</Text>
                      ) : null}
                    </Pressable>
                  )
                })}
                {q.allowsText && (
                  <TextInput
                    value={texts[qi]}
                    onChangeText={(text) => setTexts((all) => all.map((t, i) => (i === qi ? text : t)))}
                    placeholder="自己写一个回答"
                    placeholderTextColor={theme.muted}
                    secureTextEntry={q.secret}
                    style={[styles.text, { color: theme.text, borderColor: theme.line }]}
                  />
                )}
              </View>
            </View>
          ))}
          <View style={styles.row}>
            <Button
              theme={theme}
              label="提交回答"
              primary
              disabled={sending}
              onPress={() => {
                const answers: QuestionAnswer[] = questions.flatMap((_, qi) => {
                  const text = texts[qi]!.trim()
                  const picked = choices[qi]!
                  return picked.length || text ? [{ question: qi, choices: picked, ...(text ? { text } : {}) }] : []
                })
                void respond({ answers })
              }}
            />
            <Button theme={theme} label="都跳过" disabled={sending} onPress={() => void respond({ answers: [] })} />
          </View>
        </View>
      ) : noteFor ? (
        <View style={{ marginTop: 10 }}>
          <Text style={{ color: theme.text, fontSize: 14 }}>{plain(noteFor.name)}：写下要改什么</Text>
          <TextInput
            value={note}
            onChangeText={setNote}
            multiline
            autoFocus
            style={[styles.text, { color: theme.text, borderColor: theme.line, minHeight: 70 }]}
          />
          <View style={styles.row}>
            <Button
              theme={theme}
              label="发送"
              primary
              disabled={sending}
              onPress={() => void respond({ optionId: noteFor.id, ...(note.trim() ? { note: note.trim() } : {}) })}
            />
            <Button theme={theme} label="取消" disabled={sending} onPress={() => setNoteFor(null)} />
          </View>
        </View>
      ) : (
        <View style={[styles.row, { flexWrap: 'wrap' }]}>
          {permission.options.map((option) => (
            <Button
              key={option.id}
              theme={theme}
              label={plain(option.name)}
              primary={option.kind.startsWith('allow') && (option.preferred || option.kind === 'allow_once')}
              danger={option.kind.startsWith('reject')}
              disabled={sending}
              onPress={() => choose(option)}
            />
          ))}
        </View>
      )}
      {sending && <ActivityIndicator style={{ marginTop: 8 }} color={theme.accent} />}
    </View>
  )
}

function Button(props: {
  theme: Theme
  label: string
  primary?: boolean
  danger?: boolean
  disabled?: boolean
  onPress(): void
}) {
  const { theme } = props
  return (
    <Pressable
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.button,
        props.primary
          ? { backgroundColor: theme.accent, borderColor: theme.accent }
          : { borderColor: props.danger ? theme.danger : theme.line },
        { opacity: props.disabled ? 0.5 : pressed ? 0.75 : 1 },
      ]}
    >
      <Text
        style={{
          color: props.primary ? theme.accentText : props.danger ? theme.danger : theme.text,
          fontSize: 15,
          fontWeight: '600',
        }}
      >
        {props.label}
      </Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: { borderWidth: 1.5, borderRadius: 14, padding: 14 },
  title: { fontSize: 16, fontWeight: '700' },
  input: { maxHeight: 140, borderRadius: 8, padding: 10, marginTop: 10 },
  plan: { maxHeight: 260, borderWidth: 1, borderRadius: 8, padding: 10, marginTop: 10 },
  row: { flexDirection: 'row', gap: 8, marginTop: 12 },
  button: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 9 },
  choice: { borderWidth: 1, borderRadius: 10, padding: 10 },
  text: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, marginTop: 6, fontSize: 15 },
})
