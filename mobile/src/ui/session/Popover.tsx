// A glass menu anchored to the control that opened it, above or below it, as the iPhone's own
// context menus are: it springs out of the control, closes on a tap outside it, and leads to pages
// of its own (More models, Slash commands) with a way back. It is drawn over the screen it belongs
// to rather than in a modal, so what a row does next, an alert or a picker, opens at once.
//
// A screen keeps one with `usePopover`, opens it from a control's ref, and renders it last with
// the pages it can show, which it builds afresh on each render so they stay current.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentRef,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  BackHandler,
  Dimensions,
  Easing,
  Keyboard,
  LayoutAnimation,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { BlurView } from 'expo-blur'
import { Glass, useGlassMode } from '../Glass'
import { haptic } from './feedback'
import { G, Icon, type IconSpec } from './icons'
import { useSessionTokens } from './palette'
import { useReduceMotion } from '../Press'

/** What a ref to a view holds, which a menu measures to hang from. */
export type ViewHandle = ComponentRef<typeof View>

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface MenuRow {
  kind?: 'row'
  key: string
  label: string
  icon?: IconSpec
  /** Drawn in the icon's place, such as an agent's mark. */
  lead?: ReactNode
  /** A second line under the label. */
  subtitle?: string
  /** Quiet text at the row's end, such as a count. */
  detail?: string
  /** Drawn at the row's end before any check or chevron, such as a usage ring. */
  trail?: ReactNode
  /** Drawn on a line of its own under the label and subtitle, such as what is left of a limit. */
  below?: ReactNode
  checked?: boolean
  destructive?: boolean
  disabled?: boolean
  /** Opens this page of the menu. */
  page?: string
  /** A switch at the row's end; pressing the row flips it, and the menu stays open. */
  toggle?: boolean
  onPress?: () => void
  /** The menu stays open after the row is pressed. */
  keepOpen?: boolean
}

/** A choice of a few values, as the effort's levels: a segmented row in a native menu. */
export interface MenuPicker {
  label: string
  options: { key: string; label: string }[]
  value: string
  onChange(value: string): void
  disabled?: boolean
}

export type MenuEntry =
  | MenuRow
  | { kind: 'divider'; key: string }
  | {
      kind: 'custom'
      key: string
      node: ReactNode
      /** What a native menu shows in the node's place; it is left out without one. */
      picker?: MenuPicker
    }

/** A menu by its pages, for a control to open as the system's menu or as our popover. */
export interface MenuSource {
  /** The first page's id. */
  root: string
  pages(id: string): MenuPage | null
  /**
   * Opens a page a native menu cannot hold, such as one with a search field, as our popover;
   * rows that lead there are buttons that call it.
   */
  popover?: { pages: readonly string[]; open(page: string): void }
}

export interface MenuPage {
  /** A page other than the first shows it beside its way back. */
  title?: string
  entries: MenuEntry[]
  /** A quiet line under the rows, such as the plan's usage. */
  footer?: string
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  /** What the page says when it has no rows. */
  empty?: string
}

export interface PopoverOptions {
  placement?: 'above' | 'below'
  align?: 'start' | 'end' | 'center'
  width?: number
}

interface OpenState {
  id: string
  anchor: Rect
  options: PopoverOptions
}

export interface Popover {
  /** The menu that is open, by the id it was opened with. */
  openId: string | null
  /** The page shown now, the first or one a row led to. */
  page: string | null
  open(id: string, anchor: RefObject<ViewHandle | null>, options?: PopoverOptions): void
  close(): void
  /** The menu over the screen, with its pages by id; put it last in the screen's root. */
  render(page: (id: string) => MenuPage | null): ReactNode
}

function measure(ref: RefObject<ViewHandle | null>): Promise<Rect | null> {
  return new Promise((resolve) => {
    const view = ref.current
    if (!view) return resolve(null)
    view.measureInWindow((x, y, width, height) => resolve({ x, y, width, height }))
  })
}

// Surfaces a menu must not cover, as the composer: a control inside one hangs its menu from the
// surface's edge rather than its own, so the surface's outline never shows through the menu.
const edges = new Set<RefObject<ViewHandle | null>>()

/** Keeps menus opened from controls inside this view clear of it. */
export function useMenuEdge(ref: RefObject<ViewHandle | null>): void {
  useEffect(() => {
    edges.add(ref)
    return () => {
      edges.delete(ref)
    }
  }, [ref])
}

const inside = (inner: Rect, outer: Rect) =>
  inner.x >= outer.x - 1 &&
  inner.y >= outer.y - 1 &&
  inner.x + inner.width <= outer.x + outer.width + 1 &&
  inner.y + inner.height <= outer.y + outer.height + 1

/** The anchor, stretched vertically to the edges of a surface it sits in. */
async function anchorRect(ref: RefObject<ViewHandle | null>): Promise<Rect | null> {
  const rect = await measure(ref)
  if (!rect) return null
  for (const edge of edges) {
    const outer = await measure(edge)
    if (outer && outer.width > 0 && inside(rect, outer)) {
      return { x: rect.x, width: rect.width, y: outer.y, height: outer.height }
    }
  }
  return rect
}

export function usePopover(): Popover {
  const [state, setState] = useState<OpenState | null>(null)
  const [stack, setStack] = useState<string[]>([])
  const [closing, setClosing] = useState(false)
  const anchorRef = useRef<RefObject<ViewHandle | null> | null>(null)

  const open = useCallback(
    (id: string, anchor: RefObject<ViewHandle | null>, options: PopoverOptions = {}) => {
      anchorRef.current = anchor
      void anchorRect(anchor).then((rect) => {
        if (!rect) return
        haptic.tap()
        setClosing(false)
        setStack([id])
        setState({ id, anchor: rect, options })
      })
    },
    [],
  )

  // The keyboard moves the control the menu hangs from, as a search field in the menu brings it up.
  const isOpen = state !== null
  useEffect(() => {
    if (!isOpen) return
    const follow = () => {
      const anchor = anchorRef.current
      if (!anchor) return
      // After the layout settles under the keyboard's new height.
      setTimeout(() => {
        void anchorRect(anchor).then((rect) => {
          if (rect) setState((current) => (current ? { ...current, anchor: rect } : current))
        })
      }, 60)
    }
    const showing = Keyboard.addListener('keyboardDidShow', follow)
    const hidden = Keyboard.addListener('keyboardDidHide', follow)
    return () => {
      showing.remove()
      hidden.remove()
    }
  }, [isOpen])
  const close = useCallback(() => setClosing(true), [])
  const gone = useCallback(() => {
    setState(null)
    setStack([])
    setClosing(false)
  }, [])

  return {
    openId: state && !closing ? state.id : null,
    page: state && !closing ? (stack[stack.length - 1] ?? state.id) : null,
    open,
    close,
    render: (build) =>
      state ? (
        <PopoverView
          state={state}
          stack={stack}
          closing={closing}
          build={build}
          onPush={(page) => {
            resize()
            setStack((list) => [...list, page])
          }}
          onBack={() => {
            resize()
            setStack((list) => list.slice(0, -1))
          }}
          onClose={close}
          onGone={gone}
        />
      ) : null,
  }
}

/** The menu grows or shrinks to the next page's height rather than jumping to it. */
function resize(): void {
  if (reduceMotion) return
  LayoutAnimation.configureNext({
    duration: 220,
    update: { type: 'spring', springDamping: 0.86 },
  })
}

let reduceMotion = false
void AccessibilityInfo.isReduceMotionEnabled().then((on) => (reduceMotion = on))
AccessibilityInfo.addEventListener('reduceMotionChanged', (on) => (reduceMotion = on))

const MARGIN = 10
const GAP = 8
const MENU_RADIUS = 24

function PopoverView(props: {
  state: OpenState
  stack: string[]
  closing: boolean
  build(id: string): MenuPage | null
  onPush(page: string): void
  onBack(): void
  onClose(): void
  onGone(): void
}) {
  const { state, stack, closing, onClose, onGone } = props
  const { c, s, scheme } = useSessionTokens()
  const insets = useSafeAreaInsets()
  const reduce = useReduceMotion()
  const glassMode = useGlassMode()
  // Which way the pages move: a page a row leads to comes in from the right, the way back from
  // the left, as a navigation stack's do.
  const depth = useRef(stack.length)
  const direction = useRef(1)
  if (stack.length !== depth.current) {
    direction.current = stack.length > depth.current ? 1 : -1
    depth.current = stack.length
  }
  const root = useRef<ViewHandle>(null)
  const [origin, setOrigin] = useState<{ x: number; y: number; width: number; height: number }>()
  const shown = useRef(new Animated.Value(0)).current
  const pageIn = useRef(new Animated.Value(1)).current
  const pageId = stack[stack.length - 1] ?? state.id
  const page = props.build(pageId)

  useEffect(() => {
    if (!origin) return
    if (closing) {
      Animated.timing(shown, {
        toValue: 0,
        duration: 140,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }).start(({ finished }) => {
        if (finished) onGone()
      })
      return
    }
    if (reduce) {
      Animated.timing(shown, { toValue: 1, duration: 120, useNativeDriver: true }).start()
    } else {
      Animated.spring(shown, {
        toValue: 1,
        useNativeDriver: true,
        speed: 26,
        bounciness: 5,
      }).start()
    }
  }, [origin, closing, reduce, shown, onGone])

  useEffect(() => {
    pageIn.setValue(reduce ? 1 : 0)
    if (!reduce) {
      Animated.timing(pageIn, {
        toValue: 1,
        duration: 180,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start()
    }
  }, [pageId, reduce, pageIn])

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (stack.length > 1) props.onBack()
      else onClose()
      return true
    })
    return () => sub.remove()
  }, [stack.length, props, onClose])

  // The page went away, as a menu whose session ended: nothing is left to show.
  useEffect(() => {
    if (!page && !closing) onClose()
  }, [page, closing, onClose])

  const window = Dimensions.get('window')
  const frame = origin ?? { x: 0, y: 0, width: window.width, height: window.height }
  const width = Math.min(state.options.width ?? 280, frame.width - MARGIN * 2)
  const anchor = {
    x: state.anchor.x - frame.x,
    y: state.anchor.y - frame.y,
    width: state.anchor.width,
    height: state.anchor.height,
  }
  const placement =
    state.options.placement ?? (anchor.y + anchor.height / 2 > frame.height / 2 ? 'above' : 'below')
  const align =
    state.options.align ?? (anchor.x + anchor.width / 2 > frame.width / 2 ? 'end' : 'start')
  const left = Math.min(
    Math.max(
      MARGIN,
      align === 'end'
        ? anchor.x + anchor.width - width
        : align === 'center'
          ? anchor.x + (anchor.width - width) / 2
          : anchor.x,
    ),
    frame.width - width - MARGIN,
  )
  const room =
    placement === 'above'
      ? anchor.y - GAP - Math.max(insets.top, MARGIN)
      : frame.height - (anchor.y + anchor.height + GAP) - Math.max(insets.bottom, MARGIN)
  const position =
    placement === 'above'
      ? { bottom: frame.height - anchor.y + GAP }
      : { top: anchor.y + anchor.height + GAP }
  const nested = stack.length > 1
  const maxHeight = Math.max(160, room)
  // The menu grows from the point of it nearest its control, so it springs out of the control.
  const originX =
    align === 'end'
      ? '100%'
      : align === 'center'
        ? '50%'
        : Math.max(0, Math.min(width, anchor.x + anchor.width / 2 - left))
  const originY = placement === 'above' ? '100%' : '0%'

  const content = page && (
    <Animated.View
      style={{
        opacity: pageIn,
        transform: [
          {
            translateX: pageIn.interpolate({
              inputRange: [0, 1],
              outputRange: [direction.current * 28, 0],
            }),
          },
        ],
      }}
    >
      {nested && (
        <Pressable
          onPress={() => {
            haptic.pick()
            props.onBack()
          }}
          accessibilityRole="button"
          accessibilityLabel={`返回${page.title ? `，${page.title}` : ''}`}
          style={({ pressed }) => [styles.back, pressed && { backgroundColor: s.menuActive }]}
        >
          <Icon icon={G.back} size={15} color={c.textSecondary} weight="semibold" />
          <Text style={[styles.backTitle, { color: c.text }]} numberOfLines={1}>
            {page.title ?? ''}
          </Text>
        </Pressable>
      )}
      <ScrollView
        bounces={false}
        keyboardShouldPersistTaps="handled"
        style={{ maxHeight: maxHeight - (nested ? 48 : 0) }}
        contentContainerStyle={styles.list}
      >
        <PageBody page={page} onPush={props.onPush} onClose={onClose} />
      </ScrollView>
    </Animated.View>
  )

  return (
    <View
      ref={root}
      style={StyleSheet.absoluteFill}
      onLayout={() =>
        root.current?.measureInWindow((x, y, w, h) => setOrigin({ x, y, width: w, height: h }))
      }
    >
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: s.menuScrim, opacity: shown }]}
      />
      <Pressable
        style={StyleSheet.absoluteFill}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="关闭菜单"
      />
      {origin && page && (
        <Animated.View
          accessibilityViewIsModal
          style={[
            styles.menu,
            position,
            {
              left,
              width,
              maxHeight,
              shadowColor: c.shadow,
              opacity: shown,
              transformOrigin: [originX, originY, 0],
              transform: [
                {
                  scale: reduce
                    ? 1
                    : shown.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }),
                },
              ],
            },
          ]}
        >
          {glassMode === 'liquid' ? (
            <Glass radius={MENU_RADIUS} style={styles.panel}>
              {content}
            </Glass>
          ) : (
            <View
              style={[
                styles.panel,
                styles.clip,
                {
                  borderColor: c.borderStrong,
                  backgroundColor: glassMode === 'blur' ? 'transparent' : s.menuSolid,
                },
              ]}
            >
              {glassMode === 'blur' && (
                <>
                  <BlurView
                    style={StyleSheet.absoluteFill}
                    intensity={70}
                    tint={
                      scheme === 'dark' ? 'systemThickMaterialDark' : 'systemThickMaterialLight'
                    }
                  />
                  <View style={[StyleSheet.absoluteFill, { backgroundColor: s.menu }]} />
                </>
              )}
              {content}
            </View>
          )}
        </Animated.View>
      )}
    </View>
  )
}

function PageBody(props: { page: MenuPage; onPush(page: string): void; onClose(): void }) {
  const { c } = useSessionTokens()
  const { page } = props
  if (page.loading && page.entries.length === 0) {
    return (
      <View style={styles.state}>
        <ActivityIndicator size="small" color={c.textSecondary} />
      </View>
    )
  }
  if (page.error && page.entries.length === 0) {
    return (
      <View style={styles.state}>
        <Text style={[styles.stateText, { color: c.danger }]}>{page.error}</Text>
        {page.onRetry && (
          <Pressable onPress={page.onRetry} hitSlop={8} accessibilityRole="button">
            <Text style={[styles.retry, { color: c.tint }]}>重试</Text>
          </Pressable>
        )}
      </View>
    )
  }
  return (
    <>
      {page.entries.length === 0 && page.empty ? (
        <View style={styles.state}>
          <Text style={[styles.stateText, { color: c.textSecondary }]}>{page.empty}</Text>
        </View>
      ) : null}
      {page.entries.map((entry) => {
        if (entry.kind === 'divider') {
          return <View key={entry.key} style={[styles.divider, { backgroundColor: c.border }]} />
        }
        if (entry.kind === 'custom') return <View key={entry.key}>{entry.node}</View>
        return <Row key={entry.key} row={entry} onPush={props.onPush} onClose={props.onClose} />
      })}
      {page.footer ? (
        <>
          <View style={[styles.divider, { backgroundColor: c.border }]} />
          <Text style={[styles.footer, { color: c.textSecondary }]} numberOfLines={3}>
            {page.footer}
          </Text>
        </>
      ) : null}
    </>
  )
}

/** A row's checkmark, which pops in as the row becomes the chosen one. */
function Check(props: { color: string }) {
  const reduce = useReduceMotion()
  const shown = useRef(new Animated.Value(reduce ? 1 : 0)).current
  useEffect(() => {
    if (reduce) return
    Animated.spring(shown, {
      toValue: 1,
      useNativeDriver: true,
      speed: 22,
      bounciness: 10,
    }).start()
  }, [reduce, shown])
  return (
    <Animated.View
      style={{
        opacity: shown.interpolate({
          inputRange: [0, 1],
          outputRange: [0, 1],
          extrapolate: 'clamp',
        }),
        transform: [{ scale: shown.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }],
      }}
    >
      <Icon icon={G.check} size={16} color={props.color} weight="semibold" />
    </Animated.View>
  )
}

function Row(props: { row: MenuRow; onPush(page: string): void; onClose(): void }) {
  const { c, s } = useSessionTokens()
  const { row } = props
  const color = row.destructive ? c.danger : c.text
  const press = () => {
    if (row.page) {
      haptic.pick()
      props.onPush(row.page)
      return
    }
    haptic.pick()
    if (row.toggle === undefined && !row.keepOpen) props.onClose()
    row.onPress?.()
  }
  return (
    <Pressable
      onPress={press}
      disabled={row.disabled}
      accessibilityRole={row.toggle !== undefined ? 'switch' : 'menuitem'}
      accessibilityState={{
        disabled: !!row.disabled,
        ...(row.checked !== undefined ? { checked: row.checked } : {}),
        ...(row.toggle !== undefined ? { checked: row.toggle } : {}),
      }}
      accessibilityLabel={[row.label, row.subtitle, row.detail].filter(Boolean).join('，')}
      style={({ pressed }) => [
        styles.row,
        (pressed || row.checked) && { backgroundColor: s.menuActive },
        row.disabled && { opacity: 0.4 },
      ]}
    >
      {row.lead ? (
        <View style={styles.lead}>{row.lead}</View>
      ) : row.icon ? (
        <View style={styles.lead}>
          <Icon icon={row.icon} size={18} color={row.destructive ? c.danger : c.textSecondary} />
        </View>
      ) : null}
      <View style={styles.text}>
        <Text style={[styles.label, { color }]} numberOfLines={2}>
          {row.label}
        </Text>
        {row.subtitle ? (
          <Text style={[styles.subtitle, { color: c.textSecondary }]} numberOfLines={2}>
            {row.subtitle}
          </Text>
        ) : null}
        {row.below}
      </View>
      {row.detail ? (
        <Text style={[styles.detail, { color: c.textSecondary }]} numberOfLines={1}>
          {row.detail}
        </Text>
      ) : null}
      {row.trail}
      {row.toggle !== undefined ? (
        // The system's own switch: a scale or an off color of ours breaks iOS 26's glass knob.
        <Switch
          value={row.toggle}
          onValueChange={() => press()}
          disabled={row.disabled}
          trackColor={
            Platform.OS === 'ios' ? { true: c.accent } : { true: c.accent, false: c.fillStrong }
          }
        />
      ) : null}
      {row.checked ? <Check color={c.tint} /> : null}
      {row.page ? <Icon icon={G.right} size={12} color={c.textTertiary} weight="semibold" /> : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  // The shadow is on a view of its own, since the panel's clip would cut it off.
  menu: {
    position: 'absolute',
    borderRadius: MENU_RADIUS,
    shadowOpacity: 0.22,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  },
  panel: { borderRadius: MENU_RADIUS, borderCurve: 'continuous' },
  clip: { borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  list: { padding: 6 },
  back: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 44,
    marginHorizontal: 6,
    marginTop: 6,
    paddingHorizontal: 10,
    borderRadius: 12,
  },
  backTitle: { fontSize: 16, fontWeight: '600', flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 46,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
  },
  lead: { width: 22, alignItems: 'center' },
  text: { flex: 1, minWidth: 0 },
  label: { fontSize: 16, lineHeight: 21 },
  subtitle: { fontSize: 12.5, lineHeight: 17, marginTop: 1 },
  detail: { fontSize: 14, fontVariant: ['tabular-nums'], maxWidth: 140 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 5, marginHorizontal: 10 },
  footer: {
    fontSize: 12.5,
    lineHeight: 17,
    paddingHorizontal: 12,
    paddingTop: 4,
    paddingBottom: 6,
  },
  state: { alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 64, padding: 12 },
  stateText: { fontSize: 14, lineHeight: 19, textAlign: 'center' },
  retry: { fontSize: 14, fontWeight: '600' },
})
