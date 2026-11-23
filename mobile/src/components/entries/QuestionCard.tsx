// An agent's question above the composer, as the official app asks it: 「Claude Code 在问」, the
// question, each choice a tile with its box (square when several may be picked, round when one),
// a dashed 其他 tile that becomes a field for the user's own words, then 跳过 and 提交. Several
// questions are asked one at a time, with how far along they are, and answered together.
// Huli: options that carry a preview (a mockup or code) show the picked one's under the options,
// cut short with 展开 to read it whole in a sheet.

import { useState } from 'react'
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { hasPreviews, previewMarkdown, shownPreview } from '@shared/question-preview'
import type { HostLink } from '@shared/remote/link'
import type { PendingQuestion, QuestionAnswer, ToolEntry } from '@shared/thread'
import { BottomSheet } from '../../ui/BottomSheet'
import { useConnected } from '../../host'
import { haptic } from '../../ui/session/feedback'
import { AgentGlyph, G, Icon } from '../../ui/session/icons'
import { useSessionTokens } from '../../ui/session/palette'
import { agentIdOf, useSessionField } from '../../ui/session/sessionField'
import { PressScale } from '../../ui/session/Press'
import { Markdown } from '../Markdown'
import { useAgentName } from './AccessEntries'
import { E, SendState, useSender } from './kit'

/** How a question is answered, as the desktop's card hints it. */
function hintOf(q: PendingQuestion): string | null {
  if (q.secret) return '输入时隐藏，也不留在对话里'
  if (q.options.length === 0) return null
  if (q.multiSelect) return '可多选'
  return null
}

/** A choice's box: square when several may be picked, round when one; filled once picked. */
function Box(props: { multi: boolean; on: boolean; dashed?: boolean }) {
  const { c } = useSessionTokens()
  return (
    <View
      style={[
        styles.box,
        {
          borderRadius: props.multi ? 6 : 11,
          borderColor: props.on ? c.accent : c.borderStrong,
          backgroundColor: props.on ? c.accent : 'transparent',
        },
      ]}
    >
      {props.on ? <Icon icon={G.check} size={13} color={c.onAccent} weight="bold" /> : null}
    </View>
  )
}

export function QuestionCard(props: { entry: ToolEntry; sessionId: string; link: HostLink }) {
  const { entry, link, sessionId } = props
  const { c, s } = useSessionTokens()
  const agent = useAgentName(sessionId)
  const agentId = useSessionField(sessionId, agentIdOf) ?? ''
  const permission = entry.permission!
  const questions = permission.questions ?? []
  const sender = useSender(entry.id)
  const away = !useConnected()
  const sending = sender.busy !== null || away
  const [at, setAt] = useState(0)
  const [choices, setChoices] = useState<number[][]>(() => questions.map(() => []))
  const [texts, setTexts] = useState<string[]>(() => questions.map(() => ''))
  // Whose 其他 tile is open as a field.
  const [writing, setWriting] = useState<boolean[]>(() =>
    questions.map((q) => q.options.length === 0),
  )
  const q = questions[at]
  if (!q) return null
  const last = at === questions.length - 1
  const picked = choices[at]!
  const text = texts[at]!
  const answered = picked.length > 0 || text.trim() !== ''

  // 跳过 and 提交 send under keys of their own, so only the one tapped turns.
  const respond = (answers: QuestionAnswer[], key: 'skip' | 'submit') =>
    void sender.send(key, () =>
      link.request('permissions.respond', {
        sessionId,
        requestId: permission.requestId,
        answers,
      }),
    )
  const collect = (): QuestionAnswer[] =>
    questions.flatMap((_, qi) => {
      const own = texts[qi]!.trim()
      const chosen = choices[qi]!
      return chosen.length || own
        ? [{ question: qi, choices: chosen, ...(own ? { text: own } : {}) }]
        : []
    })
  const next = () => {
    haptic.tap()
    if (last) respond(collect(), 'submit')
    else setAt(at + 1)
  }
  const skip = () => {
    haptic.tap()
    if (questions.length === 1) return respond([], 'skip')
    // This one stays unanswered; the last skip sends what the others got.
    setChoices((all) => all.map((x, i) => (i === at ? [] : x)))
    setTexts((all) => all.map((x, i) => (i === at ? '' : x)))
    if (last) {
      respond(
        collect().filter((answer) => answer.question !== at),
        'skip',
      )
    } else setAt(at + 1)
  }
  const pick = (oi: number) => {
    haptic.pick()
    const on = picked.includes(oi)
    if (!q.multiSelect) {
      // One choice or the user's own words: picking one closes what they wrote.
      setTexts((all) => all.map((x, i) => (i === at ? '' : x)))
      setWriting((all) => all.map((x, i) => (i === at && q.options.length > 0 ? false : x)))
    }
    setChoices((all) =>
      all.map((x, i) =>
        i !== at
          ? x
          : q.multiSelect
            ? on
              ? x.filter((y) => y !== oi)
              : [...x, oi]
            : on
              ? []
              : [oi],
      ),
    )
  }
  const hint = hintOf(q)
  const ownOpen = writing[at]!
  const preview = hasPreviews(q) ? shownPreview(q, null, picked) : null

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: s.dockCard, borderColor: c.borderStrong, shadowColor: c.shadow },
      ]}
    >
      <View style={styles.head}>
        <AgentGlyph agentId={agentId} size={18} />
        <Text style={[styles.asks, { color: c.text }]} numberOfLines={1}>
          {agent} <Text style={{ fontWeight: '400' }}>在问</Text>
        </Text>
        {at > 0 ? (
          <PressScale
            scale={0.96}
            onPress={() => {
              haptic.tap()
              setAt(at - 1)
            }}
            disabled={sending}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="上一个问题"
            style={[styles.back, { opacity: sending ? 0.5 : 1 }]}
          >
            <Icon icon={G.back} size={12} color={c.tint} weight="semibold" />
            <Text style={[styles.backText, { color: c.tint }]}>上一个</Text>
          </PressScale>
        ) : null}
        {questions.length > 1 ? (
          <Text style={[styles.progress, { color: c.textTertiary }]}>
            {at + 1}/{questions.length}
          </Text>
        ) : null}
      </View>
      {q.header && q.header !== q.question ? (
        <Text style={[styles.header, { color: c.textTertiary }]}>{q.header}</Text>
      ) : null}
      <Text style={[styles.question, { color: c.text }]}>{q.question}</Text>
      {hint ? <Text style={[styles.hint, { color: c.textTertiary }]}>{hint}</Text> : null}
      <View style={styles.options}>
        {q.options.map((option, oi) => {
          const on = picked.includes(oi)
          return (
            <PressScale
              key={oi}
              scale={0.98}
              onPress={() => pick(oi)}
              disabled={sending}
              accessibilityRole={q.multiSelect ? 'checkbox' : 'radio'}
              accessibilityState={{ checked: on }}
              accessibilityLabel={[option.label, option.description].filter(Boolean).join('，')}
              style={[
                styles.option,
                {
                  borderColor: on ? c.accent : c.border,
                  backgroundColor: on ? s.accentSoft : 'transparent',
                },
              ]}
            >
              <View style={styles.boxSlot}>
                <Box multi={q.multiSelect} on={on} />
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[styles.label, { color: c.text }]}>{option.label}</Text>
                {option.description ? (
                  <Text style={[styles.description, { color: c.textSecondary }]}>
                    {option.description}
                  </Text>
                ) : null}
              </View>
            </PressScale>
          )
        })}
        {q.allowsText || q.options.length === 0 ? (
          ownOpen ? (
            <View
              style={[
                styles.option,
                styles.dashed,
                { borderColor: text.trim() ? c.accent : c.borderStrong },
              ]}
            >
              {q.options.length > 0 ? (
                <View style={styles.boxSlot}>
                  <Box multi={q.multiSelect} on={text.trim() !== ''} />
                </View>
              ) : null}
              <TextInput
                value={text}
                onChangeText={(value) => {
                  setTexts((all) => all.map((x, i) => (i === at ? value : x)))
                  if (!q.multiSelect && value.trim()) {
                    setChoices((all) => all.map((x, i) => (i === at ? [] : x)))
                  }
                }}
                autoFocus={q.options.length > 0}
                multiline={!q.secret}
                placeholder={q.options.length === 0 ? '写下你的回答' : '其他'}
                placeholderTextColor={c.textTertiary}
                selectionColor={c.accent}
                secureTextEntry={q.secret}
                autoCapitalize={q.secret ? 'none' : 'sentences'}
                autoCorrect={!q.secret}
                editable={!sending}
                accessibilityLabel="你自己的回答"
                style={[styles.field, { color: c.text }]}
              />
            </View>
          ) : (
            <PressScale
              scale={0.98}
              onPress={() => {
                haptic.pick()
                setWriting((all) => all.map((x, i) => (i === at ? true : x)))
                if (!q.multiSelect) setChoices((all) => all.map((x, i) => (i === at ? [] : x)))
              }}
              disabled={sending}
              accessibilityRole="button"
              accessibilityLabel="其他，写下你自己的回答"
              style={[styles.option, styles.dashed, { borderColor: c.borderStrong }]}
            >
              <View style={styles.boxSlot}>
                <Box multi={q.multiSelect} on={false} />
              </View>
              <Text style={[styles.label, { color: c.textTertiary, flex: 1 }]}>其他</Text>
            </PressScale>
          )
        ) : null}
      </View>
      {preview !== null ? (
        <OptionPreview label={q.options[preview]!.label} preview={q.options[preview]!.preview!} />
      ) : null}
      <View style={[styles.rule, { backgroundColor: c.border }]} />
      <View style={styles.buttons}>
        <PressScale
          scale={0.97}
          onPress={skip}
          disabled={sending}
          accessibilityRole="button"
          accessibilityLabel={questions.length > 1 ? '跳过这个问题' : '跳过'}
          outerStyle={{ flex: 1 }}
          style={[
            styles.button,
            { backgroundColor: c.fill, borderColor: c.border, opacity: sending ? 0.5 : 1 },
          ]}
        >
          {sender.busy === 'skip' ? (
            <ActivityIndicator size="small" color={c.text} />
          ) : (
            <Icon icon={E.undo} size={15} color={c.text} style={{ transform: [{ scaleX: -1 }] }} />
          )}
          <Text style={[styles.buttonText, { color: c.text }]}>跳过</Text>
        </PressScale>
        <PressScale
          scale={0.97}
          onPress={next}
          disabled={sending || !answered}
          accessibilityRole="button"
          accessibilityState={{ disabled: sending || !answered }}
          outerStyle={{ flex: 1 }}
          style={[
            styles.button,
            {
              backgroundColor: answered ? c.accent : c.fillStrong,
              borderColor: 'transparent',
              opacity: sending ? 0.5 : 1,
            },
          ]}
        >
          {sender.busy === 'submit' ? (
            <ActivityIndicator size="small" color={c.onAccent} />
          ) : (
            <Icon
              icon={last ? G.check : G.right}
              size={15}
              color={answered ? c.onAccent : c.textTertiary}
              weight="semibold"
            />
          )}
          <Text style={[styles.buttonText, { color: answered ? c.onAccent : c.textTertiary }]}>
            {last ? '提交' : '下一个'}
          </Text>
        </PressScale>
      </View>
      {away && <Text style={[styles.hint, { color: c.textTertiary }]}>连上电脑后才能回答</Text>}
      <SendState sender={sender} />
    </View>
  )
}

/** The picked option's preview, cut to a few lines; 展开 opens it whole in a sheet. */
function OptionPreview(props: { label: string; preview: string }) {
  const { c } = useSessionTokens()
  const [open, setOpen] = useState(false)
  const markdown = previewMarkdown(props.preview)
  return (
    <View style={[styles.preview, { backgroundColor: c.fill, borderColor: c.border }]}>
      <View style={styles.previewHead}>
        <Text style={[styles.previewTitle, { color: c.textTertiary }]}>预览</Text>
        <Text style={[styles.previewName, { color: c.text }]} numberOfLines={1}>
          {props.label}
        </Text>
        <PressScale
          scale={0.96}
          onPress={() => {
            haptic.tap()
            setOpen(true)
          }}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={`展开${props.label}的预览`}
        >
          <Text style={[styles.backText, { color: c.tint }]}>展开</Text>
        </PressScale>
      </View>
      <View style={styles.previewBody} pointerEvents="none">
        <Markdown markdown={markdown} size="compact" />
      </View>
      <BottomSheet
        visible={open}
        onClose={() => setOpen(false)}
        title={props.label}
        maxHeight={560}
        solid
      >
        <ScrollView contentContainerStyle={styles.previewSheet}>
          <Markdown markdown={markdown} size="compact" />
        </ScrollView>
      </BottomSheet>
    </View>
  )
}

const styles = StyleSheet.create({
  preview: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    borderCurve: 'continuous',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 6,
    marginTop: 4,
  },
  previewHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  previewTitle: { fontSize: 12, fontWeight: '600' },
  previewName: { flex: 1, fontSize: 13, fontWeight: '600' },
  previewBody: { maxHeight: 150, overflow: 'hidden' },
  previewSheet: { paddingHorizontal: 16, paddingBottom: 24 },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 22,
    borderCurve: 'continuous',
    padding: 16,
    gap: 8,
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  asks: { flex: 1, fontSize: 16, lineHeight: 21, fontWeight: '600' },
  progress: { fontSize: 13, fontVariant: ['tabular-nums'] },
  back: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  backText: { fontSize: 13, fontWeight: '600' },
  header: { fontSize: 12, fontWeight: '600', marginTop: 2 },
  question: { fontSize: 16, lineHeight: 23, fontWeight: '600' },
  hint: { fontSize: 12.5, lineHeight: 17 },
  options: { gap: 8, marginTop: 4 },
  option: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    borderCurve: 'continuous',
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  dashed: { borderStyle: 'dashed', borderWidth: 1 },
  boxSlot: { height: 22, justifyContent: 'center' },
  box: {
    width: 22,
    height: 22,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { fontSize: 16, lineHeight: 22 },
  description: { fontSize: 13.5, lineHeight: 19 },
  field: { flex: 1, fontSize: 16, lineHeight: 22, minHeight: 22, maxHeight: 120, padding: 0 },
  rule: { height: StyleSheet.hairlineWidth, marginHorizontal: -16, marginTop: 8 },
  buttons: { flexDirection: 'row', gap: 10, marginTop: 4 },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 46,
    borderRadius: 14,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
  },
  buttonText: { fontSize: 16, fontWeight: '600' },
})
