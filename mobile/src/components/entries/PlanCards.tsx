// Plans as the desktop shows them. A plan to approve: the plan, what changed since the one sent
// back, the mode Claude Code builds in (Codex's choices to implement it), and a note for keeping on
// planning. Once answered, one line says what became of it, with the plan a tap away. The agent's
// running plan is no card per update but one chip above the composer, its ring and current step,
// opening to the step list.

import { useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import Svg, { Circle, Path } from 'react-native-svg'
import type { ConfigOption, PlanEntry, ToolEntry } from '@shared/thread'
import { useConnected, useLink } from '../../host'
import { BottomSheet } from '../../ui/BottomSheet'
import { SegmentedControl } from '../../ui/SegmentedControl'
import { Clamp } from '../../ui/session/Clamp'
import { useSessionRows } from '../../ui/session/context'
import { copyText, haptic } from '../../ui/session/feedback'
import { G, Icon } from '../../ui/session/icons'
import { useSessionTokens } from '../../ui/session/palette'
import { gentle, PressScale } from '../../ui/session/Press'
import { Markdown } from '../Markdown'
import { useAgentName } from './AccessEntries'
import { CardButton, E, SendState, useSender } from './kit'

/** The Claude Code options that build in a mode, by the mode each sets. */
const BUILD_MODES: Record<string, string> = {
  'exit-plan-auto': 'auto',
  'exit-plan-accept-edits': 'acceptEdits',
  'exit-plan-default': 'default',
}

const isBuildMode = (id: string) => Object.prototype.hasOwnProperty.call(BUILD_MODES, id)

/** The name the session's mode list gives its plan mode, or null when it lists none. */
function planModeName(config: readonly ConfigOption[] | undefined): string | null {
  for (const option of config ?? []) {
    if (option.category !== 'mode' || option.type !== 'select') continue
    const choice = option.choices?.find((c) => c.value === 'plan')
    if (choice) return choice.name
  }
  return null
}

/** The plan the entry holds: the request's, or once answered, the entry's own text. */
function planMarkdown(entry: ToolEntry): string {
  if (entry.permission?.plan) return entry.permission.plan.markdown
  const text = entry.content.find((c) => c.type === 'markdown')
  return text?.type === 'markdown' ? text.markdown : ''
}

type PlanLine =
  | { kind: 'same'; count: number }
  | { kind: 'removed'; text: string }
  | { kind: 'added'; text: string }

function planLines(markdown: string): string[] {
  return markdown
    .split('\n')
    .map((line) =>
      line
        .trim()
        .replace(/^#{1,6}\s+/, '')
        .replace(/(\*\*|__|`)(.+?)\1/g, '$2'),
    )
    .filter((line) => line !== '')
}

/** The lines of `next` against `previous`, unchanged runs folded into a count. */
function planDiff(previous: string, next: string): PlanLine[] {
  const a = planLines(previous)
  const b = planLines(next)
  const width = b.length + 1
  const table = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
    }
  }
  const out: PlanLine[] = []
  const same = () => {
    const last = out[out.length - 1]
    if (last?.kind === 'same') last.count++
    else out.push({ kind: 'same', count: 1 })
  }
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      same()
      i++
      j++
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      out.push({ kind: 'removed', text: a[i++]! })
    } else {
      out.push({ kind: 'added', text: b[j++]! })
    }
  }
  while (i < a.length) out.push({ kind: 'removed', text: a[i++]! })
  while (j < b.length) out.push({ kind: 'added', text: b[j++]! })
  return out
}

/** The plan's text, cut short when long, with a quiet button that copies it. */
function PlanBody(props: { markdown: string; clamp?: boolean }) {
  const { c } = useSessionTokens()
  const [copied, setCopied] = useState(false)
  const copy = () =>
    void copyText(props.markdown).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    })
  const body = <Markdown markdown={props.markdown} size="compact" />
  return (
    <View style={[styles.planBody, { backgroundColor: c.fill }]}>
      <Pressable
        onPress={copy}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={copied ? '已复制计划' : '复制计划'}
        style={styles.copy}
      >
        <Icon
          icon={copied ? G.copied : G.copy}
          size={14}
          color={copied ? c.success : c.textTertiary}
        />
      </Pressable>
      {props.clamp === false ? (
        body
      ) : (
        <Clamp maxHeight={320} more="显示完整计划">
          {body}
        </Clamp>
      )}
    </View>
  )
}

function PlanChanges(props: { previous: string; markdown: string }) {
  const { c } = useSessionTokens()
  const lines = useMemo(() => planDiff(props.previous, props.markdown), [props])
  return (
    <View style={[styles.planBody, { backgroundColor: c.fill, gap: 4 }]}>
      <Text style={[styles.small, { color: c.textTertiary }]}>和上一版相比改了什么。</Text>
      {lines.map((line, i) =>
        line.kind === 'same' ? (
          <Text key={i} style={[styles.small, { color: c.textTertiary }]}>
            {line.count} 行没变
          </Text>
        ) : (
          <Text
            key={i}
            selectable
            style={[
              styles.diffLine,
              {
                color: line.kind === 'added' ? c.added : c.removed,
                backgroundColor: line.kind === 'added' ? c.addedBg : c.removedBg,
              },
            ]}
            accessibilityLabel={`${line.kind === 'added' ? '新增' : '删除'} ${line.text}`}
          >
            {line.kind === 'added' ? '+ ' : '− '}
            {line.text}
          </Text>
        ),
      )}
    </View>
  )
}

/**
 * A plan waiting for the user: the plan, the mode it builds in, and a note for keeping on
 * planning. 开始构建 builds; 继续计划 sends it back, with the note when there is one.
 */
export function PlanApprovalCard(props: { entry: ToolEntry; sessionId: string }) {
  const { entry, sessionId } = props
  const { c, s } = useSessionTokens()
  const link = useLink()
  const connected = useConnected()
  const agent = useAgentName(sessionId)
  const sender = useSender(entry.id)
  const permission = entry.permission!
  const plan = permission.plan!
  const options = permission.options
  const keepOption =
    options.find((o) => o.note) ??
    options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always') ??
    null
  const choices = options.filter((o) => o !== keepOption)
  const modes = choices.filter((o) => isBuildMode(o.id))
  const [chosen, setChosen] = useState<string>(
    () => (choices.find((o) => o.preferred) ?? choices[0])?.id ?? '',
  )
  const [note, setNote] = useState('')
  const [view, setView] = useState<'plan' | 'changes'>(plan.previous ? 'changes' : 'plan')
  const version = entry.planVersion ?? 1
  const away = !connected
  const busy = sender.busy !== null || away

  const answer = (id: string | undefined, text?: string) => {
    if (!id || busy) return
    void sender.send(id, () =>
      link.request('permissions.respond', {
        sessionId,
        requestId: permission.requestId,
        optionId: id,
        ...(text ? { note: text } : {}),
      }),
    )
  }
  const keepPlanning = () => answer(keepOption?.id, keepOption?.note ? note.trim() : '')
  const picks = modes.length > 0 ? modes : choices

  return (
    <View
      style={[
        styles.card,
        { backgroundColor: s.dockCard, borderColor: c.borderStrong, shadowColor: c.shadow },
      ]}
    >
      <View style={styles.head}>
        <View style={[styles.badge, { backgroundColor: s.warningSoft }]}>
          <Icon icon={G.plan} size={15} color={c.warning} />
        </View>
        <Text style={[styles.title, { color: c.text }]}>
          {version > 1 ? `计划 ${version}` : '计划'}
        </Text>
        <Text style={[styles.label, { color: c.warning }]}>等你回答</Text>
      </View>
      <Text style={[styles.description, { color: c.textSecondary }]}>
        {modes.length > 0
          ? `${agent} 已完成计划。开始构建，或附上意见继续计划。`
          : `${agent} 已完成计划。按它实施，或附上意见继续计划。`}
      </Text>
      <View style={{ gap: 10, marginTop: 12 }}>
        {plan.previous ? (
          <SegmentedControl<'plan' | 'changes'>
            segments={[
              { key: 'plan', label: '计划' },
              { key: 'changes', label: '改动' },
            ]}
            value={view}
            onChange={setView}
          />
        ) : null}
        {view === 'changes' && plan.previous ? (
          <PlanChanges previous={plan.previous} markdown={plan.markdown} />
        ) : (
          <PlanBody markdown={plan.markdown} />
        )}
        {(modes.length > 0 || choices.length > 1) && (
          <View style={{ gap: 6 }}>
            <Text style={[styles.small, { color: c.textSecondary, fontWeight: '600' }]}>
              {modes.length > 0 ? '开始构建，使用' : '按这个计划实施吗？'}
            </Text>
            {picks.length <= 3 ? (
              <SegmentedControl
                segments={picks.map((o) => ({ key: o.id, label: o.name.replace(/`/g, '') }))}
                value={chosen}
                onChange={setChosen}
              />
            ) : (
              <View style={styles.choices}>
                {picks.map((o) => {
                  const on = o.id === chosen
                  return (
                    <PressScale
                      key={o.id}
                      scale={0.97}
                      onPress={() => {
                        haptic.pick()
                        setChosen(o.id)
                      }}
                      accessibilityRole="radio"
                      accessibilityState={{ checked: on }}
                      style={[
                        styles.choice,
                        {
                          borderColor: on ? c.accent : c.border,
                          backgroundColor: on ? s.accentSoft : c.fill,
                        },
                      ]}
                    >
                      <Text style={[styles.choiceText, { color: c.text }]}>
                        {o.name.replace(/`/g, '')}
                      </Text>
                    </PressScale>
                  )
                })}
              </View>
            )}
          </View>
        )}
        {keepOption?.note && (
          <TextInput
            value={note}
            onChangeText={setNote}
            placeholder={`继续计划，告诉 ${agent} 要改什么…`}
            placeholderTextColor={c.textTertiary}
            selectionColor={c.accent}
            multiline
            accessibilityLabel={keepOption.name}
            style={[styles.note, { color: c.text, borderColor: c.border, backgroundColor: c.fill }]}
          />
        )}
      </View>
      <View style={styles.row}>
        <CardButton
          label={note.trim() ? '发送意见' : '继续计划'}
          busy={sender.busy === keepOption?.id}
          disabled={busy || !keepOption}
          onPress={keepPlanning}
        />
        <CardButton
          label={modes.length > 0 ? '开始构建' : '实施'}
          tone="primary"
          busy={sender.busy === chosen}
          disabled={busy || !chosen}
          onPress={() => answer(chosen)}
        />
      </View>
      {away && (
        <Text style={[styles.small, { color: c.textTertiary, marginTop: 8 }]}>
          连上电脑后才能回答
        </Text>
      )}
      <SendState sender={sender} />
    </View>
  )
}

/** In the thread, while a plan waits: one line that points to its card above the composer. */
export function PlanWaitingLine(props: { entry: ToolEntry }) {
  const { c, s } = useSessionTokens()
  const version = props.entry.planVersion ?? 1
  return (
    <View style={styles.line}>
      <View style={[styles.lineBadge, { backgroundColor: s.warningSoft }]}>
        <Icon icon={G.plan} size={13} color={c.warning} />
      </View>
      <Text style={[styles.lineText, { color: c.text }]} numberOfLines={1}>
        {version > 1 ? `计划 ${version}` : '计划'}
      </Text>
      <Text style={[styles.pill, { color: c.warning, backgroundColor: s.warningSoft }]}>
        等你回答
      </Text>
    </View>
  )
}

/**
 * A plan once answered: a line that says what became of it, with the plan under 显示计划; an
 * approval notes the mode it moved to, a plan sent back quotes the note.
 */
export function PlanSettled(props: { entry: ToolEntry }) {
  const { entry } = props
  const { c } = useSessionTokens()
  const { config } = useSessionRows()
  const [open, setOpen] = useState(false)
  const result = entry.permissionResult
  const markdown = planMarkdown(entry)
  const version = entry.planVersion ?? 1
  const approved =
    typeof result === 'object' &&
    result !== null &&
    (result.kind === 'allow_once' || result.kind === 'allow_always')
  const kept = typeof result === 'object' && result !== null && !approved ? result : null
  const mode =
    approved && typeof result === 'object' && result && isBuildMode(result.optionId)
      ? (result.name ?? null)
      : null
  const icon = approved ? G.done : kept ? E.undo : result ? G.close : G.plan
  const title = approved
    ? '计划已批准'
    : kept
      ? '已继续计划'
      : result === 'cancelled' || result === 'withdrawn'
        ? '计划已取消'
        : version > 1
          ? `计划 ${version}`
          : '计划'
  const meta = approved ? mode : kept ? (version > 1 ? `计划 ${version}` : '计划') : null
  const planMode = planModeName(config)
  return (
    <View style={{ gap: 6 }}>
      <View style={[styles.settled, { backgroundColor: c.fill }]}>
        <Pressable
          onPress={() => {
            gentle()
            setOpen((v) => !v)
          }}
          disabled={!markdown}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          style={({ pressed }) => [styles.settledHead, { opacity: pressed ? 0.6 : 1 }]}
        >
          <Icon icon={icon} size={15} color={approved ? c.success : c.textSecondary} />
          <Text style={[styles.settledTitle, { color: c.text }]} numberOfLines={1}>
            {title}
            {meta ? (
              <Text style={{ color: c.textTertiary, fontWeight: '400' }}> · {meta}</Text>
            ) : null}
          </Text>
          {markdown ? (
            <Text style={[styles.small, { color: c.tint, fontWeight: '600' }]}>
              {open ? '收起计划' : '显示计划'}
            </Text>
          ) : null}
        </Pressable>
        {kept?.note ? (
          <Text
            selectable
            style={[styles.quote, { color: c.textSecondary, borderLeftColor: c.borderStrong }]}
          >
            {kept.note}
          </Text>
        ) : null}
        {open && markdown ? <PlanBody markdown={markdown} clamp={false} /> : null}
      </View>
      {mode ? (
        <View style={styles.moved}>
          <Icon icon={G.right} size={11} color={c.textTertiary} weight="semibold" />
          <Text style={[styles.small, { color: c.textSecondary }]}>
            模式从 <Text style={{ fontWeight: '700' }}>{planMode ?? 'Plan'}</Text> 改为{' '}
            <Text style={{ fontWeight: '700' }}>{mode}</Text>
          </Text>
        </View>
      ) : null}
    </View>
  )
}

/** A segment per step, clockwise from the top; past twelve steps they join into one ring. */
function PlanRing(props: { items: PlanEntry['items']; size?: number }) {
  const { c } = useSessionTokens()
  const count = props.items.length
  const gap = count > 12 ? 0 : 0.18
  const color = (status: string) =>
    status === 'completed' ? c.success : status === 'in_progress' ? c.tint : c.borderStrong
  const size = props.size ?? 16
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16">
      {props.items.map((item, i) => {
        if (count === 1) {
          return (
            <Circle
              key={i}
              cx={8}
              cy={8}
              r={6}
              stroke={color(item.status)}
              strokeWidth={2}
              fill="none"
            />
          )
        }
        const a0 = (i / count) * 2 * Math.PI - Math.PI / 2 + gap
        const a1 = ((i + 1) / count) * 2 * Math.PI - Math.PI / 2 - gap
        const p = (a: number) =>
          `${(8 + 6 * Math.cos(a)).toFixed(2)} ${(8 + 6 * Math.sin(a)).toFixed(2)}`
        return (
          <Path
            key={i}
            d={`M${p(a0)} A6 6 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${p(a1)}`}
            stroke={color(item.status)}
            strokeWidth={2}
            strokeLinecap="round"
            fill="none"
          />
        )
      })}
    </Svg>
  )
}

/**
 * The session's plan above the composer: its ring, the step it is on and which of how many; tapped,
 * the step list. It leaves once every step is done and its turn ended.
 */
export function PlanChip(props: { plan: PlanEntry | null; running: boolean }) {
  const { c, s } = useSessionTokens()
  const [open, setOpen] = useState(false)
  const items = props.plan && props.plan.items.length > 0 ? props.plan.items : null
  if (!items) return null
  const allDone = items.every((item) => item.status === 'completed')
  if (allDone && !props.running && !open) return null
  const total = items.length
  const doing = items.findIndex((item) => item.status === 'in_progress')
  const next = items.findIndex((item) => item.status === 'pending')
  const index = doing >= 0 ? doing : next >= 0 ? next : total - 1
  const step = index + 1
  const text = doing >= 0 || next >= 0 ? items[index]!.content : null
  const label = text ? `计划：第 ${step} 步，共 ${total} 步，${text}` : `计划：${total} 步都已完成`
  return (
    <View style={styles.chipDock}>
      <PressScale
        scale={0.98}
        onPress={() => {
          haptic.tap()
          setOpen(true)
        }}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={[styles.chip, { backgroundColor: s.dockCard, borderColor: c.border }]}
      >
        <PlanRing items={items} />
        <Text style={[styles.chipText, { color: c.text }]} numberOfLines={1}>
          {text ?? '都已完成'}
        </Text>
        <Text style={[styles.chipCount, { color: c.textTertiary }]}>
          {step}/{total}
        </Text>
        <Icon icon={G.upDown} size={11} color={c.textTertiary} />
      </PressScale>
      <BottomSheet visible={open} onClose={() => setOpen(false)} title={label}>
        <View style={{ gap: 10, paddingBottom: 8 }}>
          {items.map((item, i) => (
            <View key={i} style={styles.step}>
              <View style={{ height: 21, justifyContent: 'center' }}>
                <Icon
                  icon={
                    item.status === 'completed'
                      ? G.done
                      : item.status === 'in_progress'
                        ? G.doing
                        : G.todo
                  }
                  size={16}
                  color={
                    item.status === 'completed'
                      ? c.success
                      : item.status === 'in_progress'
                        ? c.tint
                        : c.textTertiary
                  }
                />
              </View>
              <Text
                style={[
                  styles.stepText,
                  {
                    color: item.status === 'completed' ? c.textTertiary : c.text,
                    fontWeight: item.status === 'in_progress' ? '600' : '400',
                    textDecorationLine: item.status === 'completed' ? 'line-through' : 'none',
                  },
                ]}
              >
                {item.content}
              </Text>
            </View>
          ))}
        </View>
      </BottomSheet>
    </View>
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
  label: { fontSize: 12, fontWeight: '600' },
  description: { fontSize: 14, lineHeight: 20, marginTop: 6 },
  planBody: { borderRadius: 12, padding: 12, paddingRight: 34 },
  copy: { position: 'absolute', top: 10, right: 10, zIndex: 1 },
  small: { fontSize: 13, lineHeight: 18 },
  diffLine: {
    fontSize: 13,
    lineHeight: 19,
    borderRadius: 4,
    paddingHorizontal: 4,
    overflow: 'hidden',
  },
  choices: { gap: 8 },
  choice: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  choiceText: { fontSize: 15 },
  note: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    minHeight: 44,
    maxHeight: 120,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 14,
    justifyContent: 'flex-end',
  },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 },
  lineBadge: {
    width: 24,
    height: 24,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lineText: { flex: 1, fontSize: 14, lineHeight: 19 },
  pill: {
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    overflow: 'hidden',
  },
  settled: { borderRadius: 14, padding: 10, gap: 8 },
  settledHead: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 24 },
  settledTitle: { flex: 1, fontSize: 14, lineHeight: 19, fontWeight: '600' },
  quote: { fontSize: 14, lineHeight: 20, borderLeftWidth: 2, paddingLeft: 10 },
  moved: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 4 },
  chipDock: { paddingHorizontal: 12, paddingTop: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    height: 36,
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  chipText: { flexShrink: 1, fontSize: 13.5, fontWeight: '500' },
  chipCount: { fontSize: 12, fontVariant: ['tabular-nums'] },
  step: { flexDirection: 'row', gap: 10 },
  stepText: { flex: 1, fontSize: 15, lineHeight: 21 },
})
