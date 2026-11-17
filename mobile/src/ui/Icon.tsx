// Every icon in the app, by name: an SF Symbol on iOS, so it matches the system's own, and the
// Lucide glyph of the same idea elsewhere.

import { Platform } from 'react-native'
import { SymbolView, type SymbolViewProps, type SymbolWeight } from 'expo-symbols'
import {
  Apple,
  Archive,
  Bell,
  Box,
  Calendar,
  CalendarClock,
  ChartNoAxesColumn,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleMinus,
  CircleX,
  Clock,
  Download,
  Ellipsis,
  FileText,
  Folder,
  History,
  Inbox,
  Info,
  Laptop,
  Layers,
  LayoutGrid,
  Link,
  MessageSquare,
  Monitor,
  Pause,
  Pin,
  PinOff,
  Plus,
  Presentation,
  Repeat,
  RotateCw,
  ScanLine,
  Search,
  Smartphone,
  Sparkles,
  Terminal,
  Timer,
  TriangleAlert,
  UserRound,
  Wifi,
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
} as const satisfies Record<string, readonly [SFSymbol, LucideIcon]>

export type IconName = keyof typeof ICONS

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
