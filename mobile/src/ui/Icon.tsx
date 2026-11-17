// Every icon in the app, by name: an SF Symbol on iOS, so it matches the system's own, and the
// Lucide glyph of the same idea elsewhere.

import { Platform } from 'react-native'
import { SymbolView, type SymbolViewProps, type SymbolWeight } from 'expo-symbols'
import {
  Apple,
  Archive,
  ArrowUp,
  ArrowUpRight,
  Bell,
  Box,
  Calendar,
  CalendarClock,
  ChartNoAxesColumn,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  CircleCheck,
  CircleMinus,
  CircleStop,
  CircleX,
  Clock,
  Code,
  Contrast,
  Download,
  Ellipsis,
  EyeOff,
  FileText,
  Folder,
  GitBranch,
  Globe,
  Hand,
  History,
  Inbox,
  Info,
  Languages,
  Laptop,
  Layers,
  LayoutGrid,
  Link,
  ListFilter,
  Lock,
  MessageSquare,
  Monitor,
  Network,
  Pause,
  Pencil,
  Pin,
  PinOff,
  Play,
  Plus,
  Presentation,
  Repeat,
  RotateCw,
  ScanFace,
  ScanLine,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Terminal,
  Timer,
  Trash2,
  TriangleAlert,
  Undo2,
  UserRound,
  Wifi,
  Workflow,
  X,
  type LucideIcon,
} from 'lucide-react-native'
import { size as sizes, useTokens } from './tokens'

type SFSymbol = Extract<SymbolViewProps['name'], string>

const ICONS = {
  inbox: ['tray', Inbox],
  box: ['shippingbox', Box],
  history: ['clock.arrow.circlepath', History],
  chart: ['chart.bar', ChartNoAxesColumn],
  plus: ['plus', Plus],
  search: ['magnifyingglass', Search],
  layers: ['square.3.layers.3d', Layers],
  person: ['person.fill', UserRound],
  folder: ['folder', Folder],
  chevronRight: ['chevron.right', ChevronRight],
  chevronLeft: ['chevron.left', ChevronLeft],
  chevronDown: ['chevron.down', ChevronDown],
  close: ['xmark', X],
  refresh: ['arrow.clockwise', RotateCw],
  calendar: ['calendar', Calendar],
  calendarClock: ['calendar.badge.clock', CalendarClock],
  clock: ['clock', Clock],
  timer: ['timer', Timer],
  archive: ['archivebox', Archive],
  check: ['checkmark', Check],
  pin: ['pin', Pin],
  unpin: ['pin.slash', PinOff],
  desktop: ['desktopcomputer', Monitor],
  laptop: ['laptopcomputer', Laptop],
  apple: ['apple.logo', Apple],
  terminal: ['terminal', Terminal],
  scan: ['qrcode.viewfinder', ScanLine],
  link: ['link', Link],
  bell: ['bell', Bell],
  info: ['info.circle', Info],
  warning: ['exclamationmark.triangle', TriangleAlert],
  failed: ['xmark.circle', CircleX],
  succeeded: ['checkmark.circle', CircleCheck],
  skipped: ['minus.circle', CircleMinus],
  pause: ['pause.circle', Pause],
  repeat: ['repeat', Repeat],
  canvas: ['square.grid.2x2', LayoutGrid],
  doc: ['doc.text', FileText],
  slides: ['rectangle.on.rectangle', Presentation],
  sparkles: ['sparkles', Sparkles],
  wifi: ['wifi', Wifi],
  phone: ['iphone', Smartphone],
  download: ['arrow.down.circle', Download],
  more: ['ellipsis', Ellipsis],
  message: ['bubble.left', MessageSquare],
  external: ['arrow.up.right', ArrowUpRight],
  faceId: ['faceid', ScanFace],
  lock: ['lock', Lock],
  theme: ['circle.lefthalf.filled', Contrast],
  globe: ['globe', Globe],
  code: ['chevron.left.forwardslash.chevron.right', Code],
  hand: ['hand.raised', Hand],
  trash: ['trash', Trash2],
  sort: ['line.3.horizontal.decrease', ListFilter],
  sliders: ['slider.horizontal.3', SlidersHorizontal],
  restore: ['arrow.uturn.backward', Undo2],
  play: ['play.fill', Play],
  network: ['point.3.connected.trianglepath.dotted', Network],
  upDown: ['chevron.up.chevron.down', ChevronsUpDown],
  pencil: ['pencil', Pencil],
  eyeSlash: ['eye.slash', EyeOff],
  shield: ['lock.shield', ShieldCheck],
  language: ['character.bubble', Languages],
  flow: ['flowchart', Workflow],
  branch: ['arrow.triangle.branch', GitBranch],
  stop: ['stop.circle', CircleStop],
  send: ['arrow.up', ArrowUp],
} as const satisfies Record<string, readonly [SFSymbol, LucideIcon]>

export type IconName = keyof typeof ICONS

/** An icon's SF Symbol, for the system's own controls. */
export function sfSymbol(name: IconName): SFSymbol {
  return ICONS[name][0]
}

export function Icon(props: {
  name: IconName
  size?: number
  color?: string
  /** The SF Symbol's weight; Lucide strokes follow it roughly. */
  weight?: SymbolWeight
}) {
  const { c } = useTokens()
  const [symbol, Glyph] = ICONS[props.name]
  const side = props.size ?? sizes.icon
  const color = props.color ?? c.text
  if (Platform.OS === 'ios') {
    return (
      <SymbolView
        name={symbol}
        size={side}
        tintColor={color}
        weight={props.weight ?? 'regular'}
        style={{ width: side, height: side }}
      />
    )
  }
  const stroke = props.weight === 'semibold' || props.weight === 'bold' ? 2.3 : 1.9
  return <Glyph size={side} color={color} strokeWidth={stroke} />
}
