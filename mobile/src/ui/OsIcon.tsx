// The computer's operating system as a small glyph: the four panes for Windows, the Apple symbol
// for macOS, a terminal for Linux, a monitor when it is not known yet.

import Svg, { Rect } from 'react-native-svg'
import { Icon } from './Icon'
import { useTokens } from './tokens'

export function OsIcon(props: { platform: string | undefined; size?: number; color?: string }) {
  const { c } = useTokens()
  const side = props.size ?? 18
  const color = props.color ?? c.text
  if (props.platform === 'win32') {
    const pane = side * 0.46
    const far = side - pane
    return (
      <Svg width={side} height={side}>
        <Rect x={0} y={0} width={pane} height={pane} rx={1} fill={color} />
        <Rect x={far} y={0} width={pane} height={pane} rx={1} fill={color} />
        <Rect x={0} y={far} width={pane} height={pane} rx={1} fill={color} />
        <Rect x={far} y={far} width={pane} height={pane} rx={1} fill={color} />
      </Svg>
    )
  }
  if (props.platform === 'darwin') return <Icon name="apple" size={side} color={color} />
  if (props.platform === 'linux') return <Icon name="terminal" size={side} color={color} />
  return <Icon name="desktop" size={side} color={color} />
}
