// A command and what it printed, as the desktop's shell block shows it: the command, the output's
// last 12 lines with the earlier ones a tap away, the exit code when it failed, and copy for each.
// Only red, green, dim and bold survive of the output's colors.

import { useState, type ReactNode } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import {
  harnessOf,
  isAgentId,
  type HarnessId,
  type ToolContent,
  type ToolEntry,
} from '@shared/thread'
import { useSession } from '../../host'
import { copyText, showMenu } from '../../ui/session/feedback'
import { G, Icon } from '../../ui/session/icons'
import { MONO, useSessionTokens } from '../../ui/session/palette'
import { selectText } from '../../ui/session/SelectText'

const SHELL_TAIL = 12
// Long output stays a phone's read: past this the earliest lines are left to the full view.
const MOST_CHARS = 20000

const FENCED = /^(`{3,})[^\n`]*\n([\s\S]*?)\n?\1$/

/** What a command printed, when its result is one fenced block of text; null for anything else. */
export function commandOutput(content: readonly ToolContent[]): string | null {
  const first = content[0]
  if (first?.type !== 'markdown') return null
  const match = FENCED.exec(first.markdown.trim())
  if (!match) return null
  const [, fence, body] = match
  if (body!.split('\n').some((line) => line.trimStart().startsWith(fence!))) return null
  return body!
}

function shellTail(output: string): { shown: string; earlier: number } {
  const lines = output.replace(/\n$/, '').split('\n')
  if (lines.length <= SHELL_TAIL) return { shown: lines.join('\n'), earlier: 0 }
  return { shown: lines.slice(-SHELL_TAIL).join('\n'), earlier: lines.length - SHELL_TAIL }
}

// Claude Code's Bash puts a failed command's code on the result's first line.
const EXIT_LINE = /^(?:Error: )?Exit code (\d+)\r?\n?/

function exitOf(
  output: string | null,
  status: ToolEntry['status'],
  harness: HarnessId | null,
): { code: number | null; output: string | null } {
  const stated = output === null ? null : EXIT_LINE.exec(output)
  if (stated) return { code: Number(stated[1]), output: output!.slice(stated[0].length) }
  const strict = harness === 'claude-code' || harness === 'codex'
  return { code: status === 'completed' && strict ? 0 : null, output }
}

type Tone = 'red' | 'green' | 'dim' | 'bold' | null

// eslint-disable-next-line no-control-regex
const ESCAPE = /\x1b(?:\[([0-9;?]*)([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g

function ansiRuns(text: string): { text: string; tone: Tone }[] {
  const runs: { text: string; tone: Tone }[] = []
  let tone: Tone = null
  let at = 0
  const push = (part: string) => {
    if (!part) return
    const last = runs[runs.length - 1]
    if (last && last.tone === tone) last.text += part
    else runs.push({ text: part, tone })
  }
  for (const match of text.matchAll(ESCAPE)) {
    push(text.slice(at, match.index))
    at = match.index + match[0].length
    if (match[2] !== 'm') continue
    const codes = (match[1] || '0').split(';').map(Number)
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]
      if (code === 38 || code === 48 || code === 58) {
        i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0
        continue
      }
      if (code === 0 || code === 39 || code === 22) tone = null
      else if (code === 31 || code === 91) tone = 'red'
      else if (code === 32 || code === 92) tone = 'green'
      else if (code === 2 || code === 90) tone = 'dim'
      else if (code === 1) tone = tone ?? 'bold'
    }
  }
  push(text.slice(at))
  return runs
}

/** Text without the escape sequences a terminal reads, for copying. */
function plainOutput(text: string): string {
  return ansiRuns(text)
    .map((run) => run.text)
    .join('')
}

function Printed(props: { text: string; color: string }) {
  const { c, s } = useSessionTokens()
  return (
    <Text style={[styles.mono, { color: props.color }]}>
      {ansiRuns(props.text).map((run, i) =>
        run.tone ? (
          <Text
            key={i}
            style={
              run.tone === 'red'
                ? { color: c.danger }
                : run.tone === 'green'
                  ? { color: c.success }
                  : run.tone === 'dim'
                    ? { color: s.syntax.comment }
                    : { fontWeight: '700', color: c.text }
            }
          >
            {run.text}
          </Text>
        ) : (
          run.text
        ),
      )}
    </Text>
  )
}

/**
 * A section of an opened step's card, under a hairline: its label, a copy button on the right
 * when it has text to copy, and its content. Long-pressed, it offers to copy or select its text.
 */
export function StepSection(props: {
  label: string
  extra?: string | null
  copy?: string | undefined
  /** Selects its text in the monospaced face. */
  mono?: boolean
  children: ReactNode
}) {
  const { c } = useSessionTokens()
  const [copied, setCopied] = useState(false)
  const text = props.copy
  return (
    <Pressable
      onLongPress={
        text
          ? () =>
              showMenu(undefined, [
                { label: '复制', onPress: () => void copyText(text) },
                {
                  label: '选择文本',
                  onPress: () => selectText({ text, mono: props.mono ?? true }),
                },
              ])
          : undefined
      }
      delayLongPress={350}
      style={[styles.section, { borderTopColor: c.border }]}
    >
      <View style={styles.head}>
        <Text style={[styles.label, { color: c.textSecondary }]}>
          {props.label}
          {props.extra ? <Text style={{ color: c.danger }}> · {props.extra}</Text> : null}
        </Text>
        {text !== undefined ? (
          <Pressable
            onPress={() =>
              void copyText(text).then(() => {
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              })
            }
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={copied ? '已复制' : `复制${props.label}`}
            style={({ pressed }) => [
              styles.copy,
              { borderColor: c.border, backgroundColor: pressed ? c.fillStrong : c.fill },
            ]}
          >
            <Icon
              icon={copied ? G.copied : G.copy}
              size={14}
              color={copied ? c.success : c.textSecondary}
            />
          </Pressable>
        ) : null}
      </View>
      {props.children}
    </Pressable>
  )
}

/** The command's block and its output's, for a shell call's opened row. */
export function ShellBlock(props: {
  sessionId: string
  command: string
  output: string | null
  status: ToolEntry['status']
}) {
  const { c } = useSessionTokens()
  const [all, setAll] = useState(false)
  const agentId = useSession(props.sessionId)?.agentId
  const harness = agentId && isAgentId(agentId) ? harnessOf(agentId) : null
  const exit = exitOf(props.output, props.status, harness)
  const raw = exit.output?.replace(/\n$/, '') ?? ''
  const printed = raw.length > MOST_CHARS ? raw.slice(-MOST_CHARS) : raw
  const { shown, earlier } = shellTail(printed)
  const failed = (exit.code !== null && exit.code !== 0) || props.status === 'failed'
  return (
    <View>
      <StepSection label="命令" copy={props.command}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} bounces={false}>
          <Text style={[styles.mono, styles.command, { color: c.text }]}>{props.command}</Text>
        </ScrollView>
      </StepSection>
      {(printed !== '' || failed || props.output !== null) && (
        <StepSection
          label="输出"
          extra={
            failed ? (exit.code !== null && exit.code !== 0 ? `退出码 ${exit.code}` : '失败') : null
          }
          {...(printed !== '' ? { copy: plainOutput(raw) } : {})}
        >
          {printed === '' ? (
            <Text style={[styles.none, { color: c.textTertiary }]}>没有输出</Text>
          ) : (
            <>
              <Printed text={all ? printed : shown} color={c.text} />
              {earlier > 0 && !all && (
                <Pressable
                  onPress={() => setAll(true)}
                  hitSlop={6}
                  accessibilityRole="button"
                  accessibilityLabel={`显示全部，还有前面 ${earlier} 行`}
                  style={styles.earlier}
                >
                  <Text style={[styles.earlierText, { color: c.tint }]}>显示全部</Text>
                  <Text style={[styles.earlierText, { color: c.textTertiary }]}>
                    前面还有 {earlier} 行
                  </Text>
                </Pressable>
              )}
            </>
          )}
        </StepSection>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  section: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 12,
    gap: 8,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 30,
  },
  label: { fontSize: 12.5, fontWeight: '600' },
  copy: {
    width: 30,
    height: 30,
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mono: { fontFamily: MONO, fontSize: 13, lineHeight: 19 },
  command: { paddingRight: 12 },
  none: { fontSize: 13 },
  earlier: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' },
  earlierText: { fontSize: 13, fontWeight: '500' },
})
