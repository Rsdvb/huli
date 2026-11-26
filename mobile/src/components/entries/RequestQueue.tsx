// Huli: what waits behind the request answered now, as one line under its card, the way the
// desktop stacks them: 后面还有 N 个请求 opens to list them, and where two or more are plain
// requests, 全部同意 / 全部拒绝 list what they answer and what they leave before anything is sent.
// An allow never takes a high request; those wait for their own card.

import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { bulkSplit, type QueuedRequest } from '@shared/permission-queue'
import type { HostLink } from '@shared/remote/link'
import { sessionFolder } from '../../git'
import { useConnected, useSession } from '../../host'
import { G, Icon, TOOL_ICONS } from '../../ui/session/icons'
import { MONO, useSessionTokens } from '../../ui/session/palette'
import { toolLabel } from '../../ui/session/work'
import { CardButton, SendState, useSender } from './kit'

type Decision = 'allow' | 'deny'

const RISK_WORDS = { low: '低风险', medium: '中风险', high: '高风险' } as const

/** `queue` starts with the request answered now; key it by the queue so its state starts anew. */
export function RequestQueue(props: {
  queue: readonly QueuedRequest[]
  sessionId: string
  link: HostLink
}) {
  const { queue, sessionId, link } = props
  const { c, s } = useSessionTokens()
  const connected = useConnected()
  const summary = useSession(sessionId)
  const root = summary && !summary.scratch ? sessionFolder(summary) : null
  const sender = useSender()
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState<Decision | null>(null)
  const later = queue.slice(1)
  const splits = { allow: bulkSplit(queue, 'allow'), deny: bulkSplit(queue, 'deny') }
  const offers = (decision: Decision) => splits[decision].answered.length > 1
  const busy = sender.busy !== null || !connected
  const split = confirming ? splits[confirming] : null

  const confirm = () => {
    if (!confirming || !split || busy) return
    const decision = confirming
    const requestIds = split.answered.map((entry) => entry.permission.requestId)
    void sender.send(decision, () =>
      link.request('permissions.respondAll', { sessionId, requestIds, decision }),
    )
  }

  const rows = (entries: readonly QueuedRequest[]) => (
    <View style={styles.list}>
      {entries.map((entry) => {
        const label = toolLabel(entry, root)
        const text = (entry.question ?? [label.verb, label.target].filter(Boolean).join(' ')).split(
          '\n',
        )[0]
        const risk = entry.permission.risk
        const tone = risk
          ? {
              low: { color: c.success, soft: s.successSoft },
              medium: { color: c.warning, soft: s.warningSoft },
              high: { color: c.danger, soft: s.dangerSoft },
            }[risk.level]
          : null
        return (
          <View key={entry.id} style={styles.row}>
            <Icon icon={TOOL_ICONS[entry.toolKind]} size={14} color={c.textTertiary} />
            <Text style={[styles.what, { color: c.text }]} numberOfLines={1}>
              {text}
            </Text>
            {risk && tone ? (
              <View style={[styles.risk, { backgroundColor: tone.soft }]}>
                <Text style={[styles.riskText, { color: tone.color }]}>
                  {RISK_WORDS[risk.level]}
                </Text>
              </View>
            ) : null}
          </View>
        )
      })}
    </View>
  )

  return (
    <View
      style={[styles.queue, { backgroundColor: c.fill, borderColor: c.borderStrong }]}
      testID="request-queue"
    >
      <View style={styles.bar}>
        <Pressable
          style={styles.toggle}
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          onPress={() => {
            if (confirming) setConfirming(null)
            else setOpen((was) => !was)
          }}
        >
          <View style={{ transform: [{ rotate: open || confirming ? '180deg' : '0deg' }] }}>
            <Icon icon={G.down} size={14} color={c.textSecondary} />
          </View>
          <Text style={[styles.toggleText, { color: c.textSecondary }]}>
            后面还有 {later.length} 个请求
          </Text>
        </Pressable>
      </View>
      {!confirming && (offers('allow') || offers('deny')) ? (
        <View style={styles.actions}>
          {offers('deny') ? (
            <CardButton label="全部拒绝" tone="danger" onPress={() => setConfirming('deny')} />
          ) : null}
          {offers('allow') ? (
            <CardButton label="全部同意" onPress={() => setConfirming('allow')} />
          ) : null}
        </View>
      ) : null}
      {confirming && split ? (
        <View>
          <Text style={[styles.title, { color: c.text }]}>
            {confirming === 'allow'
              ? `全部同意：以下 ${split.answered.length} 个请求各允许一次`
              : `全部拒绝：以下 ${split.answered.length} 个请求都拒绝`}
          </Text>
          {rows(split.answered)}
          {split.skipped.length > 0 ? (
            <>
              <Text style={[styles.title, { color: c.text }]}>
                {confirming === 'allow'
                  ? '这些不会一起同意，等轮到时逐个回答：'
                  : '这些要等轮到时逐个回答：'}
              </Text>
              {rows(split.skipped)}
            </>
          ) : null}
          <View style={styles.actions}>
            <CardButton label="取消" disabled={busy} onPress={() => setConfirming(null)} />
            <CardButton
              label={`${confirming === 'allow' ? '同意' : '拒绝'} ${split.answered.length} 个`}
              tone={confirming === 'allow' ? 'primary' : 'danger'}
              busy={sender.busy === confirming}
              disabled={busy}
              onPress={confirm}
            />
          </View>
          <SendState sender={sender} />
        </View>
      ) : open ? (
        rows(later)
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  queue: {
    marginTop: -6,
    marginHorizontal: 10,
    paddingHorizontal: 12,
    paddingTop: 2,
    paddingBottom: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderTopWidth: 0,
    borderBottomLeftRadius: 16,
    borderBottomRightRadius: 16,
  },
  bar: { flexDirection: 'row', alignItems: 'center', minHeight: 36 },
  toggle: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36 },
  toggleText: { fontSize: 13, fontWeight: '500' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, paddingTop: 4 },
  title: { fontSize: 13, marginTop: 6, marginBottom: 2 },
  list: { gap: 2, paddingTop: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 28 },
  what: { flex: 1, fontSize: 12.5, fontFamily: MONO },
  risk: { borderRadius: 5, paddingHorizontal: 6, paddingVertical: 1 },
  riskText: { fontSize: 11, fontWeight: '600' },
})
