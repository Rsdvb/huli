// An artifact in the grid: its title, the agent that made it, its kind and age, over a preview the
// computer captured, or a sketch of its kind while there is none.

import { StyleSheet, Text, View } from 'react-native'
import { Image } from 'expo-image'
import { router } from 'expo-router'
import type { ArtifactSummary } from '@shared/artifacts'
import {
  artifactKind,
  KIND_TEXT,
  openArtifact,
  useThumbnail,
  type ArtifactKind,
} from '../artifacts'
import { useAgent, useMaybeLink, useSession } from '../host'
import { listTime } from '../sessions'
import { AgentGlyph } from '../ui/AgentAvatar'
import { ContextMenu } from '../ui/ContextMenu'
import type { MenuNode } from '../ui/menu'
import { Icon } from '../ui/Icon'
import { Press } from '../ui/Press'
import { cacheFor } from '../ui/memory'
import { Skeleton } from '../ui/Skeleton'
import { radius, space, type as typeScale, useTokens } from '../ui/tokens'

/** The captured page's shape: the desktop renders previews at 1280 by 800. */
export const PREVIEW_RATIO = 1280 / 800

/** A quiet drawing of what a kind looks like, for an artifact without a preview. */
export function KindSketch(props: { kind: ArtifactKind }) {
  const { c } = useTokens()
  const bar = (width: `${number}%`, strong = false, key?: number) => (
    <View
      key={key}
      style={[styles.bar, { width, backgroundColor: strong ? c.fillStrong : c.fill }]}
    />
  )
  switch (props.kind) {
    case 'document':
      return (
        <View style={[styles.sheet, { backgroundColor: c.surfaceRaised, borderColor: c.border }]}>
          {bar('55%', true)}
          {[92, 86, 90, 70].map((w, i) => bar(`${w}%`, false, i))}
        </View>
      )
    case 'slides':
      return (
        <View style={[styles.slide, { backgroundColor: c.surfaceRaised, borderColor: c.border }]}>
          {bar('48%', true)}
          <View style={styles.slideBody}>
            <View style={[styles.slideBlock, { backgroundColor: c.tintSoft }]} />
            <View style={styles.slideLines}>
              {[90, 75, 82].map((w, i) => bar(`${w}%`, false, i))}
            </View>
          </View>
        </View>
      )
    case 'canvas':
      return (
        <View style={styles.canvas}>
          {[0, 1, 2, 3].map((i) => (
            <View
              key={i}
              style={[
                styles.canvasPage,
                { backgroundColor: c.surfaceRaised, borderColor: c.border },
              ]}
            >
              {bar('60%', true)}
              {bar('80%')}
            </View>
          ))}
        </View>
      )
    case 'web':
      return (
        <View style={[styles.sheet, { backgroundColor: c.surfaceRaised, borderColor: c.border }]}>
          <View style={styles.dots}>
            {[0, 1, 2].map((i) => (
              <View key={i} style={[styles.dot, { backgroundColor: c.fillStrong }]} />
            ))}
          </View>
          <View style={[styles.hero, { backgroundColor: c.tintSoft }]} />
          {bar('70%')}
          {bar('50%')}
        </View>
      )
  }
}

/** The preview inside its frame: the picture, a placeholder while it comes, or the sketch. */
export function ArtifactPreview(props: { artifact: ArtifactSummary; inset?: number }) {
  const { c } = useTokens()
  const link = useMaybeLink()
  const thumbnail = useThumbnail(link, props.artifact)
  const kind = artifactKind(props.artifact)
  return (
    <View
      style={[
        styles.frame,
        { backgroundColor: c.fill, borderColor: c.border, padding: props.inset ?? space.sm },
      ]}
    >
      <View style={[styles.picture, { backgroundColor: c.bg }]}>
        {thumbnail.state === 'ready' ? (
          <Image
            source={{ uri: thumbnail.uri }}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            cachePolicy={cacheFor(thumbnail.uri)}
            recyclingKey={props.artifact.id}
            transition={150}
            accessibilityIgnoresInvertColors
          />
        ) : thumbnail.state === 'loading' ? (
          <View style={styles.sketchWrap}>
            <Skeleton width="100%" height={200} radius={0} />
          </View>
        ) : (
          <View style={styles.sketchWrap}>
            <KindSketch kind={kind} />
          </View>
        )}
      </View>
    </View>
  )
}

/** An artifact's menu: open it, its details and versions, its session, delete it. */
export function artifactMenu(
  a: ArtifactSummary,
  act: {
    details(): void
    /** Whether its session is on this computer, so it can be opened. */
    session: boolean
    /** Deletes it after asking; null while it cannot be deleted. */
    remove: (() => void) | null
  },
): MenuNode[] {
  return [
    { key: 'view', label: '打开', icon: 'eye', onPress: () => openArtifact(a.id) },
    { key: 'open', label: '详情与版本', icon: 'info.circle', onPress: act.details },
    ...(act.session
      ? [
          {
            key: 'session',
            label: '打开会话',
            icon: 'bubble.left.and.bubble.right' as const,
            onPress: () => router.push(`/session/${a.sessionId}`),
          },
        ]
      : []),
    { kind: 'divider', key: 'danger' },
    {
      key: 'delete',
      label: '删除',
      icon: 'trash',
      destructive: true,
      disabled: !act.remove,
      onPress: () => act.remove?.(),
    },
  ]
}

export function ArtifactCard(props: {
  artifact: ArtifactSummary
  onPress(): void
  /** What its long press offers, as `artifactMenu` makes it. */
  menu: MenuNode[]
}) {
  const { c } = useTokens()
  const a = props.artifact
  const kind = artifactKind(a)
  const session = useSession(a.sessionId)
  const agent = useAgent(session?.agentId)
  const editing = a.editing.length > 0
  return (
    <View style={styles.cell}>
      <ContextMenu items={props.menu} title={a.title || '未命名'}>
        {(longPress) => (
          <Press
            onPress={props.onPress}
            {...(longPress ? { onLongPress: longPress, delayLongPress: 350 } : {})}
            accessibilityRole="button"
            accessibilityLabel={`${a.title}，${KIND_TEXT[kind]}，${listTime(a.updatedAt)}${editing ? '，正在编辑' : ''}`}
            accessibilityHint="打开；长按显示更多操作"
            style={[styles.card, { backgroundColor: c.surface, borderColor: c.border }]}
          >
            <View style={styles.head}>
              <Text style={[typeScale.headline, { color: c.text }]} numberOfLines={1}>
                {a.title || '未命名'}
              </Text>
              <View style={styles.meta}>
                {session ? (
                  <AgentGlyph agentId={session.agentId} name={agent?.name} size={14} />
                ) : (
                  <Icon name="doc" size={13} color={c.textTertiary} />
                )}
                <Text
                  style={[typeScale.footnote, styles.metaText, { color: c.textSecondary }]}
                  numberOfLines={1}
                >
                  {KIND_TEXT[kind]} · {listTime(a.updatedAt)}
                </Text>
                {editing ? <View style={[styles.live, { backgroundColor: c.success }]} /> : null}
              </View>
            </View>
            <ArtifactPreview artifact={a} />
          </Press>
        )}
      </ContextMenu>
    </View>
  )
}

const styles = StyleSheet.create({
  cell: { flex: 1 },
  card: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.sm,
    gap: space.sm,
  },
  head: { paddingHorizontal: space.xs + 2, paddingTop: space.xs, gap: 2 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 },
  metaText: { flexShrink: 1, fontVariant: ['tabular-nums'] },
  live: { width: 7, height: 7, borderRadius: 4 },
  frame: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  picture: {
    aspectRatio: PREVIEW_RATIO,
    borderRadius: radius.sm - 2,
    overflow: 'hidden',
  },
  sketchWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheet: {
    width: '78%',
    height: '86%',
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.sm,
    gap: 5,
  },
  bar: { height: 5, borderRadius: 3 },
  slide: {
    width: '82%',
    aspectRatio: 16 / 10,
    borderRadius: radius.xs,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.sm,
    gap: space.sm,
  },
  slideBody: { flex: 1, flexDirection: 'row', gap: space.sm },
  slideBlock: { flex: 1, borderRadius: 4 },
  slideLines: { flex: 1, gap: 5, justifyContent: 'center' },
  canvas: {
    width: '84%',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.xs + 2,
    justifyContent: 'center',
  },
  canvasPage: {
    width: '44%',
    aspectRatio: 16 / 10,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 5,
    gap: 4,
  },
  dots: { flexDirection: 'row', gap: 3 },
  dot: { width: 5, height: 5, borderRadius: 3 },
  hero: { height: '34%', borderRadius: 4 },
})
