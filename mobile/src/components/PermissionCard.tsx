// What waits for the user's answer: a tool to allow, an ask's questions, a plan to approve, and an
// MCP server's form or page, which ElicitationCard asks.

import { useState } from 'react'
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import type { HostLink } from '@shared/remote/link'
import type { PendingQuestion, PermissionOption, QuestionAnswer, ToolEntry } from '@shared/thread'
import { ElicitationCard } from './entries/ElicitationCard'
import { SendState, useSender } from './entries/kit'
import { haptic } from '../ui/session/feedback'
import { G, Icon, TOOL_ICONS } from '../ui/session/icons'
import { MONO, useSessionTokens } from '../ui/session/palette'
import { PressScale } from '../ui/session/Press'
import { Markdown } from './Markdown'

function plain(name: string): string {
  return name.replace(/`/g, '')
}

export function PermissionCard(props: { entry: ToolEntry; sessionId: string; link: HostLink }) {
  if (props.entry.permission?.elicitation) {
    return <ElicitationCard entry={props.entry} sessionId={props.sessionId} />
  }
  return <ToolPermissionCard {...props} />
}

/** How an ask's question is answered, as the desktop's card hints it. */
function hintOf(q: PendingQuestion): string {
  if (q.secret) return '输入时隐藏，也不留在对话里'
  if (q.options.length === 0) return '写下你的回答'
  if (q.multiSelect) return q.allowsText ? '选择所有适用的，或写下你自己的回答' : '选择所有适用的'
  return q.allowsText ? '选一项，或写下你自己的回答' : '选一项'
}

function ToolPermissionCard(props: { entry: ToolEntry; sessionId: string; link: HostLink }) {
  const { entry, link, sessionId } = props
  const { c, s } = useSessionTokens()
  const permission = entry.permission!
  const sender = useSender(entry.id)
  const sending = sender.busy !== null
  const [noteFor, setNoteFor] = useState<PermissionOption | null>(null)
  const [note, setNote] = useState('')
  const questions = permission.questions ?? []
  const [choices, setChoices] = useState<number[][]>(questions.map(() => []))
  const [texts, setTexts] = useState<string[]>(questions.map(() => ''))

  const respond = (params: Record<string, unknown>) =>
    sender.send('respond', () =>
      link.request('permissions.respond', {
        sessionId,
        requestId: permission.requestId,
        ...params,
      }),
    )

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
      : (entry.question ?? entry.title)
  const icon = permission.plan ? G.plan : questions.length > 0 ? G.hand : TOOL_ICONS[entry.toolKind]
  const shell = entry.toolKind === 'execute'

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: s.dockCard, borderColor: c.borderStrong, shadowColor: c.shadow },
      ]}
    >
      <View style={styles.head}>
        <View style={[styles.badge, { backgroundColor: s.warningSoft }]}>
          <Icon icon={icon} size={15} color={c.warning} />
        </View>
        <Text style={[styles.title, { color: c.text }]}>{title}</Text>
      </View>
      {entry.description ? (
        <Text style={[styles.description, { color: c.textSecondary }]}>{entry.description}</Text>
      ) : null}
      {entry.rawInput && !permission.plan && questions.length === 0 && (
        <ScrollView
          style={[styles.input, { backgroundColor: s.code, borderColor: s.codeBorder }]}
          nestedScrollEnabled
        >
          <Text selectable style={[styles.mono, { color: c.text }]}>
            {shell ? `$ ${entry.rawInput}` : entry.rawInput}
          </Text>
        </ScrollView>
      )}
      {permission.plan && (
        <ScrollView
          style={[styles.plan, { backgroundColor: c.fill, borderColor: c.border }]}
          contentContainerStyle={{ padding: 12 }}
          nestedScrollEnabled
        >
          <Markdown markdown={permission.plan.markdown} size="compact" />
        </ScrollView>
      )}

      {questions.length > 0 ? (
        <View style={{ marginTop: 10, gap: 16 }}>
          {questions.map((q, qi) => (
            <View key={qi} style={{ gap: 8 }}>
              <View>
                {q.header ? (
                  <Text style={[styles.header, { color: c.textTertiary }]}>{q.header}</Text>
                ) : null}
                <Text style={[styles.question, { color: c.text }]}>{q.question}</Text>
                <Text style={[styles.optionDetail, { color: c.textTertiary }]}>{hintOf(q)}</Text>
              </View>
              {q.options.map((option, oi) => {
                const on = choices[qi]!.includes(oi)
                return (
                  <PressScale
                    key={oi}
                    scale={0.98}
                    onPress={() => {
                      haptic.pick()
                      // One choice or the user's own words: picking one clears what they wrote.
                      if (!q.multiSelect) setTexts((all) => all.map((t, i) => (i === qi ? '' : t)))
                      setChoices((all) =>
                        all.map((picked, i) =>
                          i !== qi
                            ? picked
                            : q.multiSelect
                              ? on
                                ? picked.filter((x) => x !== oi)
                                : [...picked, oi]
                              : [oi],
                        ),
                      )
                    }}
                    accessibilityRole={q.multiSelect ? 'checkbox' : 'radio'}
                    accessibilityState={{ checked: on }}
                    style={[
                      styles.choice,
                      {
                        borderColor: on ? c.accent : c.border,
                        backgroundColor: on ? s.accentSoft : c.fill,
                      },
                    ]}
                  >
                    <View style={{ height: 21, justifyContent: 'center' }}>
                      <Icon
                        icon={on ? G.done : G.todo}
                        size={18}
                        color={on ? c.accent : c.textTertiary}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.optionLabel, { color: c.text }]}>{option.label}</Text>
                      {option.description ? (
                        <Text style={[styles.optionDetail, { color: c.textSecondary }]}>
                          {option.description}
                        </Text>
                      ) : null}
                    </View>
                  </PressScale>
                )
              })}
              {(q.allowsText || q.options.length === 0) && (
                <TextInput
                  value={texts[qi]}
                  onChangeText={(text) => {
                    setTexts((all) => all.map((t, i) => (i === qi ? text : t)))
                    if (!q.multiSelect && text.trim()) {
                      setChoices((all) => all.map((picked, i) => (i === qi ? [] : picked)))
                    }
                  }}
                  placeholder={q.options.length === 0 ? '写下你的回答' : '写下你自己的回答'}
                  autoCapitalize={q.secret ? 'none' : 'sentences'}
                  autoCorrect={!q.secret}
                  placeholderTextColor={c.textTertiary}
                  selectionColor={c.accent}
                  secureTextEntry={q.secret}
                  style={[
                    styles.text,
                    { color: c.text, borderColor: c.border, backgroundColor: c.fill },
                  ]}
                />
              )}
            </View>
          ))}
          <View style={styles.row}>
            <Button
              label="提交回答"
              tone="primary"
              disabled={sending}
              onPress={() => {
                const answers: QuestionAnswer[] = questions.flatMap((_, qi) => {
                  const text = texts[qi]!.trim()
                  const picked = choices[qi]!
                  return picked.length || text
                    ? [{ question: qi, choices: picked, ...(text ? { text } : {}) }]
                    : []
                })
                void respond({ answers })
              }}
            />
            <Button
              label="都跳过"
              disabled={sending}
              onPress={() => void respond({ answers: [] })}
            />
          </View>
        </View>
      ) : noteFor ? (
        <View style={{ marginTop: 10, gap: 4 }}>
          <Text style={[styles.description, { color: c.text }]}>
            {plain(noteFor.name)}：写下要改什么
          </Text>
          <TextInput
            value={note}
            onChangeText={setNote}
            multiline
            autoFocus
            selectionColor={c.accent}
            style={[
              styles.text,
              { color: c.text, borderColor: c.border, backgroundColor: c.fill, minHeight: 80 },
            ]}
          />
          <View style={styles.row}>
            <Button
              label="发送"
              tone="primary"
              disabled={sending}
              onPress={() =>
                void respond({
                  optionId: noteFor.id,
                  ...(note.trim() ? { note: note.trim() } : {}),
                })
              }
            />
            <Button label="取消" disabled={sending} onPress={() => setNoteFor(null)} />
          </View>
        </View>
      ) : (
        <View style={[styles.row, { flexWrap: 'wrap' }]}>
          {permission.options.map((option) => (
            <Button
              key={option.id}
              label={plain(option.name)}
              tone={
                option.kind.startsWith('reject')
                  ? 'danger'
                  : option.kind.startsWith('allow') &&
                      (option.preferred || option.kind === 'allow_once')
                    ? 'primary'
                    : 'plain'
              }
              disabled={sending}
              onPress={() => choose(option)}
            />
          ))}
        </View>
      )}
      {sending && <ActivityIndicator style={{ marginTop: 10 }} color={c.textSecondary} />}
      <SendState sender={sender} />
    </View>
  )
}

function Button(props: {
  label: string
  tone?: 'primary' | 'danger' | 'plain'
  disabled?: boolean
  onPress(): void
}) {
  const { c, s } = useSessionTokens()
  const tone = props.tone ?? 'plain'
  return (
    <PressScale
      scale={0.96}
      disabled={props.disabled}
      onPress={props.onPress}
      accessibilityRole="button"
      style={[
        styles.button,
        {
          backgroundColor:
            tone === 'primary' ? c.accent : tone === 'danger' ? s.dangerSoft : c.fillStrong,
          opacity: props.disabled ? 0.5 : 1,
        },
      ]}
    >
      <Text
        style={[
          styles.buttonText,
          { color: tone === 'primary' ? c.onAccent : tone === 'danger' ? c.danger : c.text },
        ]}
      >
        {props.label}
      </Text>
    </PressScale>
  )
}

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
  description: { fontSize: 14, lineHeight: 20, marginTop: 6 },
  input: {
    maxHeight: 150,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    marginTop: 12,
  },
  mono: { fontFamily: MONO, fontSize: 13, lineHeight: 19 },
  plan: { maxHeight: 280, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, marginTop: 12 },
  header: { fontSize: 12, fontWeight: '600', marginBottom: 2, textTransform: 'uppercase' },
  question: { fontSize: 15, lineHeight: 21, fontWeight: '600' },
  choice: { flexDirection: 'row', gap: 10, borderWidth: 1, borderRadius: 14, padding: 12 },
  optionLabel: { fontSize: 15, lineHeight: 21 },
  optionDetail: { fontSize: 13, lineHeight: 18, marginTop: 2 },
  row: { flexDirection: 'row', gap: 8, marginTop: 14 },
  button: { borderRadius: 999, paddingHorizontal: 18, height: 40, justifyContent: 'center' },
  buttonText: { fontSize: 15, fontWeight: '600' },
  text: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 4,
    fontSize: 15,
  },
})
