// An artifact, full screen: its pages in a web view, a document or a deck natively, a canvas page by
// page; its versions, comments and actions in a glass header; kept current while it is open
// (`artifacts.watch`), with a quiet note when a new version replaces the one shown and a mark
// while an agent edits it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { router, Stack } from 'expo-router'
import { MessageSquare } from 'lucide-react-native'
import type { HostEvent } from '@shared/agent-host'
import type { CommentAnchor } from '@shared/artifact-comments'
import type { PageSelection } from '@shared/artifact-runtime/page-messages'
import { ARTIFACT_TITLE_CHARS, type ArtifactSummary, type VersionSummary } from '@shared/artifacts'
import { artifactKind, KIND_TEXT } from '../artifacts'
import { formatBytes } from '../attachments'
import { confirmDelete } from '../components/ArtifactSheet'
import { RenameDialog } from '../components/RenameDialog'
import { Sheet, type SheetItem } from '../components/Sheet'
import { useHost } from '../host'
import { whenText } from '../routines'
import { errorText, sessionTitle } from '../sessions'
import { haptic } from '../ui/haptics'
import { Skeleton } from '../ui/Skeleton'
import { GlassHeader, goBack, useHeaderHeight } from '../ui/session/GlassHeader'
import { G, Icon, type IconSpec } from '../ui/session/icons'
import { useSessionTokens } from '../ui/session/palette'
import { PressScale, RoundButton } from '../ui/session/Press'
import { StateView } from '../ui/session/StateView'
import { ArtifactFrame } from './ArtifactFrame'
import { pageName, viewOf, type ViewPage } from './canvas'
import { pageAnchor, pinsOf, useComments, type CommentPage } from './comments'
import { CommentsSheet, type CommentTarget } from './CommentsSheet'
import { loadVersion, TooLarge, type LoadedVersion } from './content'
import { DocumentView } from './DocumentView'
import { confirmLink } from './external'
import { readCachedPage, writeCachedPage, type CachedPage } from './offline'
import { buildPage } from './page'
import { FORMAT_TEXT, shareExport, shareFiles, shareFormats } from './share'
import type { FrameLayout } from './shell'
import { SlidesView } from './SlidesView'

const COMMENT: IconSpec = { sf: 'text.bubble', lucide: MessageSquare }
const TOAST_MS = 2600
const FLUID: FrameLayout = { kind: 'fluid' }

type Phase =
  | { kind: 'loading'; done: number; total: number }
  | { kind: 'ready' }
  | { kind: 'error'; message: string }
  | { kind: 'large'; size: number }
  | { kind: 'gone' }

function codeOf(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' ? code : null
}

export function ArtifactViewer(props: { id: string; version: number | null; page: string | null }) {
  const { id } = props
  const { c, s } = useSessionTokens()
  const host = useHost()
  const link = host.link
  const computer = host.host?.id ?? ''
  const connected = host.state.kind === 'connected'
  const insets = useSafeAreaInsets()
  const window = useWindowDimensions()
  const headerHeight = useHeaderHeight()

  const [pinned, setPinned] = useState<number | null>(props.version)
  const [loaded, setLoaded] = useState<LoadedVersion | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'loading', done: 0, total: 0 })
  const [anySize, setAnySize] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [cached, setCached] = useState<CachedPage | null>(null)
  const [summary, setSummary] = useState<ArtifactSummary | null>(null)
  const [latest, setLatest] = useState<number | null>(null)
  const [editors, setEditors] = useState<string[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const [pageIndex, setPageIndex] = useState(0)
  /** Another HTML file of a page artifact, opened by a link in it. */
  const [file, setFile] = useState<string | null>(null)
  const [sheet, setSheet] = useState<'menu' | 'versions' | 'share' | null>(null)
  const [versions, setVersions] = useState<VersionSummary[] | null>(null)
  const [commentsOpen, setCommentsOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<CommentAnchor | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [desktopOnly, setDesktopOnly] = useState(false)
  const [slide, setSlide] = useState(0)
  const toastOpacity = useRef(new Animated.Value(0)).current
  const shownVersion = useRef<number | null>(null)
  /** A new version came while the latest was shown, so its arrival is told. */
  const announce = useRef(false)

  const comments = useComments(connected ? link : null, id)

  // The version, and on a new one the latest again; the one shown stays until the next is in.
  useEffect(() => {
    if (!link || !connected) return
    let live = true
    if (!loaded || (pinned !== null && loaded.version !== pinned)) {
      setPhase({ kind: 'loading', done: 0, total: 0 })
    }
    loadVersion(link, computer, id, pinned, {
      anySize,
      progress: (done, total) => live && setPhase({ kind: 'loading', done, total }),
    }).then(
      (next) => {
        if (!live) return
        setLoaded(next)
        setPhase({ kind: 'ready' })
        if (pinned === null) setLatest((v) => Math.max(v ?? 0, next.version))
      },
      (failure: unknown) => {
        if (!live) return
        if (failure instanceof TooLarge) setPhase({ kind: 'large', size: failure.size })
        else if (codeOf(failure) === 'not_found') setPhase({ kind: 'gone' })
        else setPhase({ kind: 'error', message: errorText(failure) })
      },
    )
    return () => {
      live = false
    }
    // `loaded` only decides whether the wait shows; it never starts another read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link, connected, computer, id, pinned, anySize, attempt])

  // Offline: the page kept when it was last open.
  useEffect(() => {
    if (connected || loaded || !computer) return
    let live = true
    void readCachedPage(computer, id).then((page) => live && setCached(page))
    return () => {
      live = false
    }
  }, [connected, loaded, computer, id])

  const loadSummary = useCallback(() => {
    if (!link) return
    link.request('artifacts.list', {}).then(
      (list) => {
        const found = (list as ArtifactSummary[]).find((a) => a.id === id) ?? null
        setSummary(found)
        if (found) {
          setLatest((v) => Math.max(v ?? 0, found.version))
          setEditors(found.editing)
        } else setPhase({ kind: 'gone' })
      },
      () => {},
    )
  }, [link, id])

  useEffect(() => {
    if (connected) loadSummary()
  }, [connected, loadSummary])

  const say = useCallback(
    (text: string) => {
      setToast(text)
      toastOpacity.setValue(0)
      Animated.sequence([
        Animated.timing(toastOpacity, { toValue: 1, duration: 180, useNativeDriver: true }),
        Animated.delay(TOAST_MS),
        Animated.timing(toastOpacity, { toValue: 0, duration: 260, useNativeDriver: true }),
      ]).start(({ finished }) => finished && setToast(null))
    },
    [toastOpacity],
  )

  // Watching makes this phone one of its viewers, and brings its new versions and who edits it.
  useEffect(() => {
    if (!link || !connected) return
    void link.request('artifacts.watch', { id }).catch(() => {})
    const off = link.onHostEvent((value) => {
      const event = value as HostEvent
      if (event.type === 'artifacts.version' && event.id === id) {
        setLatest((v) => Math.max(v ?? 0, event.version))
        if (pinned === null) {
          announce.current = true
          setAttempt((n) => n + 1)
        } else say(`有新版本 v${event.version}`)
      } else if (event.type === 'artifacts.activity' && event.id === id) {
        setEditors(event.sessions.filter((s) => s.editing).map((s) => s.sessionId))
      } else if (event.type === 'artifacts.changed') {
        loadSummary()
      }
    })
    return () => {
      off()
      void link.request('artifacts.unwatch', { id }).catch(() => {})
    }
  }, [link, connected, id, pinned, say, loadSummary])

  // The note that the latest is now shown, once the new version is in.
  useEffect(() => {
    if (!loaded || pinned !== null) return
    const was = shownVersion.current
    shownVersion.current = loaded.version
    if (announce.current && was !== null && loaded.version > was) {
      announce.current = false
      say(`已更新到 v${loaded.version}`)
    }
  }, [loaded, pinned, say])

  useEffect(() => {
    if (sheet !== 'versions' || !link) return
    let live = true
    setVersions(null)
    link.request('artifacts.versions', { id }).then(
      (list) => live && setVersions(list as VersionSummary[]),
      (failure: unknown) => {
        if (!live) return
        setSheet(null)
        Alert.alert('没能读到版本', errorText(failure))
      },
    )
    return () => {
      live = false
    }
  }, [sheet, link, id])

  const view = useMemo(() => (loaded ? viewOf(loaded) : null), [loaded])
  const pages = view?.kind === 'canvas' ? view.pages : null
  const current: ViewPage | null = pages ? (pages[Math.min(pageIndex, pages.length - 1)] ?? null) : null

  useEffect(() => {
    if (props.page && pages) {
      const at = pages.findIndex((p) => p.id === props.page || String(p.number) === props.page)
      if (at >= 0) setPageIndex(at)
    }
    // Only the page the link named, once its canvas is read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages !== null])

  // The canvas page this phone shows, for the other clients' faces and the agents' reads.
  const viewId = current?.id ?? null
  useEffect(() => {
    if (!link || !connected || !loaded) return
    void link.request('artifacts.view', { id, page: viewId }).catch(() => {})
  }, [link, connected, id, viewId, loaded])

  const commentPage: CommentPage | null = useMemo(() => {
    if (current) return { file: current.file, page: { number: current.number, name: current.name } }
    if (view?.kind === 'page') return { file: file ?? 'index.html', page: null }
    return null
  }, [current, view, file])

  const built = useMemo(() => {
    if (!loaded || !view) return null
    if (view.kind === 'page') return buildPage(loaded, file ?? 'index.html')
    if (view.kind === 'canvas' && current) return buildPage(loaded, current.file, current.legacy)
    return null
  }, [loaded, view, file, current])

  const layout: FrameLayout = useMemo(
    () => (current ? { kind: 'fixed', width: current.width, height: current.height } : FLUID),
    [current],
  )

  // The page, kept to show again offline.
  useEffect(() => {
    if (!built || !loaded || !computer || !commentPage) return
    writeCachedPage(computer, id, {
      title: loaded.title,
      version: loaded.version,
      path: commentPage.file,
      layout,
      html: built.html,
    })
  }, [built, loaded, computer, id, layout, commentPage])

  const pins = useMemo(
    () => (commentPage ? pinsOf(comments.threads, commentPage) : []),
    [comments.threads, commentPage],
  )

  const kind = summary
    ? artifactKind(summary)
    : view?.kind === 'document' || view?.kind === 'slides'
      ? view.kind
      : view?.kind === 'canvas'
        ? 'canvas'
        : 'web'
  const title = loaded?.title ?? summary?.title ?? cached?.title ?? 'Artifact'
  const shownNumber = loaded?.version ?? cached?.version ?? null
  const old = pinned !== null && latest !== null && pinned < latest
  const openCount = comments.threads?.filter((t) => t.resolvedAt === null).length ?? 0
  const editorNames = editors.map((sid) => sessionTitle(host.sessions.get(sid)))
  const subtitle =
    editorNames.length > 0
      ? `${editorNames[0]}${editorNames.length > 1 ? ` 等 ${editorNames.length} 个会话` : ''}正在编辑…`
      : [KIND_TEXT[kind], shownNumber ? `v${shownNumber}` : null, old ? '旧版本' : null]
          .filter(Boolean)
          .join(' · ')

  const target: CommentTarget = useMemo(() => {
    if (picked) return { anchor: picked, picked: true }
    const version = loaded?.version ?? 1
    // A deck's comment names its slide as its page, in reading order as the desktop's does.
    if (view?.kind === 'slides') {
      return {
        anchor: pageAnchor(version, { file: 'index.html', page: { number: slide + 1, name: null } }),
        picked: false,
      }
    }
    return { anchor: pageAnchor(version, commentPage), picked: false }
  }, [picked, loaded, view, slide, commentPage])

  const onPick = useCallback(
    (selection: PageSelection) => {
      if (!loaded) return
      haptic.select()
      setPicking(false)
      setPicked({
        version: loaded.version,
        path: selection.path,
        page: commentPage?.page ?? null,
        offset: selection.src,
        tag: selection.tag,
        text: selection.text,
        missing: false,
      })
      setCommentsOpen(true)
    },
    [loaded, commentPage],
  )

  const onOpen = useCallback(
    (path: string) => {
      if (!loaded) return
      if (pages) {
        const at = pages.findIndex((p) => p.file === path)
        if (at >= 0) {
          setPageIndex(at)
          return
        }
      }
      if (view?.kind === 'page' && loaded.files.has(path) && /\.html?$/i.test(path)) {
        setFile(path === 'index.html' ? null : path)
        return
      }
      say('这个链接指向的页面不在这个 Artifact 里。')
    },
    [loaded, pages, view, say],
  )

  const restore = (version: number) => {
    if (!link || latest === null) return
    haptic.tap()
    Alert.alert(`恢复到 v${version}？`, '会把它存成一个新版本，现在的版本仍留在历史里。', [
      { text: '取消', style: 'cancel' },
      {
        text: '恢复',
        onPress: () => {
          link.request('artifacts.restoreVersion', { id, version, baseVersion: latest }).then(
            () => {
              haptic.success()
              setPinned(null)
            },
            (failure: unknown) =>
              Alert.alert(
                '没能恢复',
                codeOf(failure) === 'conflict' ? '刚刚又有了新版本，请再试一次。' : errorText(failure),
              ),
          )
        },
      },
    ])
  }

  const share = async (format?: Parameters<typeof shareExport>[2]) => {
    if (!link || !loaded) return
    try {
      if (format) await shareExport(link, loaded, format)
      else await shareFiles(loaded)
    } catch (failure) {
      Alert.alert('没能分享', errorText(failure))
    }
  }

  const session = summary ? host.sessions.get(summary.sessionId) : undefined
  const menuItems: SheetItem[] = [
    { key: 'versions', label: '版本记录', disabled: !connected, onPress: () => setSheet('versions') },
    {
      key: 'share',
      label: '分享',
      disabled: !loaded,
      onPress: () => {
        if (loaded?.type) setSheet('share')
        else void share()
      },
    },
    ...(session
      ? [
          {
            key: 'session',
            label: '打开会话',
            detail: sessionTitle(session),
            onPress: () => router.push({ pathname: '/session/[id]', params: { id: session.id } }),
          },
        ]
      : []),
    { key: 'rename', label: '重命名', disabled: !connected || !summary, onPress: () => setRenaming(true) },
    {
      key: 'reload',
      label: '重新载入',
      disabled: !connected,
      onPress: () => setAttempt((n) => n + 1),
    },
    {
      key: 'delete',
      label: '删除',
      destructive: true,
      disabled: !connected || !summary,
      onPress: () =>
        summary &&
        link &&
        confirmDelete((m, p) => link.request(m, p), summary, () => goBack()),
    },
  ]

  const versionItems: SheetItem[] = (versions ?? []).slice(0, 50).map((v) => ({
    key: String(v.version),
    label: `v${v.version}${v.version === latest ? ' · 最新' : ''}`,
    detail: `${v.author === null ? '你' : sessionTitle(host.sessions.get(v.author))} · ${whenText(v.createdAt)}${v.note ? ` · ${v.note}` : ''}`,
    checked: v.version === shownNumber,
    onPress: () => {
      haptic.select()
      setPicked(null)
      setFile(null)
      setPinned(v.version === latest ? null : v.version)
    },
  }))

  const shareItems: SheetItem[] = loaded?.type
    ? shareFormats(loaded.type.name).map((format) => ({
        key: format,
        label: FORMAT_TEXT[format],
        onPress: () => void share(format),
      }))
    : []

  const contentTop = headerHeight
  const away = view?.kind === 'page' && file !== null
  const bottomBar = (pages ? 56 : 0) + (old ? 50 : 0) + (away ? 50 : 0)

  let body
  if (phase.kind === 'gone') {
    body = <StateView text="这个 Artifact 已经删除，或不在这台电脑上了。" icon={G.trash} />
  } else if (!loaded && cached && !connected && link) {
    body = (
      <ArtifactFrame
        link={link}
        artifactId={id}
        page={cached.html}
        path={cached.path}
        layout={cached.layout}
        picking={false}
        pins={[]}
        onPick={() => {}}
        onLink={confirmLink}
        onOpen={() => say('连上电脑后才能打开其他页面。')}
        onDesktopOnly={() => setDesktopOnly(true)}
      />
    )
  } else if (!loaded && !connected) {
    body = (
      <StateView
        text={host.unreachable ? '连不上电脑。它可能关机了，或不在同一个网络。' : '正在连接电脑…'}
        icon={G.wifiOff}
        retry={() => host.retry()}
      />
    )
  } else if (phase.kind === 'error' && !loaded) {
    body = <StateView tone="danger" text={`没能打开：${phase.message}`} retry={() => setAttempt((n) => n + 1)} />
  } else if (phase.kind === 'large') {
    body = (
      <View style={styles.center}>
        <Icon icon={G.warning} size={26} color={c.textSecondary} />
        <Text style={[styles.note, { color: c.textSecondary }]}>
          这个 Artifact 有 {formatBytes(phase.size)}，在手机上打开要下载很多数据。
        </Text>
        <PressScale
          onPress={() => setAnySize(true)}
          style={[styles.button, { backgroundColor: c.fillStrong }]}
        >
          <Text style={[styles.buttonText, { color: c.text }]}>仍然打开</Text>
        </PressScale>
      </View>
    )
  } else if (!loaded || !view) {
    const fraction = phase.kind === 'loading' && phase.total > 0 ? phase.done / phase.total : null
    body = (
      <View style={[styles.skeleton, { paddingTop: 20 }]} accessibilityLabel="正在加载">
        <Skeleton width="60%" height={22} />
        <Skeleton width="90%" height={14} />
        <Skeleton width="80%" height={14} />
        <Skeleton height={window.width * 0.5} radius={12} />
        <Skeleton width="70%" height={14} />
        {fraction !== null && (
          <Text style={[styles.progress, { color: c.textTertiary }]}>
            正在下载 {Math.round(fraction * 100)}%
          </Text>
        )}
      </View>
    )
  } else if (view.kind === 'document') {
    body = <DocumentView version={loaded} top={0} bottom={insets.bottom + bottomBar} />
  } else if (view.kind === 'slides') {
    body = (
      <SlidesView version={loaded} top={0} bottom={insets.bottom + bottomBar} onSlide={setSlide} />
    )
  } else if (view.kind === 'broken') {
    body = <StateView text={view.reason} />
  } else if (!built) {
    body = <StateView text={current ? `「${pageName(current)}」的文件不在这个版本里。` : '这个页面的文件不在这个版本里。'} />
  } else {
    body = (
      <View style={{ flex: 1, paddingBottom: bottomBar ? bottomBar + insets.bottom : 0 }}>
        <ArtifactFrame
          link={link!}
          artifactId={id}
          page={built.html}
          path={commentPage?.file ?? 'index.html'}
          layout={layout}
          picking={picking}
          pins={pins}
          onPick={onPick}
          onLink={confirmLink}
          onOpen={onOpen}
          onDesktopOnly={() => setDesktopOnly(true)}
        />
      </View>
    )
  }

  const canPick = (view?.kind === 'page' || view?.kind === 'canvas') && !!built && connected

  return (
    <View style={[styles.fill, { backgroundColor: c.bg }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <View style={[styles.fill, { paddingTop: contentTop }]}>{body}</View>

      {picking && (
        <View style={[styles.banner, { top: contentTop + 8, backgroundColor: s.menuSolid, borderColor: c.border }]}>
          <Text style={[styles.bannerText, { color: c.text }]}>点一下要评论的元素</Text>
          <Pressable onPress={() => setPicking(false)} hitSlop={10}>
            <Text style={[styles.bannerAction, { color: c.tint }]}>取消</Text>
          </Pressable>
        </View>
      )}
      {!picking && (desktopOnly || (!connected && cached && !loaded) || (built?.partial ?? false)) && (
        <View style={[styles.banner, { top: contentTop + 8, backgroundColor: s.menuSolid, borderColor: c.border }]}>
          <Text style={[styles.bannerText, { color: c.textSecondary }]} numberOfLines={2}>
            {!connected && cached && !loaded
              ? `离线，显示上次打开的 v${cached.version}`
              : desktopOnly
                ? '这个页面要读电脑上的文件或问 Agent，要在电脑上用。'
                : '这个 Artifact 较大，页面用脚本读取的部分文件没有载入。'}
          </Text>
          {desktopOnly && (
            <Pressable onPress={() => setDesktopOnly(false)} hitSlop={10}>
              <Icon icon={G.close} size={13} color={c.textSecondary} />
            </Pressable>
          )}
        </View>
      )}
      {toast !== null && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.toast,
            { top: contentTop + 10, backgroundColor: s.menuSolid, borderColor: c.border, opacity: toastOpacity },
          ]}
        >
          <Text style={[styles.toastText, { color: c.text }]}>{toast}</Text>
        </Animated.View>
      )}

      {(pages || old || away) && loaded && (
        <View
          style={[
            styles.bottom,
            { paddingBottom: insets.bottom + 6, backgroundColor: c.bg, borderTopColor: c.border },
          ]}
        >
          {away && (
            <View style={styles.oldRow}>
              <Text style={[styles.oldText, { color: c.textSecondary }]} numberOfLines={1}>
                {file}
              </Text>
              <PressScale
                onPress={() => {
                  setPicked(null)
                  setFile(null)
                }}
                style={[styles.chip, { backgroundColor: c.fillStrong }]}
              >
                <Text style={[styles.chipText, { color: c.text }]}>回到首页</Text>
              </PressScale>
            </View>
          )}
          {old && (
            <View style={styles.oldRow}>
              <Text style={[styles.oldText, { color: c.textSecondary }]} numberOfLines={1}>
                正在看 v{pinned}，最新是 v{latest}
              </Text>
              <PressScale
                onPress={() => restore(pinned!)}
                disabled={!connected}
                style={[styles.chip, { backgroundColor: c.fillStrong }]}
              >
                <Text style={[styles.chipText, { color: c.text }]}>恢复这个版本</Text>
              </PressScale>
              <PressScale
                onPress={() => {
                  setPicked(null)
                  setPinned(null)
                }}
                style={[styles.chip, { backgroundColor: c.accent }]}
              >
                <Text style={[styles.chipText, { color: c.onAccent }]}>看最新</Text>
              </PressScale>
            </View>
          )}
          {pages && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.strip}
              accessibilityRole="tablist"
            >
              {pages.map((page, i) => {
                const on = i === pageIndex
                return (
                  <PressScale
                    key={`${page.number}`}
                    onPress={() => {
                      if (on) return
                      haptic.select()
                      setPicked(null)
                      setPicking(false)
                      setPageIndex(i)
                    }}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: on }}
                    style={[
                      styles.pageChip,
                      { backgroundColor: on ? c.fillStrong : c.fill, borderColor: on ? c.borderStrong : 'transparent' },
                    ]}
                  >
                    <Text
                      style={[styles.chipText, { color: on ? c.text : c.textSecondary }]}
                      numberOfLines={1}
                    >
                      {page.number}. {pageName(page)}
                    </Text>
                  </PressScale>
                )
              })}
            </ScrollView>
          )}
        </View>
      )}

      <GlassHeader
        floating
        title={title}
        subtitle={subtitle}
        onTitlePress={connected && loaded ? () => setSheet('versions') : undefined}
        right={
          <>
            <RoundButton
              tone="glass"
              size={44}
              onPress={() => setCommentsOpen(true)}
              disabled={!connected && !comments.threads}
              accessibilityLabel={`评论，${openCount} 条未解决`}
            >
              <Icon icon={COMMENT} size={18} color={c.text} />
              {openCount > 0 && (
                <View style={[styles.count, { backgroundColor: c.accent }]}>
                  <Text style={[styles.countText, { color: c.onAccent }]}>
                    {openCount > 99 ? '99+' : openCount}
                  </Text>
                </View>
              )}
            </RoundButton>
            <RoundButton
              tone="glass"
              size={44}
              onPress={() => setSheet('menu')}
              accessibilityLabel="更多"
            >
              <Icon icon={G.more} size={18} color={c.text} weight="semibold" />
            </RoundButton>
          </>
        }
      />

      <Sheet visible={sheet === 'menu'} title={title} items={menuItems} onClose={() => setSheet(null)} />
      <Sheet
        visible={sheet === 'versions'}
        title="版本记录"
        message={versions ? '选一个版本查看；旧版本可以恢复成最新的。' : '正在读取…'}
        items={versionItems}
        onClose={() => setSheet(null)}
      />
      <Sheet
        visible={sheet === 'share'}
        title="分享为"
        message="电脑会把它转换成文件。"
        items={shareItems}
        onClose={() => setSheet(null)}
      />
      <CommentsSheet
        visible={commentsOpen}
        artifactId={id}
        threads={comments.threads}
        error={comments.error}
        target={target}
        onPickElement={
          canPick
            ? () => {
                setCommentsOpen(false)
                setPicked(null)
                setPicking(true)
              }
            : null
        }
        onClearPick={() => setPicked(null)}
        onChanged={comments.apply}
        onRetry={comments.reload}
        onClose={() => setCommentsOpen(false)}
      />
      <RenameDialog
        visible={renaming}
        title={summary?.title ?? title}
        heading="重命名 Artifact"
        placeholder="Artifact 标题"
        noReset
        maxLength={ARTIFACT_TITLE_CHARS}
        onClose={() => setRenaming(false)}
        onSave={async (next) => {
          if (!next) throw new Error('标题不能是空的。')
          if (!link) throw new Error('连上电脑后才能改名。')
          await link.request('artifacts.rename', { id, title: next })
          setSummary((a) => (a ? { ...a, title: next } : a))
          setLoaded((v) => (v ? { ...v, title: next } : v))
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 14 },
  note: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
  button: { borderRadius: 999, paddingHorizontal: 22, height: 40, justifyContent: 'center' },
  buttonText: { fontSize: 15, fontWeight: '600' },
  skeleton: { paddingHorizontal: 20, gap: 14 },
  progress: { fontSize: 13, textAlign: 'center', fontVariant: ['tabular-nums'] },
  banner: {
    position: 'absolute',
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  bannerText: { flex: 1, fontSize: 14, lineHeight: 19 },
  bannerAction: { fontSize: 15, fontWeight: '600' },
  toast: {
    position: 'absolute',
    alignSelf: 'center',
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  toastText: { fontSize: 14, fontWeight: '600' },
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
    gap: 8,
  },
  oldRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16 },
  oldText: { flex: 1, fontSize: 13.5 },
  chip: { borderRadius: 999, paddingHorizontal: 14, height: 34, justifyContent: 'center' },
  chipText: { fontSize: 13.5, fontWeight: '600' },
  strip: { paddingHorizontal: 12, gap: 8 },
  pageChip: {
    maxWidth: 220,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    height: 36,
    justifyContent: 'center',
  },
  count: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  countText: { fontSize: 10.5, fontWeight: '700', fontVariant: ['tabular-nums'] },
})
