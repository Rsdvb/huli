// The git panel's forms, as the desktop's git dialogs ask them: commit the chosen files (and push),
// create a pull request, publish the branch to a remote or the repository to GitHub, and a failed
// write's log. Each shows its own failure and stays open until its step went through.

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ActivityIndicator,
  Linking,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native'
import type { ChangedFile, GitRemote, GitStatus, GitTools, PullRequest } from '@shared/git'
import { isRepositoryName } from '@shared/git'
import type { HostLink } from '@shared/remote/link'
import { call, errorText, useGitRunning } from '../../git'
import {
  pullRequestHead,
  pushRequest,
  pushTargetOf,
  suggestPullRequest,
  type GitRequest,
} from '../../gitRules'
import { BottomSheet } from '../../ui/BottomSheet'
import { haptic } from '../../ui/haptics'
import { showNotice } from '../../ui/NoticeBar'
import { Press } from '../../ui/Press'
import { copyText } from '../../ui/session/feedback'
import { baseName } from '../../ui/session/format'
import { G, Icon } from '../../ui/session/icons'
import { MONO } from '../../ui/session/palette'
import { Counts } from '../../ui/session/TurnChanges'
import { radius, space, type as typeScale, useTokens } from '../../ui/tokens'
import type { GitSteps } from './useGitSteps'

function Label(props: { children: ReactNode }) {
  const { c } = useTokens()
  return (
    <Text style={[typeScale.footnote, styles.label, { color: c.textSecondary }]}>
      {props.children}
    </Text>
  )
}

function Button(props: {
  label: string
  onPress(): void
  busy?: boolean
  disabled?: boolean
  tone?: 'primary' | 'plain'
}) {
  const { c } = useTokens()
  const primary = props.tone !== 'plain'
  const off = props.disabled || props.busy
  return (
    <Press
      onPress={props.onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!props.busy }}
      containerStyle={styles.flex}
      style={[
        styles.button,
        { backgroundColor: primary ? c.accent : c.fill, opacity: props.disabled ? 0.45 : 1 },
      ]}
    >
      {props.busy ? (
        <ActivityIndicator color={primary ? c.onAccent : c.textSecondary} />
      ) : (
        <Text
          style={[typeScale.headline, { color: primary ? c.onAccent : c.text }]}
          numberOfLines={1}
        >
          {props.label}
        </Text>
      )}
    </Press>
  )
}

function Chip(props: { label: string; on: boolean; onPress(): void; lead?: ReactNode }) {
  const { c } = useTokens()
  return (
    <Press
      onPress={() => {
        haptic.select()
        props.onPress()
      }}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.on }}
      style={[
        styles.chip,
        {
          backgroundColor: props.on ? c.tintSoft : c.fill,
          borderColor: props.on ? c.tint : 'transparent',
        },
      ]}
    >
      {props.lead}
      <Text
        style={[typeScale.subhead, { color: props.on ? c.tint : c.textSecondary }]}
        numberOfLines={1}
      >
        {props.label}
      </Text>
    </Press>
  )
}

function ErrorText(props: { text: string | null; log?: string | null }) {
  const { c } = useTokens()
  if (!props.text) return null
  return (
    <View style={{ gap: space.xs }}>
      <Text style={[typeScale.footnote, { color: c.danger }]}>{props.text}</Text>
      {props.log ? (
        <Text
          selectable
          numberOfLines={6}
          style={[styles.mono, { color: c.textSecondary, backgroundColor: c.fill }]}
        >
          {props.log.trim()}
        </Text>
      ) : null}
    </View>
  )
}

function inputStyle(c: ReturnType<typeof useTokens>['c']) {
  return [typeScale.body, styles.input, { color: c.text, backgroundColor: c.fill }]
}

/** The files a commit can take: everything changed but a conflicted file. */
function committable(files: readonly ChangedFile[]): ChangedFile[] {
  return files.filter((file) => file.status !== 'conflicted')
}

export function CommitSheet(props: {
  visible: boolean
  status: GitStatus
  files: ChangedFile[]
  /** The files the opener chose; all of them when null. */
  paths: string[] | null
  steps: GitSteps
  onClose(): void
}) {
  const { c } = useTokens()
  const { status, steps } = props
  const files = useMemo(() => committable(props.files), [props.files])
  const [message, setMessage] = useState('')
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState<'commit' | 'push' | null>(null)
  const [error, setError] = useState<{ text: string; log: string } | null>(null)

  useEffect(() => {
    if (!props.visible) return
    const all = files.map((f) => f.path)
    setTicked(new Set(props.paths ? all.filter((p) => props.paths!.includes(p)) : all))
    setError(null)
    setBusy(null)
    // Opened again, it starts from the opener's choice; the message is kept for a retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.visible])

  const chosen = files.filter((f) => ticked.has(f.path))
  const ready = message.trim() !== '' && chosen.length > 0 && !busy

  const commit = async (andPush: boolean) => {
    if (!ready) return
    setBusy(andPush ? 'push' : 'commit')
    setError(null)
    const request: GitRequest = {
      kind: 'commit',
      message: message.trim(),
      paths: chosen.map((f) => f.path),
    }
    const result = await steps.run(request, { quiet: true, noNext: andPush })
    setBusy(null)
    if (!result.ok) {
      setError({ text: steps.failureText(request, result), log: result.log })
      return
    }
    setMessage('')
    props.onClose()
    if (andPush) steps.pushNow(result.operation.status)
  }

  return (
    <BottomSheet
      visible={props.visible}
      onClose={props.onClose}
      title={`提交到 ${status.head.branch ?? 'HEAD'}`}
      maxHeight={700}
    >
      <Label>提交信息</Label>
      <TextInput
        value={message}
        onChangeText={setMessage}
        placeholder={'用一行说明改了什么\n\n为什么改'}
        placeholderTextColor={c.textTertiary}
        multiline
        textAlignVertical="top"
        accessibilityLabel="提交信息"
        style={[...inputStyle(c), styles.message]}
      />
      <Label>
        已选 {chosen.length} / {files.length} 个文件
      </Label>
      <View>
        {files.map((file) => {
          const on = ticked.has(file.path)
          return (
            <Press
              key={file.path}
              scale={false}
              onPress={() => {
                haptic.select()
                setTicked((was) => {
                  const next = new Set(was)
                  if (on) next.delete(file.path)
                  else next.add(file.path)
                  return next
                })
              }}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={file.path}
              style={styles.fileRow}
            >
              <View
                style={[
                  styles.box,
                  {
                    borderColor: on ? c.tint : c.borderStrong,
                    backgroundColor: on ? c.tint : 'transparent',
                  },
                ]}
              >
                {on ? <Icon icon={G.check} size={12} color={c.onAccent} weight="bold" /> : null}
              </View>
              <Text
                style={[styles.filePath, { color: c.text }]}
                numberOfLines={1}
                ellipsizeMode="head"
              >
                {file.path}
              </Text>
              {file.insertions !== null && file.deletions !== null ? (
                <Counts insertions={file.insertions} deletions={file.deletions} size={12} />
              ) : null}
            </Press>
          )
        })}
      </View>
      <ErrorText text={error?.text ?? null} log={error?.log} />
      <View style={styles.buttons}>
        <Button
          label="提交"
          tone="plain"
          busy={busy === 'commit'}
          disabled={!ready}
          onPress={() => void commit(false)}
        />
        <Button
          label="提交并推送"
          busy={busy === 'push'}
          disabled={!ready || status.push === null}
          onPress={() => void commit(true)}
        />
      </View>
    </BottomSheet>
  )
}

/** The repository's remotes, read while a form that picks one shows. */
function useBranchList(link: HostLink, folder: string, active: boolean) {
  const [state, setState] = useState<{
    remotes: GitRemote[] | null
    branches: string[]
    error: string | null
  }>({ remotes: null, branches: [], error: null })
  useEffect(() => {
    if (!active) return
    let live = true
    call(link, 'git.branches', { projectPath: folder }).then(
      (list) =>
        live &&
        setState({
          remotes: list.remotes,
          branches: list.branches.map((b) => b.name),
          error: null,
        }),
      (error: unknown) =>
        live && setState({ remotes: null, branches: [], error: errorText(error, '没能列出分支') }),
    )
    return () => {
      live = false
    }
  }, [link, folder, active])
  return state
}

function remoteWhere(remote: GitRemote): string {
  return remote.github ? `github.com/${remote.github.owner}/${remote.github.repo}` : remote.url
}

export function PublishBranchSheet(props: {
  visible: boolean
  link: HostLink
  status: GitStatus
  steps: GitSteps
  onClose(): void
}) {
  const { c } = useTokens()
  const { status, steps } = props
  const branch = status.head.branch ?? ''
  const list = useBranchList(props.link, status.projectPath, props.visible)
  const [picked, setPicked] = useState<string | null>(null)
  const remote = picked ?? pushTargetOf(status)?.remote ?? list.remotes?.[0]?.name ?? null
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; log: string } | null>(null)

  const submit = async () => {
    if (!remote || busy) return
    setBusy(true)
    setError(null)
    const request: GitRequest = { kind: 'publishBranch', remote }
    const result = await steps.run(request, { quiet: true })
    setBusy(false)
    if (result.ok) props.onClose()
    else setError({ text: steps.failureText(request, result), log: result.log })
  }

  return (
    <BottomSheet
      visible={props.visible}
      onClose={props.onClose}
      title={`发布 ${branch}？`}
      message={`此分支还不在远程仓库上。Huli 会把它推送到 ${remote ?? 'origin'} 并跟踪它。`}
    >
      <Label>远程仓库</Label>
      {list.error ? (
        <Text style={[typeScale.footnote, { color: c.danger }]}>{list.error}</Text>
      ) : !list.remotes ? (
        <ActivityIndicator color={c.textSecondary} />
      ) : (
        <View style={styles.wrap}>
          {list.remotes.map((r) => (
            <Chip
              key={r.name}
              label={`${r.name} · ${remoteWhere(r)}`}
              on={r.name === remote}
              onPress={() => setPicked(r.name)}
            />
          ))}
        </View>
      )}
      <ErrorText text={error?.text ?? null} log={error?.log} />
      <View style={styles.buttons}>
        <Button label="发布" busy={busy} disabled={!remote} onPress={() => void submit()} />
      </View>
    </BottomSheet>
  )
}

export function PublishRepoSheet(props: {
  visible: boolean
  status: GitStatus
  tools: GitTools | null
  steps: GitSteps
  onClose(): void
}) {
  const { c } = useTokens()
  const { status, steps } = props
  const [name, setName] = useState('')
  const [visibility, setVisibility] = useState<'private' | 'public'>('private')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; log: string } | null>(null)
  const gh = props.tools?.gh ?? null

  useEffect(() => {
    if (props.visible) setName(baseName(status.repo?.root ?? status.projectPath))
  }, [props.visible, status.repo?.root, status.projectPath])

  const typed = name.trim()
  const valid = isRepositoryName(typed)
  const submit = async () => {
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    const request: GitRequest = { kind: 'publishRepo', name: typed, visibility }
    const result = await steps.run(request, { quiet: true })
    setBusy(false)
    if (result.ok) props.onClose()
    else setError({ text: steps.failureText(request, result), log: result.log })
  }

  return (
    <BottomSheet
      visible={props.visible}
      onClose={props.onClose}
      title="发布到 GitHub"
      message="在 GitHub 上创建仓库，添加为 origin，并推送此分支。"
    >
      {gh && gh.state !== 'ready' ? (
        <Text style={[typeScale.footnote, { color: c.warning }]}>
          {gh.state === 'signed-out'
            ? '发布需要 GitHub CLI。请先登录：gh auth login'
            : '发布需要 GitHub CLI。请先安装，再运行 gh auth login 登录。'}
        </Text>
      ) : null}
      <Label>仓库名称</Label>
      <TextInput
        value={name}
        onChangeText={setName}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="仓库名称"
        style={inputStyle(c)}
      />
      {typed !== '' && !valid ? (
        <Text style={[typeScale.footnote, { color: c.danger }]}>
          只能使用字母、数字、“.”、“-”和“_”，最多 100 个字符。
        </Text>
      ) : null}
      <Label>可见性</Label>
      <View style={styles.wrap}>
        <Chip label="私有" on={visibility === 'private'} onPress={() => setVisibility('private')} />
        <Chip label="公开" on={visibility === 'public'} onPress={() => setVisibility('public')} />
      </View>
      {gh?.account ? (
        <Text style={[typeScale.footnote, { color: c.textTertiary }]}>
          仓库将创建在 GitHub 账号 {gh.account} 下。
        </Text>
      ) : null}
      <ErrorText text={error?.text ?? null} log={error?.log} />
      <View style={styles.buttons}>
        <Button
          label="发布"
          busy={busy}
          disabled={!valid || gh?.state !== 'ready'}
          onPress={() => void submit()}
        />
      </View>
    </BottomSheet>
  )
}

export function CreatePrSheet(props: {
  visible: boolean
  link: HostLink
  status: GitStatus
  steps: GitSteps
  onClose(): void
  onCreated(pr: PullRequest): void
}) {
  const { c } = useTokens()
  const { status, steps, link } = props
  const folder = status.projectPath
  const target = pushTargetOf(status)
  const headBranch = target?.branch ?? status.head.branch ?? ''
  const list = useBranchList(link, folder, props.visible)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [base, setBase] = useState('')
  const [draft, setDraft] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; log: string | null } | null>(null)
  const running = useGitRunning(folder)

  useEffect(() => {
    if (!props.visible) return
    const initial = suggestPullRequest(status.head.branch ?? '', status.commits)
    setTitle(initial.title)
    setBody(initial.body)
    setBase(status.defaultBranch ?? '')
    setDraft(false)
    setError(null)
    // Filled once as it opens; edits stay while it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.visible])

  const pushesFirst = !!target && (target.setUpstream || (status.upstream?.ahead ?? 0) > 0)
  const valid = target !== null && title.trim() !== '' && base.trim() !== '' && base !== headBranch
  const choices = [...new Set([base, ...list.branches.filter((b) => b !== headBranch)])].filter(
    Boolean,
  )

  const submit = async () => {
    if (!valid || busy) return
    setBusy(true)
    setError(null)
    try {
      let now = status
      if (pushesFirst) {
        const request = pushRequest(status)
        const result = request ? await steps.run(request, { quiet: true, noNext: true }) : null
        if (!request || !result || !result.ok) {
          setError({
            text: request && result ? steps.failureText(request, result) : '推送失败',
            log: result && !result.ok ? result.log : null,
          })
          return
        }
        now = result.operation.status
      }
      if (!pullRequestHead(now)) {
        setError({ text: '此分支还不在 GitHub 上。', log: null })
        return
      }
      const pr = await call(link, 'git.createPullRequest', {
        projectPath: folder,
        title: title.trim(),
        body,
        base: base.trim(),
        draft,
      })
      haptic.success()
      props.onCreated(pr)
      props.onClose()
      showNotice({
        text: `已创建拉取请求 #${pr.number}`,
        tone: 'success',
        action: { label: '打开', onPress: () => void Linking.openURL(pr.url) },
      })
    } catch (e) {
      haptic.warning()
      setError({ text: errorText(e, '没能创建 Pull Request'), log: null })
    } finally {
      setBusy(false)
    }
  }

  return (
    <BottomSheet
      visible={props.visible}
      onClose={props.onClose}
      title="创建 Pull Request"
      maxHeight={720}
    >
      <View style={styles.branchLine}>
        <Icon icon={G.branch} size={14} color={c.textSecondary} />
        <Text style={[typeScale.subhead, { color: c.text }]} numberOfLines={1}>
          {base || '…'}
        </Text>
        <Icon icon={G.back} size={12} color={c.textTertiary} />
        <Text style={[styles.monoInline, { color: c.text }]} numberOfLines={1}>
          {headBranch}
        </Text>
        <Text style={[typeScale.caption, { color: c.textTertiary }]}>
          {status.commits.length} 个提交
        </Text>
      </View>
      <Label>目标分支</Label>
      {list.error ? (
        <Text style={[typeScale.footnote, { color: c.danger }]}>{list.error}</Text>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.row}
        >
          {choices.map((name) => (
            <Chip key={name} label={name} on={name === base} onPress={() => setBase(name)} />
          ))}
        </ScrollView>
      )}
      <Label>标题</Label>
      <TextInput
        value={title}
        onChangeText={setTitle}
        accessibilityLabel="标题"
        style={inputStyle(c)}
      />
      <Label>描述</Label>
      <TextInput
        value={body}
        onChangeText={setBody}
        multiline
        textAlignVertical="top"
        accessibilityLabel="描述"
        style={[...inputStyle(c), styles.body]}
      />
      <View style={styles.switchLine}>
        <Text style={[typeScale.callout, styles.flex, { color: c.text }]}>作为草稿创建</Text>
        <Switch
          value={draft}
          onValueChange={(on) => {
            haptic.select()
            setDraft(on)
          }}
          trackColor={{ true: c.success }}
          accessibilityLabel="作为草稿创建"
        />
      </View>
      {pushesFirst ? (
        <Text style={[typeScale.footnote, { color: c.textTertiary }]}>会先推送</Text>
      ) : null}
      <ErrorText text={error?.text ?? null} log={error?.log} />
      <View style={styles.buttons}>
        <Button
          label="创建拉取请求"
          busy={busy}
          disabled={!valid || (running !== null && !busy)}
          onPress={() => void submit()}
        />
      </View>
    </BottomSheet>
  )
}

export function LogSheet(props: { visible: boolean; title: string; log: string; onClose(): void }) {
  const { c } = useTokens()
  return (
    <BottomSheet
      visible={props.visible}
      onClose={props.onClose}
      title={props.title}
      maxHeight={640}
    >
      <ScrollView nestedScrollEnabled style={[styles.logBox, { backgroundColor: c.fill }]}>
        <Text
          selectable
          style={[styles.mono, { color: props.log.trim() ? c.text : c.textTertiary }]}
        >
          {props.log.trim() || '没有输出'}
        </Text>
      </ScrollView>
      <View style={styles.buttons}>
        <Button
          label="复制日志"
          tone="plain"
          disabled={!props.log.trim()}
          onPress={() =>
            void copyText(props.log).then(() => showNotice({ text: '已复制', tone: 'success' }))
          }
        />
      </View>
    </BottomSheet>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  label: { marginTop: space.xs, marginLeft: space.xs },
  input: {
    borderRadius: radius.md,
    paddingHorizontal: space.md + 2,
    paddingVertical: space.md,
    minHeight: 48,
  },
  message: { minHeight: 110, maxHeight: 200 },
  body: { minHeight: 140, maxHeight: 260 },
  buttons: { flexDirection: 'row', gap: space.sm + 2, marginTop: space.xs },
  button: {
    height: 50,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.md,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs + 2,
    height: 36,
    paddingHorizontal: space.md + 2,
    borderRadius: radius.pill,
    borderWidth: 1,
    maxWidth: 320,
  },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  row: { gap: space.sm, paddingRight: space.lg },
  fileRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 40 },
  box: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filePath: { flex: 1, fontFamily: MONO, fontSize: 13 },
  mono: {
    fontFamily: MONO,
    fontSize: 12,
    lineHeight: 17,
    borderRadius: radius.sm,
    padding: space.sm,
  },
  monoInline: { flex: 1, fontFamily: MONO, fontSize: 13 },
  branchLine: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  switchLine: { flexDirection: 'row', alignItems: 'center', marginTop: space.xs },
  logBox: { maxHeight: 440, borderRadius: radius.md, padding: space.sm },
})
