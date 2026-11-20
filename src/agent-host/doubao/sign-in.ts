// Doubao CLI's sign-in: `login --qr=png` prints the path of a QR code picture, which the Doubao app
// on a phone scans, and waits for the phone to confirm; `auth status` and `logout` print one
// sentence each. The CLI words them in Chinese only, as below (2.37.2's native strings).

/** Kettu's id for the QR code sign-in. */
export const SIGN_IN_METHOD = 'doubao-qr'

/** The line that names the picture of a QR code, each time a new one is shown. */
const QR_IMAGE = /^QR_IMAGE=(.+)$/

export function qrImagePath(line: string): string | null {
  const match = QR_IMAGE.exec(line.trim())
  return match ? match[1]!.trim() : null
}

export type AuthState = 'signed-in' | 'signed-out' | 'unknown'

/** What `auth status` printed: signed in, signed out, or what Kettu cannot tell. */
export function authState(output: string): AuthState {
  if (output.includes('登录成功')) return 'signed-in'
  // "当前未登录", "登录凭据或账号身份已失效", "未找到通过验证的账号会话".
  if (/未登录|已失效|重新登录/.test(output)) return 'signed-out'
  return 'unknown'
}

/** Whether a turn's error says the account must sign in again. */
export function needsSignIn(code: string | undefined, message: string): boolean {
  return code === 'login_required' || /doubao login|未登录|重新登录/.test(message)
}

/**
 * The words of a line the CLI printed for the user, without its log lines (`[cli-chat] {…}`), its
 * colors or a QR code drawn in the terminal; null for one with none.
 */
export function userLine(line: string): string | null {
  // eslint-disable-next-line no-control-regex
  const text = line.replace(/\u001b\[[0-9;]*m/g, '').trim()
  if (!text || text.startsWith('[cli-chat]') || /^[\s█▀▄]+$/.test(text)) return null
  if (QR_IMAGE.test(text)) return null
  return text
}
