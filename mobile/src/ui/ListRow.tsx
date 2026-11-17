// Grouped rows in the iOS Settings manner: a rounded group, rows split by inset hairlines, an
// optional icon tile, a value or chevron at the end.

import { Children, Fragment, isValidElement, type ReactElement, type ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Icon, type IconName } from './Icon'
import { Press } from './Press'
import { radius, space, type as typeScale, useTokens } from './tokens'

/** Whether a row of a group starts with a ListRow's icon, so the line above it starts at its text. */
function hasIcon(row: ReactElement): boolean {
  const props = row.props as { icon?: unknown } | null
  return row.type === ListRow && !!props?.icon
}

export function ListGroup(props: { children: ReactNode; header?: string; footer?: string }) {
  const { c } = useTokens()
  const rows = Children.toArray(props.children).filter(isValidElement)
  return (
    <View style={styles.groupWrap}>
      {props.header ? (
        <Text
          style={[typeScale.headline, styles.header, { color: c.textSecondary }]}
          accessibilityRole="header"
        >
          {props.header}
        </Text>
      ) : null}
      <View style={[styles.group, { backgroundColor: c.surface, borderColor: c.border }]}>
        {rows.map((row, i) => (
          <Fragment key={row.key ?? i}>
            {i > 0 && (
              <View
                style={[
                  styles.separator,
                  hasIcon(row) && styles.underText,
                  { backgroundColor: c.border },
                ]}
              />
            )}
            {row}
          </Fragment>
        ))}
      </View>
      {props.footer ? (
        <Text style={[typeScale.footnote, styles.footer, { color: c.textTertiary }]}>
          {props.footer}
        </Text>
      ) : null}
    </View>
  )
}

export function ListRow(props: {
  title: string
  subtitle?: string
  value?: string
  icon?: IconName
  /** The icon tile's color; neutral when absent. */
  iconTint?: string
  leading?: ReactNode
  trailing?: ReactNode
  chevron?: boolean
  /** Opens outside the app: an arrow out instead of the chevron. */
  external?: boolean
  /** The icon bare and tinted, as Settings rows draw it, instead of on a tile. */
  plainIcon?: boolean
  destructive?: boolean
  /** The title in the tint color, for a row that is an action. */
  action?: boolean
  disabled?: boolean
  onPress?: () => void
  onLongPress?: () => void
}) {
  const { c } = useTokens()
  const titleColor = props.destructive ? c.danger : props.action ? c.tint : c.text
  const body = (
    <View style={styles.row}>
      {props.leading}
      {props.icon && props.plainIcon ? (
        <View style={styles.glyph}>
          <Icon name={props.icon} size={22} color={props.iconTint ?? c.tint} />
        </View>
      ) : null}
      {props.icon && !props.plainIcon && (
        <View style={[styles.tile, { backgroundColor: props.iconTint ?? c.fillStrong }]}>
          <Icon
            name={props.icon}
            size={17}
            color={props.iconTint ? c.onAccent : c.text}
            weight="medium"
          />
        </View>
      )}
      <View style={styles.text}>
        <Text style={[typeScale.body, { color: titleColor }]} numberOfLines={1}>
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text style={[typeScale.footnote, { color: c.textSecondary }]} numberOfLines={3}>
            {props.subtitle}
          </Text>
        ) : null}
      </View>
      {props.value ? (
        <Text
          style={[typeScale.callout, styles.value, { color: c.textSecondary }]}
          numberOfLines={1}
        >
          {props.value}
        </Text>
      ) : null}
      {props.trailing}
      {props.chevron && (
        <Icon name="chevronRight" size={14} color={c.textTertiary} weight="semibold" />
      )}
      {props.external && (
        <Icon name="external" size={14} color={c.textTertiary} weight="semibold" />
      )}
    </View>
  )
  if (!props.onPress && !props.onLongPress) return body
  return (
    <Press
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      disabled={props.disabled}
      scale={false}
      highlight={c.fill}
      accessibilityRole="button"
      accessibilityLabel={props.title}
    >
      {body}
    </Press>
  )
}

const styles = StyleSheet.create({
  groupWrap: { gap: space.sm },
  header: { marginLeft: space.lg, textTransform: 'none' },
  footer: { marginHorizontal: space.lg },
  group: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: space.lg, marginRight: space.lg },
  // The row's padding, its 30 point icon and the gap after it, as Settings lines up its rules.
  underText: { marginLeft: space.lg + 30 + space.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 52,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  tile: {
    width: 30,
    height: 30,
    borderRadius: radius.sm - 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: { width: 30, alignItems: 'center', justifyContent: 'center' },
  text: { flex: 1, gap: 2 },
  value: { flexShrink: 1, maxWidth: '55%', textAlign: 'right' },
})
