// The owner's calls beyond sessions (src/shared/remote/host-admin.ts) that the phone makes: the
// computer's account, renaming or removing this phone, artifact previews. Every paired device is
// its computer's owner, so the remote host hands these to the desktop app; a daemon answers some
// with `unavailable`.

import type { HostLink } from '@shared/remote/link'
import type { HostAdminMethod, HostAdminParams, HostAdminResult } from '@shared/remote/host-admin'

export function admin<M extends HostAdminMethod>(
  link: HostLink,
  method: M,
  ...params: HostAdminParams<M> extends undefined ? [] : [HostAdminParams<M>]
): Promise<HostAdminResult<M>> {
  return link.request(method, params[0]) as Promise<HostAdminResult<M>>
}
