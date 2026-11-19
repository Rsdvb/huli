// An MCP server's request through the agent, as the desktop's card asks it: a form to fill in, or
// a page to open in the phone's browser. Nothing goes back to the server until the user confirms.

import { useState } from 'react'
import { Linking, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import type { FormField, FormValues, PendingElicitation, ToolEntry } from '@shared/thread'
import { call } from '../../git'
import { useLink } from '../../host'
import { haptic } from '../../ui/session/feedback'
import { useSessionTokens } from '../../ui/session/palette'
import { useAgentName } from './AccessEntries'
import { AskCard, E, kit, QuietLine, useSender } from './kit'

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

function webUrl(url: string): URL | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null
  } catch {
    return null
  }
}

/** The site a link names: its host, without a leading www. */
function siteOf(url: string): string {
  return webUrl(url)?.hostname.replace(/^www\./, '') ?? url
}

function startValues(fields: FormField[]): Partial<FormValues> {
  const values: Partial<FormValues> = {}
  for (const field of fields) {
    if (field.default !== undefined) values[field.key] = field.default
    else if (field.type === 'boolean') values[field.key] = false
    else if (field.type === 'choices') values[field.key] = []
  }
  return values
}

/** Why a field's value cannot go, or null; the computer checks the same again. */
function fieldError(field: FormField, value: FormValues[string] | undefined): string | null {
  const empty = value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
  if (empty) return field.required ? '必填' : null
  switch (field.type) {
    case 'text': {
      const text = String(value)
      if (field.minLength !== undefined && text.length < field.minLength)
        return `至少 ${field.minLength} 个字符`
      if (field.maxLength !== undefined && text.length > field.maxLength)
        return `最多 ${field.maxLength} 个字符`
      if (field.format === 'email' && !EMAIL.test(text)) return '不是邮箱地址'
      if (field.format === 'uri' && !webUrl(text)) return '不是网址'
      if (field.format === 'date' && !DATE.test(text)) return '不是日期'
      return null
    }
    case 'number': {
      const n = Number(value)
      if (!Number.isFinite(n) || (field.integer && !Number.isInteger(n)))
        return field.integer ? '不是整数' : '不是数字'
      if (field.minimum !== undefined && n < field.minimum) return `至少为 ${field.minimum}`
      if (field.maximum !== undefined && n > field.maximum) return `最多为 ${field.maximum}`
      return null
    }
    case 'choices': {
      const count = (value as string[]).length
      if (field.minItems !== undefined && count < field.minItems)
        return `至少选 ${field.minItems} 项`
      if (field.maxItems !== undefined && count > field.maxItems)
        return `最多选 ${field.maxItems} 项`
      return null
    }
    default:
      return null
  }
}

function toValues(fields: FormField[], draft: Partial<FormValues>): FormValues {
  const values: FormValues = {}
  for (const field of fields) {
    const value = draft[field.key]
    if (value === undefined || value === '') continue
    if (Array.isArray(value) && value.length === 0 && !field.required) continue
    values[field.key] = field.type === 'number' ? Number(value) : value
  }
  return values
}

function Chips(props: {
  choices: { value: string; label: string }[]
  picked: string[]
  multiple: boolean
  onChange(next: string[]): void
}) {
  const { c, s } = useSessionTokens()
  return (
    <View style={kit.chips}>
      {props.choices.map((choice) => {
        const on = props.picked.includes(choice.value)
        return (
          <Pressable
            key={choice.value}
            onPress={() => {
              haptic.pick()
              props.onChange(
                props.multiple
                  ? on
                    ? props.picked.filter((v) => v !== choice.value)
                    : [...props.picked, choice.value]
                  : [choice.value],
              )
            }}
            accessibilityRole={props.multiple ? 'checkbox' : 'radio'}
            accessibilityState={{ checked: on }}
            style={[
              kit.chip,
              {
                borderColor: on ? c.accent : c.border,
                backgroundColor: on ? s.accentSoft : c.fill,
              },
            ]}
          >
            <Text style={[kit.chipText, { color: on ? c.accent : c.text }]}>{choice.label}</Text>
          </Pressable>
        )
      })}
    </View>
  )
}

function FieldControl(props: {
  field: FormField
  value: FormValues[string] | undefined
  invalid: boolean
  onChange(value: FormValues[string]): void
}) {
  const { c } = useSessionTokens()
  const { field, value } = props
  const input = [
    kit.field,
    {
      color: c.text,
      borderColor: props.invalid ? c.danger : c.border,
      backgroundColor: c.fill,
    },
  ]
  switch (field.type) {
    case 'boolean':
      return (
        <Switch
          value={value === true}
          onValueChange={(on) => props.onChange(on)}
          trackColor={{ true: c.accent, false: c.fillStrong }}
          accessibilityLabel={field.title}
        />
      )
    case 'choice':
      return (
        <Chips
          choices={field.choices}
          picked={typeof value === 'string' && value ? [value] : []}
          multiple={false}
          onChange={(next) => props.onChange(next[0] ?? '')}
        />
      )
    case 'choices':
      return (
        <Chips
          choices={field.choices}
          picked={Array.isArray(value) ? value : []}
          multiple
          onChange={(next) => props.onChange(next)}
        />
      )
    case 'number':
      return (
        <TextInput
          value={value === undefined ? '' : String(value)}
          onChangeText={(text) => props.onChange(text)}
          keyboardType={field.integer ? 'number-pad' : 'decimal-pad'}
          selectionColor={c.accent}
          accessibilityLabel={field.title}
          style={input}
        />
      )
    case 'text':
      return (
        <TextInput
          value={typeof value === 'string' ? value : ''}
          onChangeText={(text) => props.onChange(text)}
          keyboardType={
            field.format === 'email' ? 'email-address' : field.format === 'uri' ? 'url' : 'default'
          }
          autoCapitalize={field.format ? 'none' : 'sentences'}
          {...(field.format === 'date' ? { placeholder: 'YYYY-MM-DD' } : {})}
          placeholderTextColor={c.textTertiary}
          {...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {})}
          selectionColor={c.accent}
          accessibilityLabel={field.title}
          style={input}
        />
      )
  }
}

/** The card above the composer for a tool call whose permission is an MCP server's request. */
export function ElicitationCard(props: { entry: ToolEntry; sessionId: string }) {
  const { entry, sessionId } = props
  const request = entry.permission!.elicitation!
  return request.kind === 'form' ? (
    <FormCard entry={entry} sessionId={sessionId} request={request} />
  ) : (
    <LinkCard entry={entry} sessionId={sessionId} request={request} />
  )
}

function FormCard(props: {
  entry: ToolEntry
  sessionId: string
  request: Extract<PendingElicitation, { kind: 'form' }>
}) {
  const { entry, sessionId, request } = props
  const { c } = useSessionTokens()
  const link = useLink()
  const agent = useAgentName(sessionId)
  const sender = useSender(entry.id)
  const permission = entry.permission!
  const [draft, setDraft] = useState(() => startValues(request.fields))
  const [tried, setTried] = useState(false)
  const decline = permission.options.find((o) => o.kind === 'reject_once')
  const errors = request.fields.map((field) => fieldError(field, draft[field.key]))

  const submit = async () => {
    setTried(true)
    if (errors.some((e) => e !== null)) return false
    return call(link, 'permissions.respond', {
      sessionId,
      requestId: permission.requestId,
      values: toValues(request.fields, draft),
    })
  }

  return (
    <AskCard
      icon={E.mcp}
      title={request.server}
      body={`${agent} 里的 MCP 服务器`}
      sender={sender}
      footnote={`发给 ${request.server}`}
      actions={[
        ...(decline
          ? [
              {
                key: 'decline',
                label: '拒绝',
                run: () =>
                  call(link, 'permissions.respond', {
                    sessionId,
                    requestId: permission.requestId,
                    optionId: decline.id,
                  }),
              },
            ]
          : []),
        { key: 'submit', label: '提交', tone: 'primary', run: submit },
      ]}
    >
      {request.message ? (
        <Text selectable style={[styles.message, { color: c.text }]}>
          {request.message}
        </Text>
      ) : null}
      {request.fields.map((field, i) => {
        const shown = tried ? errors[i] : null
        return (
          <View key={field.key} style={kit.section}>
            <Text style={[kit.label, { color: c.textSecondary }]}>
              {field.title}
              {!field.required && field.type !== 'boolean' ? (
                <Text style={{ color: c.textTertiary, fontWeight: '400' }}> 可选</Text>
              ) : null}
            </Text>
            <FieldControl
              field={field}
              value={draft[field.key]}
              invalid={!!shown}
              onChange={(value) => setDraft((d) => ({ ...d, [field.key]: value }))}
            />
            {field.description ? (
              <Text style={[kit.hint, { color: c.textTertiary }]}>{field.description}</Text>
            ) : null}
            {shown ? <Text style={[kit.hint, { color: c.danger }]}>{shown}</Text> : null}
          </View>
        )
      })}
    </AskCard>
  )
}

function LinkCard(props: {
  entry: ToolEntry
  sessionId: string
  request: Extract<PendingElicitation, { kind: 'url' }>
}) {
  const { entry, sessionId, request } = props
  const { c } = useSessionTokens()
  const link = useLink()
  const agent = useAgentName(sessionId)
  const sender = useSender(entry.id)
  const permission = entry.permission!
  const accept = permission.options.find((o) => o.kind === 'allow_once')
  const decline = permission.options.find((o) => o.kind === 'reject_once')
  const usable = webUrl(request.url) !== null
  const site = siteOf(request.url)
  const respond = (optionId: string) =>
    call(link, 'permissions.respond', { sessionId, requestId: permission.requestId, optionId })
  return (
    <AskCard
      icon={E.mcp}
      title={request.server}
      body={`${agent} 里的 MCP 服务器`}
      target={request.url}
      mono
      sender={sender}
      footnote="在浏览器中打开。你在那里填的内容纸鸢看不到。"
      actions={[
        ...(decline ? [{ key: 'decline', label: '拒绝', run: () => respond(decline.id) }] : []),
        ...(accept
          ? [
              {
                key: 'open',
                label: `打开 ${site}`,
                tone: 'primary' as const,
                disabled: !usable,
                run: async () => {
                  await respond(accept.id)
                  await Linking.openURL(request.url).catch(() => {})
                },
              },
            ]
          : []),
      ]}
    >
      {request.message ? (
        <Text selectable style={[styles.message, { color: c.text }]}>
          {request.message}
        </Text>
      ) : null}
    </AskCard>
  )
}

/** An MCP server's request once answered: the server and what became of it. */
export function ElicitationSettled(props: { entry: ToolEntry }) {
  const { entry } = props
  const { c } = useSessionTokens()
  const [open, setOpen] = useState(false)
  const asked = entry.elicitation!
  const result = entry.permissionResult
  const accepted =
    typeof result === 'object' &&
    result !== null &&
    (result.kind === 'allow_once' || result.kind === 'allow_always')
  const fields = typeof result === 'object' && result !== null ? (result.fields ?? []) : []
  const url = asked.kind === 'url' ? (asked.url ?? null) : null
  const finishing = accepted && url !== null && entry.status === 'in_progress'
  const state = finishing
    ? `在浏览器中完成 ${siteOf(url)} 上的操作`
    : accepted
      ? url !== null
        ? `已打开 ${siteOf(url)}`
        : '已提交'
      : result === 'cancelled' || result === 'withdrawn'
        ? '已取消'
        : result
          ? '已拒绝'
          : '等待中'
  const device = typeof result === 'object' && result?.device ? `在 ${result.device.name} 上` : null
  return (
    <View>
      <QuietLine
        icon={E.mcp}
        tone={finishing ? 'busy' : accepted ? 'done' : 'other'}
        text={asked.server}
        detail={[state, device].filter(Boolean).join(' · ')}
        {...(finishing && url
          ? { onPress: () => void Linking.openURL(url).catch(() => {}) }
          : fields.length > 0
            ? { onPress: () => setOpen((v) => !v) }
            : {})}
      />
      {open && fields.length > 0 && (
        <View style={styles.values}>
          {fields.map((field, i) => (
            <Text key={i} selectable style={[styles.value, { color: c.textSecondary }]}>
              <Text style={{ color: c.textTertiary }}>{field.title}：</Text>
              {field.value}
            </Text>
          ))}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  message: { fontSize: 14, lineHeight: 20, marginTop: 10 },
  values: { marginLeft: 21, gap: 2, marginBottom: 4 },
  value: { fontSize: 13, lineHeight: 18 },
})
