// The session screens' icons, each by its SF Symbol and its Lucide fallback, and the marks no icon
// set has: an agent's mark, the computer's system and a file's type.

import { Text, View } from 'react-native'
import Svg, { Rect } from 'react-native-svg'
import {
  Apple,
  ArrowRightLeft,
  ArrowUp,
  Braces,
  Brain,
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Circle,
  CircleCheck,
  CircleDot,
  CircleX,
  Copy,
  Ellipsis,
  ExternalLink,
  File,
  FileImage,
  FileText,
  Folder,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  GitPullRequest,
  Globe,
  Hand,
  Images,
  Info,
  Layers,
  ListChecks,
  MessageSquare,
  Monitor,
  OctagonAlert,
  Paperclip,
  Pencil,
  Plus,
  Repeat,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Square,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  Upload,
  Users,
  Wrench,
  X,
  ArrowDown,
  Archive,
  ArrowLeftRight,
  AtSign,
  Bell,
  BellOff,
  CircleSlash,
  CornerDownRight,
  Diff,
  Eye,
  FolderOpen,
  Image as ImageIcon,
  ListPlus,
  Pin,
  PinOff,
  RotateCw,
  Settings,
  Share,
  WifiOff,
  Zap,
  ClipboardPaste,
  CornerDownLeft,
  SlidersHorizontal,
  Timer,
  TextSelect,
  Undo2,
} from 'lucide-react-native'
import type { HarnessId } from '@shared/agents'
import { harnessOf, markFor } from '../agent-marks'
import type { ToolKind } from '@shared/thread'
import { extensionOf } from './format'
import { Icon, type IconSpec } from './Icon'
import { MONO, useSessionTokens, type SessionPalette } from './palette'

export { Icon, STROKE, type IconSpec } from './Icon'

export const G = {
  back: { sf: 'chevron.left', lucide: ChevronLeft },
  close: { sf: 'xmark', lucide: X },
  more: { sf: 'ellipsis', lucide: Ellipsis },
  down: { sf: 'chevron.down', lucide: ChevronDown },
  right: { sf: 'chevron.right', lucide: ChevronRight },
  upDown: { sf: 'chevron.up.chevron.down', lucide: ChevronsUpDown },
  plus: { sf: 'plus', lucide: Plus },
  send: { sf: 'arrow.up', lucide: ArrowUp },
  toBottom: { sf: 'arrow.down', lucide: ArrowDown },
  stop: { sf: 'stop.fill', lucide: Square },
  copy: { sf: 'doc.on.doc', lucide: Copy },
  copied: { sf: 'checkmark', lucide: Check },
  fork: { sf: 'arrow.triangle.branch', lucide: GitFork },
  undo: { sf: 'arrow.uturn.backward', lucide: Undo2 },
  warning: { sf: 'exclamationmark.triangle', lucide: TriangleAlert },
  error: { sf: 'xmark.octagon', lucide: OctagonAlert },
  info: { sf: 'info.circle', lucide: Info },
  shield: { sf: 'shield', lucide: Shield },
  shieldCheck: { sf: 'checkmark.shield', lucide: ShieldCheck },
  shieldAlert: { sf: 'exclamationmark.shield', lucide: ShieldAlert },
  hand: { sf: 'hand.raised', lucide: Hand },
  camera: { sf: 'camera', lucide: Camera },
  photos: { sf: 'photo.on.rectangle', lucide: Images },
  file: { sf: 'doc', lucide: File },
  paperclip: { sf: 'paperclip', lucide: Paperclip },
  folder: { sf: 'folder.fill', lucide: Folder },
  plan: { sf: 'checklist', lucide: ListChecks },
  done: { sf: 'checkmark.circle.fill', lucide: CircleCheck },
  doing: { sf: 'circle.inset.filled', lucide: CircleDot },
  todo: { sf: 'circle', lucide: Circle },
  failed: { sf: 'xmark.circle.fill', lucide: CircleX },
  thought: { sf: 'brain', lucide: Brain },
  compact: { sf: 'square.stack.3d.up', lucide: Layers },
  subagent: { sf: 'person.2', lucide: Users },
  artifact: { sf: 'sparkles', lucide: Sparkles },
  commit: { sf: 'smallcircle.filled.circle', lucide: GitCommitHorizontal },
  push: { sf: 'arrow.up.circle', lucide: Upload },
  branch: { sf: 'arrow.triangle.branch', lucide: GitBranch },
  pr: { sf: 'arrow.triangle.pull', lucide: GitPullRequest },
  link: { sf: 'arrow.up.right.square', lucide: ExternalLink },
  terminal: { sf: 'apple.terminal', lucide: SquareTerminal },
  queue: { sf: 'list.bullet', lucide: ListPlus },
  photo: { sf: 'photo', lucide: ImageIcon },
  folderOpen: { sf: 'folder', lucide: FolderOpen },
  mention: { sf: 'at', lucide: AtSign },
  slash: { sf: 'slash.circle', lucide: CircleSlash },
  eye: { sf: 'eye', lucide: Eye },
  pencil: { sf: 'pencil', lucide: Pencil },
  bolt: { sf: 'bolt', lucide: Zap },
  layers: { sf: 'square.stack.3d.up', lucide: Layers },
  gear: { sf: 'gearshape', lucide: Settings },
  swap: { sf: 'arrow.left.arrow.right', lucide: ArrowLeftRight },
  pin: { sf: 'pin', lucide: Pin },
  unpin: { sf: 'pin.slash', lucide: PinOff },
  unread: { sf: 'circle', lucide: Circle },
  read: { sf: 'checkmark.circle', lucide: CircleCheck },
  mute: { sf: 'bell.slash', lucide: BellOff },
  unmute: { sf: 'bell', lucide: Bell },
  archive: { sf: 'archivebox', lucide: Archive },
  trash: { sf: 'trash', lucide: Trash2 },
  stopOutline: { sf: 'stop', lucide: Square },
  child: { sf: 'arrow.turn.down.right', lucide: CornerDownRight },
  changes: { sf: 'plusminus', lucide: Diff },
  artifacts: { sf: 'square.on.square', lucide: Copy },
  share: { sf: 'square.and.arrow.up', lucide: Share },
  retry: { sf: 'arrow.clockwise', lucide: RotateCw },
  check: { sf: 'checkmark', lucide: Check },
  wifiOff: { sf: 'wifi.slash', lucide: WifiOff },
  timer: { sf: 'timer', lucide: Timer },
  paste: { sf: 'doc.on.clipboard', lucide: ClipboardPaste },
  sliders: { sf: 'slider.horizontal.3', lucide: SlidersHorizontal },
  sendNow: { sf: 'arrow.turn.down.left', lucide: CornerDownLeft },
  select: { sf: 'character.cursor.ibeam', lucide: TextSelect },
  comment: { sf: 'bubble.left', lucide: MessageSquare },
} satisfies Record<string, IconSpec>

export const TOOL_ICONS: Record<ToolKind, IconSpec> = {
  read: { sf: 'doc.text', lucide: FileText },
  edit: { sf: 'pencil', lucide: Pencil },
  delete: { sf: 'trash', lucide: Trash2 },
  move: { sf: 'arrow.left.arrow.right', lucide: ArrowRightLeft },
  search: { sf: 'magnifyingglass', lucide: Search },
  execute: { sf: 'apple.terminal', lucide: SquareTerminal },
  think: { sf: 'brain', lucide: Brain },
  fetch: { sf: 'globe', lucide: Globe },
  switch_mode: { sf: 'arrow.triangle.2.circlepath', lucide: Repeat },
  other: { sf: 'wrench.and.screwdriver', lucide: Wrench },
}

/** An agent the phone has no mark for: its initial on a quiet tile, never another agent's mark. */
function AgentInitial(props: { agentId: string; size: number }) {
  const { c } = useSessionTokens()
  const side = props.size
  return (
    <View
      style={{
        width: side,
        height: side,
        borderRadius: Math.round(side * 0.28),
        backgroundColor: c.fillStrong,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text
        style={{ color: c.textSecondary, fontSize: Math.round(side * 0.6), fontWeight: '700' }}
        allowFontScaling={false}
      >
        {harnessOf(props.agentId).trim().charAt(0).toUpperCase() || '?'}
      </Text>
    </View>
  )
}

/** An agent's own mark, as the shell draws it, or its initial for a harness without one here. */
/** A harness's mark where only the harness is known, as the share sheet's rows have it. */
export function AgentMark(props: { harness: HarnessId | undefined; size?: number }) {
  return <AgentGlyph agentId={props.harness ?? '?'} {...(props.size ? { size: props.size } : {})} />
}

export function AgentGlyph(props: { agentId: string; harness?: HarnessId; size?: number }) {
  const { c, scheme } = useSessionTokens()
  const size = props.size ?? 16
  const mark = markFor(props.agentId) ?? (props.harness ? markFor(props.harness) : null)
  if (!mark) return <AgentInitial agentId={props.agentId} size={size} />
  return (
    <Svg width={size} height={size} viewBox={mark.viewBox}>
      <mark.Body ink={{ scheme, text: c.text }} />
    </Svg>
  )
}

/** The four panes of Windows. */
function WindowsMark(props: { size: number; color: string }) {
  const half = 7.2
  const gap = 1.6
  const pane = (x: number, y: number) => (
    <Rect x={x} y={y} width={half} height={half} rx={0.6} fill={props.color} />
  )
  return (
    <Svg width={props.size} height={props.size} viewBox="0 0 16 16">
      {pane(0, 0)}
      {pane(half + gap, 0)}
      {pane(0, half + gap)}
      {pane(half + gap, half + gap)}
    </Svg>
  )
}

/** The computer's system, as Node.js names its platform. */
export function SystemMark(props: { platform: string | null; size?: number; color: string }) {
  const size = props.size ?? 14
  if (props.platform === 'win32') return <WindowsMark size={size - 1} color={props.color} />
  const icon: IconSpec =
    props.platform === 'darwin'
      ? { sf: 'apple.logo', lucide: Apple }
      : { sf: 'desktopcomputer', lucide: Monitor }
  return <Icon icon={icon} size={size} color={props.color} />
}

type Lang = keyof SessionPalette['lang']

const BADGES: Record<string, { text: string; lang: Lang }> = {
  js: { text: 'JS', lang: 'js' },
  mjs: { text: 'JS', lang: 'js' },
  cjs: { text: 'JS', lang: 'js' },
  jsx: { text: 'JSX', lang: 'js' },
  ts: { text: 'TS', lang: 'ts' },
  mts: { text: 'TS', lang: 'ts' },
  cts: { text: 'TS', lang: 'ts' },
  tsx: { text: 'TSX', lang: 'ts' },
  py: { text: 'PY', lang: 'py' },
  rs: { text: 'RS', lang: 'rs' },
  go: { text: 'GO', lang: 'go' },
  html: { text: '<>', lang: 'web' },
  vue: { text: 'V', lang: 'web' },
  svelte: { text: 'S', lang: 'web' },
  css: { text: '#', lang: 'style' },
  scss: { text: '#', lang: 'style' },
  java: { text: 'J', lang: 'rs' },
  kt: { text: 'K', lang: 'style' },
  swift: { text: 'SW', lang: 'rs' },
  c: { text: 'C', lang: 'ts' },
  cpp: { text: 'C+', lang: 'ts' },
  h: { text: 'H', lang: 'ts' },
  cs: { text: 'C#', lang: 'style' },
  rb: { text: 'RB', lang: 'rs' },
  php: { text: 'PHP', lang: 'style' },
}

const SHELL = new Set(['sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd'])
const DATA = new Set(['json', 'jsonc', 'yaml', 'yml', 'toml', 'xml', 'ini', 'lock', 'env'])
const TEXT = new Set(['md', 'mdx', 'txt', 'rst', 'log', 'csv'])
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'heic', 'avif'])

/** A file's type at a glance: a language's letters in its color, or an icon. */
export function FileMark(props: { path: string; size?: number }) {
  const { s } = useSessionTokens()
  const size = props.size ?? 16
  const ext = extensionOf(props.path)
  const badge = BADGES[ext]
  if (badge) {
    return (
      <View style={{ width: size + 4, alignItems: 'center' }}>
        <Text
          style={{
            color: s.lang[badge.lang],
            fontFamily: MONO,
            fontSize: badge.text.length > 2 ? 8.5 : 10.5,
            fontWeight: '800',
          }}
          numberOfLines={1}
        >
          {badge.text}
        </Text>
      </View>
    )
  }
  const [icon, lang]: [IconSpec, Lang] = SHELL.has(ext)
    ? [{ sf: 'apple.terminal', lucide: SquareTerminal }, 'shell']
    : DATA.has(ext)
      ? [{ sf: 'curlybraces', lucide: Braces }, 'data']
      : TEXT.has(ext)
        ? [{ sf: 'doc.text', lucide: FileText }, 'other']
        : IMAGE.has(ext)
          ? [{ sf: 'photo', lucide: FileImage }, 'style']
          : [{ sf: 'doc', lucide: File }, 'other']
  return (
    <View style={{ width: size + 4, alignItems: 'center' }}>
      <Icon icon={icon} size={size - 1} color={s.lang[lang]} weight="regular" />
    </View>
  )
}
