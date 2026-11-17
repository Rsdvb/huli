// What a device may ask of the agent host: everything a window can, except what needs main. The
// remote host and the agent host both check it, so a remote host that misbehaves cannot widen it.

import type { HostMethod } from '../agent-host'

// A file main's media scheme serves. A device adds a project by typing its folder, which the agent
// host checks is one.
const MAIN_ONLY: ReadonlySet<string> = new Set<HostMethod>(['media.open'])

function sourceHas(params: unknown, key: string): boolean {
  if (typeof params !== 'object' || params === null) return false
  const source = (params as { source?: unknown }).source
  return typeof source === 'object' && source !== null && key in source
}

function hasGrant(params: unknown): boolean {
  return sourceHas(params, 'grantId')
}

/**
 * Whether a device's request names a file of the upload folder itself, which only its remote host
 * does, in place of the upload the device sent; the remote host refuses it from a device.
 */
export function namesUploadFile(method: string, params: unknown): boolean {
  return method === 'attachments.add' && sourceHas(params, 'upload')
}

/**
 * Whether a device is refused this request: a host method that needs main, or an attachment from
 * a file main granted to a window. A method the host does not know is not this list's to refuse.
 */
export function forbiddenToDevices(method: string, params: unknown): boolean {
  if (MAIN_ONLY.has(method)) return true
  return method === 'attachments.add' && hasGrant(params)
}
