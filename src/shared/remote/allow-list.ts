// What a device may ask of the agent host: everything a window can, except what needs main. The
// remote host and the agent host both check it, so a remote host that misbehaves cannot widen it.

import type { HostMethod } from '../agent-host'

// A file main's media scheme serves. A device adds a project by typing its folder, which the agent
// host checks is one.
const MAIN_ONLY: ReadonlySet<string> = new Set<HostMethod>(['media.open'])

// Huli: the agents' network is this computer's to set up. Its subscriptions' addresses carry
// tokens, so a device never gets these, which carry their hosts and mihomo's messages or change
// the subscriptions. A device has `agentNetwork.deviceStatus` and `agentNetwork.deviceLatency`
// instead, which carry names, counts, choices and exits only.
const WINDOW_ONLY: ReadonlySet<string> = new Set<HostMethod>([
  'agentNetwork.status',
  'agentNetwork.addSubscription',
  'agentNetwork.importSubscription',
  'agentNetwork.reimportSubscription',
  'agentNetwork.renameSubscription',
  'agentNetwork.removeSubscription',
  'agentNetwork.refresh',
  'agentNetwork.nodes',
  'agentNetwork.testLatency',
  'agentNetwork.exitIp',
  'agentNetwork.interfaces',
  // Huli: every folder an agent ever ran in, with its sessions' titles; a device lists a folder's
  // only when it names one, and the import that uses this is in the desktop's Settings alone.
  'agentHistory.list',
  'agentHistory.planCopy',
  'agentHistory.copy',
  // Huli: what the host allows by itself without asking is set at the computer, never by a device.
  'projects.setAutoApprove',
  // Huli: so is a manager's roster, and whether its agent may answer its workers' requests.
  'projects.setManager',
  'manager.set',
  // Huli: what holds an agent back is set at the computer: a device could loosen it, or download
  // an image the user was not shown the size of.
  'projects.setSandbox',
  'sessions.setSandbox',
  'sandbox.containerStatus',
  'sandbox.pullImage',
  'sandbox.removeImage',
  // Huli: so is Moli's download for background web reading, whose size the window shows first.
  'webReader.status',
  'webReader.install',
  'webReader.cancel',
  'webReader.remove',
  // Huli: Agent sync rewrites the agents' own files, their instructions among them, from this
  // computer's window alone.
  'sync.read',
  'sync.preview',
  'sync.apply',
  'sync.saveSnippets',
])

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
 * Whether a device is refused this request: a host method that needs main or is the windows'
 * alone, or an attachment from a file main granted to a window. A method the host does not know is not this list's to refuse.
 */
export function forbiddenToDevices(method: string, params: unknown): boolean {
  if (MAIN_ONLY.has(method) || WINDOW_ONLY.has(method)) return true
  if (method === 'sessions.create' && managerAnswers(params)) return true
  // Huli: a device's session starts in the sandbox the computer's settings pick for its project.
  if ((method === 'sessions.create' || method === 'sessions.prepare') && namesSandbox(params)) {
    return true
  }
  return method === 'attachments.add' && hasGrant(params)
}

/** Huli: a manager session whose agent answers its workers' requests, which a device never starts. */
function managerAnswers(params: unknown): boolean {
  if (typeof params !== 'object' || params === null) return false
  const manager = (params as { manager?: unknown }).manager
  return (
    typeof manager === 'object' &&
    manager !== null &&
    (manager as { approvals?: unknown }).approvals !== 'user'
  )
}

function namesSandbox(params: unknown): boolean {
  return typeof params === 'object' && params !== null && 'sandbox' in params
}
