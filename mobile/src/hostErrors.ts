// What a failed request to the computer says, in Chinese: the host answers with a code and its own
// words in English, which the phone showed as they came. The code says what happened; the host's
// words follow only where they name what failed, as an agent's or git's own message does.

/** The codes a host's or the link's failure carries (port-rpc.ts, link.ts). */
const BY_CODE: Record<string, string> = {
  host_restarted: '和电脑的连接断了，请重试。',
  host_offline: '这台电脑没有连上，等它回来后再试。',
  timeout: '电脑没有及时回应，请重试。',
  not_found: '找不到了，可能已在电脑上删除或结束。',
  busy: '电脑正忙，请稍后再试。',
  restricted: '这台手机不能这样做。',
  forbidden: '这台手机不能这样做。',
  terminal_not_allowed: '电脑没有开放终端。',
  agent_unavailable: '这个 Agent 现在用不了，可以到 设置 › Agent 里看看。',
  auth_required: 'Agent 需要登录，可以在 设置 › Agent 里登录后再试。',
  conflict: '情况已经变了，请再试一次。',
  invalid_params: '电脑没有接受这个请求，可能要把电脑和手机上的纸鸢都更新一下。',
  unknown_method: '电脑上的纸鸢还不支持这样做，请更新它。',
  unavailable: '电脑上现在没有这项服务。',
}

/** Codes whose own words say what failed, kept after the Chinese line. */
const WITH_DETAIL: Record<string, string> = {
  agent_error: 'Agent 出错了。',
  git_error: 'Git 出错了。',
  internal: '电脑上出错了。',
}

const CJK = /[㐀-鿿]/

/** Whether the text is written in Chinese, as the host writes for a Chinese reader. */
export function hasChinese(text: string): boolean {
  return CJK.test(text)
}

function field(error: unknown, name: 'code' | 'message'): string | null {
  if (typeof error !== 'object' || error === null) return null
  const value = (error as Record<string, unknown>)[name]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/**
 * A failed request in words for the user: the host's own words when they are Chinese already,
 * else what its code means, else `fallback`. `lead` says what failed in place of the line that a
 * code carrying the host's own words gets, such as 「安装没有完成。」 for an install.
 */
export function hostErrorText(error: unknown, fallback = '请稍后再试。', lead?: string): string {
  const code = field(error, 'code')
  const message = field(error, 'message')
  if (message && CJK.test(message)) return message
  if (code && BY_CODE[code]) return BY_CODE[code]
  if (code && WITH_DETAIL[code]) {
    const line = lead ?? WITH_DETAIL[code]
    return message ? `${line}\n${message}` : line
  }
  // A failure of the phone's own, such as no network, says so in the system's words.
  if (error instanceof TypeError && message) return `网络出错了：${message}`
  return fallback
}
