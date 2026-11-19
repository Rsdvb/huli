// Switches the branch of the folder a session works in, as the desktop's branch switcher does: a
// search over the branches, this session's first, then the rest by their last commit with the
// default on top, and a new branch from here by the name typed. A branch checked out in another
// worktree opens that worktree's latest session instead.

import { useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Stack, router, useLocalSearchParams } from 'expo-router'
import type { BranchInfo, BranchList } from '@shared/git'
import { call, errorText, runGit, sessionFolder, useChanges } from '../../git'
import { branchLabel, failureNote, isBranchName, recentBranches, sameFolder } from '../../gitRules'
import { getHost, useConnected, useHostActions, useLink, useSession } from '../../host'
import { ago } from '../../sessions'
import { haptic } from '../../ui/haptics'
import { showNotice } from '../../ui/NoticeBar'
import { goBack, GlassHeader } from '../../ui/session/GlassHeader'
import { GI } from '../../ui/session/gitIcons'
import { G, Icon } from '../../ui/session/icons'
import { MONO, useSessionTokens } from '../../ui/session/palette'
import { StateView } from '../../ui/session/StateView'

type Row =
  | { kind: 'label'; key: string; text: string }
  | { kind: 'branch'; key: string; name: string; branch: BranchInfo | undefined }
  | { kind: 'new'; key: string }

type Loaded = { list: BranchList; error: null } | { list: null; error: string } | null

export default function BranchesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { c, s } = useSessionTokens()
  const { retry } = useHostActions()
  const link = useLink()
  const summary = useSession(id)
  const folder = summary && !summary.scratch ? sessionFolder(summary) : null
  const { status } = useChanges(link, folder)
  const [loaded, setLoaded] = useState<Loaded>(null)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ text: string; log: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const connected = useConnected()

  useEffect(() => {
    if (!folder || !connected) return
    let live = true
    call(link, 'git.branches', { projectPath: folder }).then(
      (list) => live && setLoaded({ list, error: null }),
      (error: unknown) =>
        live && setLoaded({ list: null, error: errorText(error, '没能列出分支') }),
    )
    return () => {
      live = false
    }
  }, [link, folder, connected, attempt])

  const current = status && !status.head.detached ? status.head.branch : null
  const defaultBranch = status?.defaultBranch ?? null
  const byName = useMemo(
    () => new Map((loaded?.list?.branches ?? []).map((b) => [b.name, b])),
    [loaded],
  )
  const typed = query.trim()
  const creates = typed !== '' && !byName.has(typed) && isBranchName(typed)
  const invalid = typed !== '' && !byName.has(typed) && !isBranchName(typed)

  const rows = useMemo((): Row[] => {
    const match = (name: string) => !typed || name.toLowerCase().includes(typed.toLowerCase())
    const recent = recentBranches(
      (loaded?.list?.branches ?? []).map((b) => b.name),
      current,
      defaultBranch,
    ).filter(match)
    const out: Row[] = []
    if (current && match(current)) {
      out.push({ kind: 'label', key: 'l:session', text: '此会话' })
      out.push({ kind: 'branch', key: `b:${current}`, name: current, branch: byName.get(current) })
    }
    if (recent.length > 0) {
      out.push({ kind: 'label', key: 'l:recent', text: '最近' })
      for (const name of recent)
        out.push({ kind: 'branch', key: `b:${name}`, name, branch: byName.get(name) })
    }
    if (creates) out.push({ kind: 'new', key: 'new' })
    return out
  }, [loaded, typed, current, defaultBranch, byName, creates])

  const switchTo = async (name: string, create: boolean) => {
    if (!folder || busy) return
    setBusy(name)
    setFailure(null)
    haptic.tap()
    const request = { kind: 'switch' as const, branch: name, create }
    const result = await runGit(link, folder, request)
    setBusy(null)
    if (result.ok) {
      haptic.success()
      showNotice({ text: create ? `已新建 ${name}` : `已切换到 ${name}`, tone: 'success' })
      goBack()
      return
    }
    haptic.warning()
    setFailure({ text: failureNote(request, result.log, result.busy).text, log: result.log })
  }

  const openWorktree = (branch: BranchInfo) => {
    const where = branch.worktree!
    const session = [...getHost().sessions.values()]
      .filter(
        (x) =>
          x.archivedAt === null && x.origin !== 'subagent' && sameFolder(sessionFolder(x), where),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (session) {
      router.replace(`/session/${session.id}`)
      return
    }
    showNotice({ text: `${branch.name} 已在 ${where} 中检出`, tone: 'info' })
  }

  const choose = (name: string) => {
    if (name === current) return goBack()
    const branch = byName.get(name)
    if (branch?.worktree) return openWorktree(branch)
    void switchTo(name, false)
  }

  const side = (name: string, branch: BranchInfo | undefined): string | null => {
    if (name === current) {
      const ahead = status?.upstream?.ahead ?? 0
      return ahead > 0 ? `↑${ahead}` : null
    }
    if (!branch) return null
    if (branch.worktree) return '在工作树中'
    if (branch.name === defaultBranch) return '默认'
    return branch.committedAt ? ago(branch.committedAt) : null
  }

  const renderRow = ({ item }: { item: Row }) => {
    if (item.kind === 'label') {
      return <Text style={[styles.label, { color: c.textSecondary }]}>{item.text}</Text>
    }
    if (item.kind === 'new') {
      return (
        <Pressable
          onPress={() => void switchTo(typed, true)}
          disabled={busy !== null}
          accessibilityRole="button"
          style={({ pressed }) => [
            styles.row,
            { backgroundColor: pressed ? c.fill : s.dockCard, marginTop: 14 },
          ]}
        >
          {busy === typed ? (
            <ActivityIndicator size="small" color={c.textSecondary} />
          ) : (
            <Icon icon={G.plus} size={16} color={c.tint} weight="semibold" />
          )}
          <View style={styles.flex}>
            <Text style={[styles.name, { color: c.tint }]} numberOfLines={1}>
              从此处新建 {typed}
            </Text>
            {status ? (
              <Text style={[styles.note, { color: c.textTertiary }]} numberOfLines={2}>
                {status.head.detached
                  ? `从 ${status.head.oid?.slice(0, 7) ?? 'HEAD'} 开始并切换过去；未提交的更改会一起带上。`
                  : `从 ${status.head.branch ?? 'HEAD'} 开始并切换过去；未提交的更改会一起带上。`}
              </Text>
            ) : null}
          </View>
        </Pressable>
      )
    }
    const on = item.name === current
    const note = side(item.name, item.branch)
    return (
      <Pressable
        onPress={() => choose(item.name)}
        disabled={busy !== null}
        accessibilityRole="button"
        accessibilityState={{ selected: on, busy: busy === item.name }}
        accessibilityLabel={`${item.name}${note ? `，${note}` : ''}`}
        style={({ pressed }) => [styles.row, { backgroundColor: pressed ? c.fill : s.dockCard }]}
      >
        <View style={styles.check}>
          {busy === item.name ? (
            <ActivityIndicator size="small" color={c.textSecondary} />
          ) : on ? (
            <Icon icon={G.check} size={14} color={c.tint} weight="bold" />
          ) : null}
        </View>
        <Icon icon={item.branch?.worktree ? G.fork : G.branch} size={15} color={c.textSecondary} />
        <Text style={[styles.name, styles.flex, { color: c.text }]} numberOfLines={1}>
          {item.name}
        </Text>
        {note ? <Text style={[styles.side, { color: c.textTertiary }]}>{note}</Text> : null}
      </Pressable>
    )
  }

  let body
  // Away, a read waits for the computer: say so rather than spin.
  const away = <StateView text="电脑没有连上，连上后会再显示。" icon={G.wifiOff} retry={retry} />
  if (!summary) {
    body = connected ? <StateView text="找不到这个会话。" /> : away
  } else if (!folder) {
    body = <StateView text="这个会话没有项目，没有分支可切换。" />
  } else if (loaded?.error) {
    body = <StateView text={loaded.error} tone="danger" retry={() => setAttempt((n) => n + 1)} />
  } else if (!loaded) {
    body = connected ? <StateView loading /> : away
  } else {
    body = (
      <FlatList
        data={rows}
        keyExtractor={(row) => row.key}
        renderItem={renderRow}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View style={{ gap: 8 }}>
            <View style={[styles.search, { backgroundColor: c.fill }]}>
              <Icon icon={GI.search} size={15} color={c.textTertiary} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="查找或新建分支"
                placeholderTextColor={c.textTertiary}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                clearButtonMode="while-editing"
                returnKeyType={creates ? 'go' : 'search'}
                onSubmitEditing={() => {
                  if (byName.has(typed)) choose(typed)
                  else if (creates) void switchTo(typed, true)
                }}
                accessibilityLabel="查找或新建分支"
                style={[styles.input, { color: c.text }]}
              />
            </View>
            {invalid ? (
              <Text style={[styles.note, { color: c.danger }]}>Git 不能用它作为分支名。</Text>
            ) : null}
            {failure ? (
              <View style={[styles.failure, { backgroundColor: s.dangerSoft }]}>
                <Text style={[styles.note, { color: c.danger }]}>{failure.text}</Text>
                {failure.log ? (
                  <Text
                    selectable
                    numberOfLines={6}
                    style={[styles.log, { color: c.textSecondary }]}
                  >
                    {failure.log.trim()}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          <Text style={[styles.empty, { color: c.textTertiary }]}>
            {typed ? `没有匹配“${typed}”的分支` : '还没有分支'}
          </Text>
        }
      />
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen options={{ headerShown: false }} />
      <GlassHeader title="切换分支" subtitle={status ? branchLabel(status) : null} />
      {body}
    </View>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  list: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 40 },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 12,
    paddingHorizontal: 12,
    height: 44,
  },
  input: { flex: 1, fontSize: 16, height: 44 },
  label: { fontSize: 13, fontWeight: '600', marginTop: 16, marginBottom: 6, marginLeft: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 50,
    paddingHorizontal: 12,
    borderRadius: 12,
    marginBottom: 2,
  },
  check: { width: 18, alignItems: 'center' },
  name: { fontSize: 15, fontWeight: '500' },
  side: { fontSize: 12, fontVariant: ['tabular-nums'] },
  note: { fontSize: 13, lineHeight: 18 },
  failure: { borderRadius: 12, padding: 10, gap: 6 },
  log: { fontFamily: MONO, fontSize: 11.5, lineHeight: 16 },
  empty: { textAlign: 'center', paddingTop: 32, fontSize: 14 },
})
