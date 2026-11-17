// The git panel's and the session menu's own icons, beside the session set in icons.tsx, and a
// pull request's state mark in its state's color, as the desktop's PrIcon draws it.

import { View } from 'react-native'
import {
  CircleDashed,
  Clock,
  Download,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  RefreshCw,
  Search,
  Terminal,
  Undo2,
  Workflow,
} from 'lucide-react-native'
import type { PullRequestState } from '@shared/git'
import { Icon, type IconSpec } from './Icon'
import { useSessionTokens } from './palette'

export const GI = {
  pr: { sf: 'arrow.triangle.pull', lucide: GitPullRequest },
  prDraft: { sf: 'circle.dashed', lucide: GitPullRequestDraft },
  prMerged: { sf: 'arrow.triangle.merge', lucide: GitMerge },
  prClosed: { sf: 'xmark.circle', lucide: GitPullRequestClosed },
  pull: { sf: 'arrow.down.circle', lucide: Download },
  fetch: { sf: 'arrow.triangle.2.circlepath', lucide: RefreshCw },
  search: { sf: 'magnifyingglass', lucide: Search },
  discard: { sf: 'arrow.uturn.backward', lucide: Undo2 },
  routine: { sf: 'clock', lucide: Clock },
  task: { sf: 'point.3.connected.trianglepath.dotted', lucide: Workflow },
  resume: { sf: 'terminal', lucide: Terminal },
  queued: { sf: 'circle.dashed', lucide: CircleDashed },
} satisfies Record<string, IconSpec>

export const PR_STATE_TEXT: Record<PullRequestState, string> = {
  open: '已打开',
  draft: '草稿',
  merged: '已合并',
  closed: '已关闭',
}

export function prIcon(state: PullRequestState | null): IconSpec {
  switch (state) {
    case 'draft':
      return GI.prDraft
    case 'merged':
      return GI.prMerged
    case 'closed':
      return GI.prClosed
    default:
      return GI.pr
  }
}

export function usePrColor(): (state: PullRequestState | null) => string {
  const { c, s } = useSessionTokens()
  return (state) =>
    state === 'open'
      ? c.success
      : state === 'merged'
        ? s.merged
        : state === 'closed'
          ? c.danger
          : c.textSecondary
}

/** A pull request's state icon in its color, with a red dot for failing checks. */
export function PrMark(props: {
  state: PullRequestState | null
  size?: number
  failing?: boolean
  /** The surface under it, which rings the dot. */
  ring?: string
}) {
  const { c, s } = useSessionTokens()
  const color = usePrColor()(props.state)
  const size = props.size ?? 13
  return (
    <View>
      <Icon icon={prIcon(props.state)} size={size} color={color} />
      {props.failing ? (
        <View
          style={{
            position: 'absolute',
            top: -1,
            right: -2,
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: c.danger,
            borderWidth: 1,
            borderColor: props.ring ?? s.dockCard,
          }}
        />
      ) : null}
    </View>
  )
}
