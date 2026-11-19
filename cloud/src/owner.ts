// The owner's web page, /account/admin/: the accounts, which it disables and enables, and the
// invite codes, which it makes and revokes. Only a web session of the owner's own account reaches
// it, and every change is a form carrying the session's CSRF token. Removing an account and
// resetting one stay with the commands on the server.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { listAccounts, parseAdminRequest, runAdmin, type AdminContext } from './admin'
import type { Auth } from './auth'
import { readForm, redirect, sendHtml } from './http'
import { loginPage, messagePage, ownerPage } from './pages'

const PATH = '/account/admin/'

export class OwnerPage {
  constructor(
    private readonly options: {
      auth: Pick<Auth, 'webSession' | 'csrfOk'>
      admin: AdminContext
      secure: boolean
    },
  ) {}

  /** The owner's web session, or null after answering with the sign-in page or a refusal. */
  private owner(request: IncomingMessage, response: ServerResponse) {
    const web = this.options.auth.webSession(request)
    if (!web) {
      sendHtml(
        response,
        this.options.secure,
        200,
        loginPage({ action: '/web/login', fields: { next: PATH }, purpose: '机主登录后管理账号' }),
      )
      return null
    }
    if (!web.account.owner) {
      sendHtml(
        response,
        this.options.secure,
        403,
        messagePage('没有权限', '只有机主能管理账号和邀请码。'),
      )
      return null
    }
    return web
  }

  private render(
    response: ServerResponse,
    csrf: string,
    extra: { created?: { code: string; expiresAt: number }; error?: string } = {},
  ): void {
    const { accounts, invites } = listAccounts(this.options.admin.store)
    sendHtml(
      response,
      this.options.secure,
      extra.error ? 400 : 200,
      ownerPage({ csrf, accounts, invites, ...extra }),
    )
  }

  /** GET /account/admin/ */
  page(request: IncomingMessage, response: ServerResponse): void {
    const web = this.owner(request, response)
    if (web) this.render(response, web.session.csrf)
  }

  /** POST /account/admin/ */
  async submit(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const form = await readForm(request)
    const web = this.owner(request, response)
    if (!web) return
    if (!this.options.auth.csrfOk(form, web.session)) {
      return redirect(response, this.options.secure, PATH)
    }
    const action = form.get('action')
    // The page offers these four alone; the rest is the server's commands'.
    const call = parseAdminRequest(
      action === 'invite'
        ? { op: 'invite', days: Number(form.get('days')) }
        : action === 'revoke'
          ? { op: 'uninvite', id: form.get('invite') ?? '' }
          : action === 'disable' || action === 'enable'
            ? { op: action, username: form.get('username') ?? '' }
            : null,
    )
    if (!call) return this.render(response, web.session.csrf, { error: '这个操作不对。' })
    const answer = runAdmin(this.options.admin, call)
    if (!answer.ok) return this.render(response, web.session.csrf, { error: answer.error })
    if (answer.answer.code && answer.answer.invite) {
      // Shown in this answer alone: the code is kept only as its hash.
      return this.render(response, web.session.csrf, {
        created: { code: answer.answer.code, expiresAt: answer.answer.invite.expiresAt },
      })
    }
    redirect(response, this.options.secure, PATH)
  }
}
